const fs = require('fs');
const path = require('path');
const { fetchDividends } = require('./bse-client');
const { saveDividendCache } = require('./dividend-cache');

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
      ...state,
      companies: state.companies && typeof state.companies === 'object' ? state.companies : {},
      last_checked: state.last_checked || null,
      health: state.health && typeof state.health === 'object' ? state.health : {}
    };
  } catch {
    return { companies: {}, last_checked: null, health: {} };
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

function cleanupExpired(state, today = startOfToday(), retentionDays = 90) {
  // Keep historical event keys for a while so a recovered source cannot
  // re-alert an event that was seen before a temporary outage.
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - retentionDays);
  let removed = 0;
  for (const [key, company] of Object.entries(state.companies)) {
    const recordDate = parseDate(company.record_date || company.RD_Date);
    if (recordDate && recordDate < cutoff) {
      delete state.companies[key];
      removed++;
    }
  }
  return removed;
}

function eventKey(company) {
  return [
    company.scrip_code || company.short_name,
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
  const source = 'BSE India';
  const heading = '📢 NEW BSE DIVIDEND';
  return [
    heading,
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
    `Source: ${source}`
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  const body = await response.text();
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}: ${body}`);

  const json = JSON.parse(body);
  if (!json.ok) throw new Error(`Telegram error: ${body}`);
  return json;
}

function canonicalPurpose(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('interim')) return 'interim';
  if (text.includes('final')) return 'final';
  if (text.includes('special')) return 'special';
  if (text.includes('dividend')) return 'dividend';
  return text.replace(/[^a-z0-9]/g, '').slice(0, 40);
}

function equivalentEventKey(state, company) {
  const symbol = String(company.short_name || '').trim().toLowerCase();
  const recordDate = formatDate(company.RD_Date).toLowerCase();
  const amount = company.dividend_per_share === null || company.dividend_per_share === undefined
    ? null : Number(company.dividend_per_share);
  const kind = canonicalPurpose(company.Purpose);
  if (!symbol || !recordDate) return null;
  for (const [key, saved] of Object.entries(state.companies || {})) {
    const savedSymbol = String(saved.short_name || '').trim().toLowerCase();
    const savedDate = String(saved.record_date || saved.RD_Date || '').trim().toLowerCase();
    const savedAmount = saved.dividend_per_share === null || saved.dividend_per_share === undefined
      ? null : Number(saved.dividend_per_share);
    const savedKind = canonicalPurpose(saved.purpose || saved.Purpose);
    if (symbol === savedSymbol && recordDate === savedDate && kind === savedKind &&
        (amount === null || savedAmount === null || Math.abs(amount - savedAmount) < 0.0001)) return key;
  }
  return null;
}

function storeCompany(state, key, company, checkedAt) {
  state.companies[key] = {
    scrip_code: company.scrip_code,
    short_name: company.short_name,
    long_name: company.long_name,
    record_date: formatDate(company.RD_Date),
    purpose: company.Purpose,
    dividend_per_share: company.dividend_per_share,
    latest_price: company.latest_price,
    dividend_yield: company.dividend_yield,
    data_source: company.data_source || 'BSE',
    first_seen: state.companies[key]?.first_seen || checkedAt
  };
}

async function sendOutageAlert(state, checkedAt, error) {
  state.health = {
    ...(state.health || {}),
    outage_active: true,
    outage_started_at: state.health?.outage_started_at || checkedAt,
    last_error: String(error?.message || error).slice(0, 500)
  };
  saveState(state);
  if (state.health.outage_alert_sent_at) return;
  const message = [
    '⚠️ BSE DIVIDEND MONITOR OUTAGE',
    '',
    'BSE is unavailable or returned invalid data.',
    `⏰ Checked: ${checkedAt}`,
    `❗ Error: ${String(error?.message || error).replace(/\s+/g, ' ').slice(0, 500)}`,
    '',
    'Previous dividend state and UI cache were preserved. The monitor will retry on the next scheduled run.'
  ].join('\n');
  try {
    await sendTelegram(message);
    state.health.outage_alert_sent_at = checkedAt;
    saveState(state);
  } catch (telegramError) {
    console.error(`Could not send outage alert to Telegram: ${telegramError.message}`);
  }
}

async function checkDividends(options = {}) {
  const now = options.now || new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const fetchFrom = new Date(today);
  fetchFrom.setDate(fetchFrom.getDate() - 30); // minimum safety lookback
  const end = new Date(today);
  end.setDate(end.getDate() + 60);
  const pad = n => String(n).padStart(2, '0');
  const apiDate = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const checkedAt = `${formatDate(apiDate(now))} ${now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  const state = loadState();
  const hadPreviousCheck = Boolean(state.last_checked);
  // On recovery, fetch from the last successful check if the outage lasted
  // longer than the normal 30-day safety window, avoiding a fixed lookback gap.
  const lastCheckedDate = parseDate(state.last_checked);
  if (lastCheckedDate && lastCheckedDate < fetchFrom) {
    fetchFrom.setTime(lastCheckedDate.getTime());
    fetchFrom.setHours(0, 0, 0, 0);
  }

  let rows;
  try {
    const fetcher = options.fetchDividends || fetchDividends;
    rows = await fetcher(apiDate(fetchFrom), apiDate(end));
  } catch (error) {
    await sendOutageAlert(state, checkedAt, error);
    // A non-zero workflow result makes the failed data collection visible.
    // Crucially, neither the last good cache nor announcement keys are changed.
    throw error;
  }

  const source = rows.source || rows.find(row => row.data_source)?.data_source || 'BSE';
  // Keep the last known good UI cache if the provider returns an empty list.
  // Empty-but-valid data should not erase the previous snapshot during an incident.
  if (rows.length > 0) {
    saveDividendCache({
      fetched_at: checkedAt,
      source,
      from_date: apiDate(today),
      to_date: apiDate(end),
      data: rows
    });
  }

  const backfillCutoff = new Date(fetchFrom);
  backfillCutoff.setHours(0, 0, 0, 0);
  const activeRows = rows.filter(row => {
    const d = parseDate(row.RD_Date);
    return !d || d >= backfillCutoff;
  });
  let newAlerts = 0;
  const newCompanies = [];

  for (const company of activeRows) {
    const key = eventKey(company);
    if ((!company.scrip_code && !company.short_name) || !key) continue;
    const existingKey = state.companies[key] ? key : equivalentEventKey(state, company);
    const recordDate = parseDate(company.RD_Date);
    const isPastEvent = recordDate && recordDate < today;

    if (existingKey) {
      if (existingKey !== key) delete state.companies[existingKey];
      storeCompany(state, key, company, checkedAt);
      saveState(state);
      continue;
    }

    // On the very first run, record recent past events as a baseline rather
    // than sending a burst of historical alerts. Later runs backfill them.
    if (!hadPreviousCheck && isPastEvent) {
      storeCompany(state, key, company, checkedAt);
      saveState(state);
      continue;
    }

    // Persist each successful alert immediately so a later failure in this
    // run cannot cause the already-sent messages to repeat on the next run.
    await sendTelegram(buildTelegramMessage(company, checkedAt));
    storeCompany(state, key, company, checkedAt);
    saveState(state);
    newAlerts++;
    newCompanies.push(company.scrip_code);
  }

  // Prune old event keys only after matching the recovery batch, so a long
  // outage cannot erase dedupe keys before missed announcements are compared.
  const removed = cleanupExpired(state, today, 90);
  const wasOutage = Boolean(state.health?.outage_active);
  if (wasOutage) {
    const recoveryMessage = [
      '✅ BSE DIVIDEND MONITOR RECOVERED',
      '',
      `📡 Working source: ${source}`,
      `📊 Valid records fetched: ${rows.length}`,
      `⏰ Recovered at: ${checkedAt}`,
      `🕒 Outage started: ${state.health.outage_started_at || '-'}`,
      'Missed announcements were checked since the last successful run, with a 30-day safety lookback.'
    ].join('\n');
    try {
      await sendTelegram(recoveryMessage);
      state.health = { ...state.health, outage_active: false, recovered_at: checkedAt, last_success_at: checkedAt, last_error: null, outage_alert_sent_at: null, outage_started_at: null };
    } catch (error) {
      // Keep outage_active until the recovery notification is delivered; next
      // run retries the recovery notice without duplicating dividend alerts.
      state.health = { ...state.health, last_success_at: checkedAt, recovery_notification_error: error.message };
      saveState(state);
      throw error;
    }
  } else {
    state.health = { ...(state.health || {}), outage_active: false, last_success_at: checkedAt, last_error: null };
  }

  state.last_checked = checkedAt;
  saveState(state);
  return {
    checked_at: checkedAt,
    from_date: apiDate(today),
    backfill_from_date: apiDate(fetchFrom),
    to_date: apiDate(end),
    source,
    fetched: rows.length,
    active: activeRows.length,
    removed,
    new_alerts: newAlerts,
    new_companies: newCompanies,
    state_file: STATE_FILE
  };
}

module.exports = {
  loadState,
  saveState,
  parseDate,
  cleanupExpired,
  eventKey,
  equivalentEventKey,
  buildTelegramMessage,
  checkDividends,
  sendTelegram
};
