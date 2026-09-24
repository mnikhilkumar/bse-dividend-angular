const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
  process.env.BSE_MOCK = '1';
  process.env.TELEGRAM_MOCK = '1';
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bse-dividend-e2e-'));
  process.env.DIVIDEND_STATE_FILE = path.join(tempRoot, 'dividend-state.json');
  process.env.DIVIDEND_CACHE_FILE = path.join(tempRoot, 'latest-dividends.json');

  const bseClient = require('./bse-client');
  const monitor = require('./dividend-monitor');
  const cache = require('./dividend-cache');
  const http = require('http');
  const server = require('./server');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  function get(pathname) {
    return new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}${pathname}`, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }).on('error', reject);
    });
  }

  try {
    const health = await get('/api/health');
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { ok: true });
    console.log('PASS: /api/health');

    const invalid = await get('/api/dividends?Fdate=bad&TDate=bad');
    assert.equal(invalid.status, 400);
    console.log('PASS: /api/dividends date validation');

    // First prove the existing live BSE/mock path works locally.
    const live = await get('/api/dividends?Fdate=20260923&TDate=20261122');
    assert.equal(live.status, 200);
    const liveRows = JSON.parse(live.body);
    assert.equal(liveRows.length, 2);
    const igl = liveRows.find(x => x.scrip_code === '532514');
    assert(igl);
    assert.equal(igl.latest_price, 149.40);
    assert.equal(igl.dividend_per_share, 1.5);
    assert.equal(igl.dividend_yield, 1.0);
    assert(!Object.prototype.hasOwnProperty.call(igl, 'Ex_date'));
    console.log('PASS: live/mock dividend API');
    console.log('PASS: dividend/share extraction');
    console.log('PASS: latest price lookup in mock mode');
    console.log('PASS: dividend yield calculation');
    console.log('PASS: Ex-Date removed from API payload');
    const exactUrl = bseClient.buildBseUrl(new URLSearchParams({ Fdate: '20260924', TDate: '20261103' }));
    assert.equal(exactUrl, 'https://api.bseindia.com/BseIndiaAPI/api/DefaultData/w?scripcode=&Fdate=20260924&Purposecode=P9&TDate=20261103&ddlcategorys=E&ddlindustrys=&segment=0&strSearch=S');
    console.log('PASS: exact BSE endpoint uses strSearch=S');

    const originalFetch = global.fetch;
    let capturedUrl = null;
    global.fetch = async (url) => {
      capturedUrl = String(url);
      return {
        ok: true,
        status: 200,
        url: capturedUrl,
        text: async () => JSON.stringify([{ scrip_code: '532514', short_name: 'IGL', long_name: 'Indraprastha Gas Ltd', Purpose: 'Final Dividend - Rs. - 1.5000', RD_Date: '01 Oct 2026' }])
      };
    };
    try {
      delete process.env.BSE_MOCK;
      await bseClient.fetchBse(new URLSearchParams({ Fdate: '20260924', TDate: '20261103' }));
      assert.equal(capturedUrl, exactUrl);
      console.log('PASS: live BSE fetch constructs the exact requested URL');
    } finally {
      global.fetch = originalFetch;
    }

    // Run the same 30-minute monitor flow and confirm it writes the UI cache.
    process.env.BSE_MOCK = '1';
    const monitorResult = await monitor.checkDividends({ now: new Date(2026, 8, 23, 16, 5, 0) });
    assert.equal(monitorResult.fetched, 2);
    assert(fs.existsSync(process.env.DIVIDEND_CACHE_FILE));
    const saved = cache.loadDividendCache();
    assert(saved && Array.isArray(saved.data));
    assert.equal(saved.data.length, 2);
    console.log('PASS: 30-minute monitor writes latest-dividends cache');

    // Clear BSE mock so the API cannot live-fetch; it must serve the cache.
    delete process.env.BSE_MOCK;
    const cached = await get('/api/dividends?Fdate=20260923&TDate=20261122');
    assert.equal(cached.status, 200);
    const cachedRows = JSON.parse(cached.body);
    assert.equal(cachedRows.length, 1); // only the active record-date row
    assert.equal(cachedRows[0].scrip_code, '532514');
    console.log('PASS: Vercel-style API serves cached BSE snapshot without BSE access');

    const state = { companies: {
      old: { record_date: '18-Sep-2026' },
      current: { record_date: '21-Sep-2026' }
    }, last_checked: null };
    fs.writeFileSync(process.env.DIVIDEND_STATE_FILE, JSON.stringify(state));
    const loaded = monitor.loadState();
    const removed = monitor.cleanupExpired(loaded, new Date(2026, 8, 19));
    assert.equal(removed, 1);
    assert(!loaded.companies.old);
    assert(loaded.companies.current);
    console.log('PASS: expired dividend records are removed');

    const message = monitor.buildTelegramMessage({
      long_name: 'CESC Ltd', short_name: 'CESC', scrip_code: '513262',
      RD_Date: '21-Sep-2026', dividend_per_share: 10.5,
      latest_price: 172.35, dividend_yield: 6.09,
      Purpose: 'Final Dividend - Rs. - 10.5000'
    }, '19-Sep-2026 11:30:00 PM');
    assert(message.includes('CESC Ltd'));
    assert(message.includes('₹10.50'));
    assert(message.includes('₹172.35'));
    assert(message.includes('6.09%'));
    assert(!message.includes('AGM Approval'));
    console.log('PASS: Telegram message contains dividend values only');

    console.log('ALL LOCAL E2E TESTS PASSED');
  } finally {
    server.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
