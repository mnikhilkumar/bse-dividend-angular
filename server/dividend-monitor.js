const fs = require('fs');
const path = require('path');
const { fetchDividends } = require('./bse-client');

const STATE_FILE = path.resolve(process.env.DIVIDEND_STATE_FILE || path.join(__dirname, '..', 'data', 'dividend-state.json'));

function ensureStateFile() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ companies: {}, last_checked: null }, null, 2) + '\n');
  }
}

function loadState() {
  ensureStateFile();
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      companies: state.companies && typeof state.companies === 'object' ? state.companies : {},
      last_checked: state.last_checked || null
    };
  } catch {
    return { companies: {}, last_checked: null };
  }
}

function saveState(state) {
  ensureStateFile();
  const temp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(temp, STATE_FILE);
}

function parseDate(value) {
  const text = String(value || '').trim();
  let match = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));

  match = text.match(/^(\d{1,2})[\s\/-]+([A-Za-z]{3,9}|\d{1,2})[\s\/-]+(\d{4})/);
  if (!match) return null;

  const monthText = match[2];
  const month = /^\d+$/.test(monthText)
    ? Number(monthText)
    : ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(monthText.slice(0, 3).toLowerCase()) + 1;

  if (month < 1 || month > 12) return null;
  return new Date(Number(match[3]), month - 1, Number(match[1]));
}

function startOfToday() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function cleanupExpired(state, today = startOfToday()) {
  let removed = 0;

  for (const [key, company] of Object.entries(state.companies)) {
    const recordDate = parseDate(company.record_date || company.RD_Date);
    if (recordDate && recordDate < today) {
      delete state.companies[key];
      removed++;
    }
  }

  return removed;
}

function eventKey(company) {
  return [
    company.scrip_code,
    company.RD_Date,
    company.Purpose
  ].map(v => String(v || '').trim()).join('|');
}

function formatDate(value) {
  const d = parseDate(value);
  if (!d) return value || '-';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${String(d.getDate()).padStart(2, '0')}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

function money(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '-';
  return `₹${Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function yieldText(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '-';
  return `${Number(value).toFixed(2)}%`;
}

function buildTelegramMessage(company, checkedAt) {
  return [
    '📢 NEW BSE DIVIDEND',
    '',
    `🏢 ${company.long_name || '-'}`,
    `🔹 Symbol: ${company.short_name || '-'}`,
    `🔢 BSE Code: ${company.scrip_code || '-'}`,
    '',
    `📅 Record Date: ${formatDate(company.RD_Date)}`,
    '',
    `💰 Dividend / Share: ${money(company.dividend_per_share)}`,
    `💵 Latest Price: ${money(company.latest_price)}`,
    `📊 Dividend Yield: ${yieldText(company.dividend_yield)}`,
    '',
    `📌 Purpose: ${company.Purpose || '-'}`,
    '',
    `⏰ Checked: ${checkedAt}`,
    'Source: BSE India'
  ].join('\n');
}

async function sendTelegram(text) {
  if (process.env.TELEGRAM_MOCK === '1') {
    console.log('\n--- TELEGRAM MOCK ---\n' + text + '\n--- END TELEGRAM MOCK ---\n');
    return { ok: true, mock: true };
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required.');
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true
    })
  });

  const body = await response.text();
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}: ${body}`);

  const json = JSON.parse(body);
  if (!json.ok) throw new Error(`Telegram error: ${body}`);
  return json;
}

async function checkDividends(options = {}) {
  const now = options.now || new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(today);
  end.setDate(end.getDate() + 60);

  const pad = n => String(n).padStart(2, '0');
  const apiDate = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const checkedAt = `${formatDate(apiDate(now))} ${now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;

  const state = loadState();
  const removed = cleanupExpired(state, today);

  const rows = await fetchDividends(apiDate(today), apiDate(end));
  const activeRows = rows.filter(row => {
    const d = parseDate(row.RD_Date);
    return !d || d >= today;
  });

  let newAlerts = 0;
  const newCompanies = [];

  for (const company of activeRows) {
    const key = eventKey(company);
    if (!company.scrip_code || !key) continue;

    if (!state.companies[key]) {
      const message = buildTelegramMessage(company, checkedAt);
      await sendTelegram(message);

      state.companies[key] = {
        scrip_code: company.scrip_code,
        short_name: company.short_name,
        long_name: company.long_name,
        record_date: formatDate(company.RD_Date),
        purpose: company.Purpose,
        dividend_per_share: company.dividend_per_share,
        latest_price: company.latest_price,
        dividend_yield: company.dividend_yield,
        first_seen: checkedAt
      };

      newAlerts++;
      newCompanies.push(company);
    } else {
      // Refresh the stored values without sending another Telegram alert.
      state.companies[key] = {
        ...state.companies[key],
        latest_price: company.latest_price,
        dividend_yield: company.dividend_yield
      };
    }
  }

  state.last_checked = checkedAt;
  saveState(state);

  return {
    checked_at: checkedAt,
    from_date: apiDate(today),
    to_date: apiDate(end),
    fetched: rows.length,
    active: activeRows.length,
    removed,
    new_alerts: newAlerts,
    new_companies: newCompanies.map(x => x.scrip_code),
    state_file: STATE_FILE
  };
}

module.exports = {
  loadState,
  saveState,
  parseDate,
  cleanupExpired,
  eventKey,
  buildTelegramMessage,
  checkDividends
};
