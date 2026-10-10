const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.resolve(
  process.env.DIVIDEND_CACHE_FILE || path.join(__dirname, '..', 'data', 'latest-dividends.json')
);

function ensureCacheDir() {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
}

function saveDividendCache(payload) {
  ensureCacheDir();
  const temp = `${CACHE_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(payload, null, 2) + '\n');
  fs.renameSync(temp, CACHE_FILE);
}

function loadDividendCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function parseApiDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{8}$/.test(text)) return null;
  const d = new Date(Number(text.slice(0, 4)), Number(text.slice(4, 6)) - 1, Number(text.slice(6, 8)));
  return Number.isNaN(d.getTime()) ? null : d;
}

function filterRows(rows, from, to) {
  const fromDate = parseApiDate(from);
  const toDate = parseApiDate(to);
  if (!fromDate || !toDate) return [];

  return (Array.isArray(rows) ? rows : []).filter(row => {
    const text = String(row?.RD_Date || '').trim();
    let d = parseApiDate(text);
    if (!d) {
      const match = text.match(/^(\d{1,2})[\s\/-]+([A-Za-z]{3,9}|\d{1,2})[\s\/-]+(\d{4})/);
      if (match) {
        const month = /^\d+$/.test(match[2])
          ? Number(match[2])
          : ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(match[2].slice(0,3).toLowerCase()) + 1;
        d = new Date(Number(match[3]), month - 1, Number(match[1]));
      }
    }
    return d && d >= fromDate && d <= toDate;
  });
}

module.exports = { CACHE_FILE, saveDividendCache, loadDividendCache, filterRows };
