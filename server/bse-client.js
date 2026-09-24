const { URL } = require('url');

const BSE_URL = 'https://api.bseindia.com/BseIndiaAPI/api/DefaultData/w';
const BSE_QUOTE_URL = 'https://api.bseindia.com/BseIndiaAPI/api/getScripHeaderData/w';
const quoteCache = new Map();
const QUOTE_CACHE_MS = 5 * 60 * 1000;

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function norm(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function pick(obj, names) {
  for (const name of names) {
    if (obj[name] !== undefined && clean(obj[name]) !== '') return clean(obj[name]);
  }
  return '';
}

function extractDividendPerShare(purpose, item) {
  const direct = [
    item?.dividendpershare,
    item?.dividendamount,
    item?.dividend
  ].find(v => v !== undefined && v !== null && clean(v) !== '');

  if (direct !== undefined) {
    const n = Number(String(direct).replace(/,/g, '').trim());
    if (Number.isFinite(n) && n >= 0) return n;
  }

  const match = clean(purpose).match(/rs\.?\s*[-:]?\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (!match) return null;

  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

function normalize(item) {
  const x = {};
  for (const [k, v] of Object.entries(item || {})) x[norm(k)] = v;

  const purpose = pick(x, ['purpose']);

  return {
    scrip_code: pick(x, ['scripcode', 'securitycode', 'code']),
    short_name: pick(x, ['shortname', 'symbol']),
    long_name: pick(x, ['longname', 'companyname']),
    RD_Date: pick(x, ['rddate', 'recorddate']),
    Purpose: purpose,
    BCRD_FROM: pick(x, ['bcrdfrom']),
    BCRD_TO: pick(x, ['bcrdto']),
    ND_START_DATE: pick(x, ['ndstartdate']),
    ND_END_DATE: pick(x, ['ndenddate']),
    payment_date: pick(x, ['paymentdate']),
    latest_price: null,
    dividend_per_share: extractDividendPerShare(purpose, x),
    dividend_yield: null
  };
}

function fromJson(text) {
  try {
    const json = JSON.parse(text);
    const candidates = [json, json?.Table, json?.Table1, json?.data, json?.Data, json?.results, json?.Result];
    const arr = candidates.find(v => Array.isArray(v));
    if (!arr) return [];
    return arr.map(normalize).filter(x => /^\d{6}$/.test(x.scrip_code));
  } catch {
    return [];
  }
}

function stripTags(value) {
  return clean(String(value)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'"));
}

function fromHtml(html) {
  const results = [];
  const tableMatches = html.match(/<table\b[\s\S]*?<\/table>/gi) || [];

  for (const tableHtml of tableMatches) {
    const rowMatches = tableHtml.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
    if (rowMatches.length < 2) continue;

    let headerIndex = -1;
    let headers = [];

    for (let i = 0; i < rowMatches.length; i++) {
      const cells = rowMatches[i].match(/<(?:th|td)\b[^>]*>[\s\S]*?<\/(?:th|td)>/gi) || [];
      const hs = cells.map(stripTags).map(norm);
      const hasCode = hs.some(h => h.includes('scrip') || h.includes('security') || h === 'code');
      const hasEx = hs.some(h => h.includes('exdate'));
      if (hasCode && hasEx) {
        headerIndex = i;
        headers = hs;
        break;
      }
    }

    if (headerIndex < 0) continue;

    for (let i = headerIndex + 1; i < rowMatches.length; i++) {
      const cells = rowMatches[i].match(/<(?:td|th)\b[^>]*>[\s\S]*?<\/(?:td|th)>/gi) || [];
      if (!cells.length) continue;
      const values = cells.map(stripTags);
      const obj = {};
      headers.forEach((h, index) => { obj[h] = values[index] || ''; });
      const item = normalize(obj);
      if (/^\d{6}$/.test(item.scrip_code)) results.push(item);
    }

    if (results.length) return results;
  }

  return results;
}

function findPriceDeep(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPriceDeep(item);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;

  const preferredKeys = ['ltp', 'lastprice', 'lasttradedprice', 'currentprice', 'currate', 'currentrate', 'marketprice', 'closeprice'];

  for (const key of preferredKeys) {
    for (const actual of Object.keys(value)) {
      if (norm(actual) === norm(key)) {
        const n = Number(String(value[actual]).replace(/,/g, '').replace(/₹/g, '').trim());
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
  }

  for (const child of Object.values(value)) {
    const found = findPriceDeep(child);
    if (found !== null) return found;
  }

  return null;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBseQuote(scripcode) {
  const target = new URL(BSE_QUOTE_URL);
  target.searchParams.set('scripcode', String(scripcode));
  target.searchParams.set('Debtflag', '');
  target.searchParams.set('seriesid', '');

  const response = await fetchWithTimeout(target, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://www.bseindia.com/',
      'Origin': 'https://www.bseindia.com'
    }
  });

  const text = await response.text();
  if (!response.ok) return null;

  try {
    const json = JSON.parse(text);
    const price = findPriceDeep(json);
    if (price !== null) return price;
  } catch {}

  const textMatch = text.match(/(?:LTP|Last\s*Price|Last\s*Traded\s*Price|Current\s*Rate)[^0-9]{0,50}([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)/i);
  if (textMatch) {
    const price = Number(textMatch[1].replace(/,/g, ''));
    if (Number.isFinite(price) && price > 0) return price;
  }

  return null;
}

async function fetchYahooQuote(symbol) {
  const cleanSymbol = clean(symbol).replace(/[^A-Za-z0-9&.-]/g, '');
  if (!cleanSymbol) return null;

  for (const ticker of [`${cleanSymbol}.BO`, `${cleanSymbol}.NS`]) {
    try {
      const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1d`;
      const response = await fetchWithTimeout(target, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json,text/plain,*/*' }
      }, 8000);
      if (!response.ok) continue;
      const json = await response.json();
      const meta = json?.chart?.result?.[0]?.meta;
      const price = Number(meta?.regularMarketPrice ?? meta?.previousClose);
      if (Number.isFinite(price) && price > 0) return price;
    } catch {}
  }

  return null;
}

function calculateYield(dividend, price) {
  const d = Number(dividend);
  const p = Number(price);
  if (!Number.isFinite(d) || !Number.isFinite(p) || p <= 0 || d < 0) return null;
  return Number(((d / p) * 100).toFixed(2));
}

async function fetchQuote(scripcode, symbol) {
  const code = String(scripcode);
  if (!/^\d{6}$/.test(code)) return null;

  const cached = quoteCache.get(code);
  if (cached && Date.now() - cached.time < QUOTE_CACHE_MS) return cached.price;

  if (process.env.BSE_MOCK === '1') {
    const mockPrices = {
      '532514': 149.40, '520123': 142.50, '544281': 58.30,
      '531147': 724.60, '531847': 148.20, '500490': 11245.00,
      '541143': 1740.30, '513262': 172.35, '532524': 156.20
    };
    const price = mockPrices[code] ?? 100.00;
    quoteCache.set(code, { time: Date.now(), price });
    return price;
  }

  let price = null;
  for (let attempt = 1; attempt <= 2 && price === null; attempt++) {
    try {
      price = await fetchBseQuote(code);
    } catch (error) {
      if (attempt === 2) console.warn(`BSE price lookup failed for ${code}: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 250 * attempt));
    }
  }

  if (price === null) price = await fetchYahooQuote(symbol);

  if (price !== null) quoteCache.set(code, { time: Date.now(), price });
  else console.warn(`Price unavailable for ${code} (${symbol || 'no symbol'})`);

  return price;
}

async function addLatestPrices(rows) {
  const unique = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row.scrip_code || seen.has(row.scrip_code)) continue;
    seen.add(row.scrip_code);
    unique.push({ code: row.scrip_code, symbol: row.short_name });
  }

  const concurrency = 3;
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= unique.length) return;
      const item = unique[index];
      const price = await fetchQuote(item.code, item.symbol);
      for (const row of rows) {
        if (row.scrip_code === item.code) {
          row.latest_price = price;
          row.dividend_yield = calculateYield(row.dividend_per_share, price);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, worker));
  return rows;
}

function isHtmlResponse(text) {
  const value = String(text || '').trim().toLowerCase();
  return value.startsWith('<!doctype html') || value.startsWith('<html') || value.includes('page moved') || value.includes('request rejected');
}

function buildBseUrl(searchParams) {
  const target = new URL(BSE_URL);
  // Keep the parameter order identical to the requested BSE URL.
  target.searchParams.set('scripcode', '');
  target.searchParams.set('Fdate', searchParams.get('Fdate') || '');
  target.searchParams.set('Purposecode', searchParams.get('Purposecode') || 'P9');
  target.searchParams.set('TDate', searchParams.get('TDate') || '');
  target.searchParams.set('ddlcategorys', searchParams.get('ddlcategorys') || 'E');
  target.searchParams.set('ddlindustrys', searchParams.get('ddlindustrys') || '');
  target.searchParams.set('segment', searchParams.get('segment') || '0');
  // This is the exact BSE endpoint requested for the Vercel/live API path.
  target.searchParams.set('strSearch', 'S');
  return target.toString();
}

async function fetchBse(searchParams) {
  if (process.env.BSE_MOCK === '1') {
    return {
      status: 200,
      url: 'mock://bse',
      text: JSON.stringify([
        { scrip_code: '532514', short_name: 'IGL', long_name: 'Indraprastha Gas Ltd', Ex_date: '01 Oct 2026', Purpose: 'Final Dividend - Rs. - 1.5000', RD_Date: '01 Oct 2026', payment_date: '' },
        { scrip_code: '520123', short_name: 'ABCINDQ', long_name: 'ABC India Ltd', Ex_date: '21 Sep 2026', Purpose: 'Final Dividend - Rs. - 0.5000', RD_Date: '21 Sep 2026', payment_date: '' }
      ])
    };
  }

  const targetUrl = buildBseUrl(searchParams);
  try {
    const response = await fetchWithTimeout(targetUrl, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.bseindia.com/',
        'Origin': 'https://www.bseindia.com'
      }
    }, 20000);

    const text = await response.text();
    const parsed = fromJson(text);

    if (response.ok && !isHtmlResponse(text) && parsed.length > 0) {
      console.log(`BSE dividend fetch succeeded with strSearch=S: ${parsed.length} rows`);
      return { status: response.status, url: response.url || targetUrl, text };
    }

    if (response.ok && !isHtmlResponse(text) && text.trim()) {
      try {
        const json = JSON.parse(text);
        const isArrayResponse = Array.isArray(json) || Array.isArray(json?.Table) || Array.isArray(json?.Table1) || Array.isArray(json?.data) || Array.isArray(json?.Data) || Array.isArray(json?.results) || Array.isArray(json?.Result);
        if (isArrayResponse) {
          console.log('BSE dividend fetch returned 0 rows with strSearch=S');
          return { status: response.status, url: response.url || targetUrl, text };
        }
      } catch {}
    }

    throw new Error(`BSE returned unusable response with strSearch=S, HTTP ${response.status}, ${text.slice(0, 180)}`);
  } catch (error) {
    console.warn(`BSE dividend fetch failed with strSearch=S: ${error.message}`);
    throw error;
  }
}

async function fetchDividends(from, to) {
  const searchParams = new URLSearchParams({ Fdate: from, TDate: to });
  const result = await fetchBse(searchParams);
  let data = fromJson(result.text);
  if (!data.length) data = fromHtml(result.text);
  await addLatestPrices(data);
  return data;
}

module.exports = {
  fetchDividends,
  calculateYield,
  extractDividendPerShare,
  normalize,
  buildBseUrl,
  fetchBse
};
