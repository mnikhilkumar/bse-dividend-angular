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

    // Prove the mocked BSE path and normalizers work locally.
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
    console.log('PASS: mocked dividend API');
    console.log('PASS: dividend/share extraction');
    console.log('PASS: latest price lookup in mock mode');
    console.log('PASS: dividend yield calculation');
    console.log('PASS: Ex-Date removed from API payload');
    const exactUrl = bseClient.buildBseUrl(new URLSearchParams({ Fdate: '20260924', TDate: '20261103' }));
    assert.equal(exactUrl, 'https://api.bseindia.com/BseIndiaAPI/api/DefaultData/w?scripcode=&Fdate=20260924&Purposecode=P9&TDate=20261103&ddlcategorys=E&ddlindustrys=&segment=0&strSearch=S');
    console.log('PASS: exact BSE endpoint uses strSearch=S');

    const forwardedUrl = bseClient.buildBseUrl(new URLSearchParams({
      Fdate: '20260924',
      Purposecode: 'P9',
      TDate: '20261123',
      ddlcategorys: 'E',
      ddlindustrys: '',
      segment: '0'
    }));
    assert.equal(
      forwardedUrl,
      'https://api.bseindia.com/BseIndiaAPI/api/DefaultData/w?scripcode=&Fdate=20260924&Purposecode=P9&TDate=20261123&ddlcategorys=E&ddlindustrys=&segment=0&strSearch=S'
    );
    console.log('PASS: Vercel query parameters forward to exact BSE S endpoint');

    const originalFetch = global.fetch;
    let capturedUrl = null;
    let capturedApiOptions = null;
    global.fetch = async (url, options = {}) => {
      const requestedUrl = String(url);
      if (requestedUrl === 'https://www.bseindia.com/') {
        return {
          ok: true, status: 200, url: requestedUrl,
          headers: { getSetCookie: () => ['bse-session=test-cookie; Path=/; Secure'] },
          text: async () => '<html>mock BSE home</html>'
        };
      }
      capturedUrl = requestedUrl;
      capturedApiOptions = options;
      return {
        ok: true,
        status: 200,
        url: capturedUrl,
        headers: { get: () => null },
        text: async () => JSON.stringify([{ scrip_code: '532514', short_name: 'IGL', long_name: 'Indraprastha Gas Ltd', Purpose: 'Final Dividend - Rs. - 1.5000', RD_Date: '01 Oct 2026' }])
      };
    };
    try {
      delete process.env.BSE_MOCK;
      await bseClient.fetchBse(new URLSearchParams({ Fdate: '20260924', TDate: '20261103' }));
      assert.equal(capturedUrl, exactUrl);
      assert(String(capturedApiOptions.headers.Cookie || '').includes('bse-session=test-cookie'));
      console.log('PASS: mocked BSE fetch constructs exact URL and forwards session cookies');
    } finally {
      global.fetch = originalFetch;
    }

    // BSE-only policy: a 403 must fail after the BSE request path and must
    // never call an alternate exchange endpoint. This is a mock network test, not live access.
    const originalFetchForBlockedBse = global.fetch;
    const blockedCalls = [];
    global.fetch = async (url) => {
      const requestedUrl = String(url);
      blockedCalls.push(requestedUrl);
      const headers = { getSetCookie: () => [], get: () => null };
      if (requestedUrl === 'https://www.bseindia.com/') {
        return { ok: true, status: 200, url: requestedUrl, headers, text: async () => '<html>mock BSE home</html>' };
      }
      if (requestedUrl.includes('api.bseindia.com/')) {
        return { ok: false, status: 403, url: requestedUrl, headers, text: async () => '<html><title>Access Denied</title></html>' };
      }
      throw new Error(`Unexpected non-BSE source request: ${requestedUrl}`);
    };
    try {
      delete process.env.BSE_MOCK;
      await assert.rejects(
        bseClient.fetchDividends('20261010', '20261209'),
        /BSE HTTP 403|BSE dividend fetch/
      );
      assert(blockedCalls.some(url => url.includes('api.bseindia.com/')));
      assert(blockedCalls.every(url => url === 'https://www.bseindia.com/' || url.includes('api.bseindia.com/')));
      console.log('PASS: BSE 403 is reported without querying any alternate source');
    } finally {
      global.fetch = originalFetchForBlockedBse;
      process.env.BSE_MOCK = '1';
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

    // Clear BSE mock and simulate both official sources denying access; the
    // API must serve the last-good snapshot without waiting on real networks.
    delete process.env.BSE_MOCK;
    const originalFetchForCache = global.fetch;
    global.fetch = async url => {
      const requestedUrl = String(url);
      const headers = { getSetCookie: () => [], get: () => null };
      if (requestedUrl === 'https://www.bseindia.com/') {
        return { ok: true, status: 200, url: requestedUrl, headers, text: async () => '<html>mock landing</html>' };
      }
      if (requestedUrl.includes('api.bseindia.com/')) {
        return { ok: false, status: 403, url: requestedUrl, headers, text: async () => '<html><title>Access Denied</title></html>' };
      }
      throw new Error(`Unexpected cache test URL: ${requestedUrl}`);
    };
    let cached;
    try {
      cached = await get('/api/dividends?Fdate=20260923&TDate=20261122');
    } finally {
      global.fetch = originalFetchForCache;
    }
    assert.equal(cached.status, 200);
    const cachedRows = JSON.parse(cached.body);
    assert.equal(cachedRows.length, 1); // only the active record-date row
    assert.equal(cachedRows[0].scrip_code, '532514');
    console.log('PASS: API serves cached snapshot when BSE is blocked');

    const state = { companies: {
      old: { record_date: '18-Sep-2026' },
      current: { record_date: '21-Sep-2026' }
    }, last_checked: null };
    fs.writeFileSync(process.env.DIVIDEND_STATE_FILE, JSON.stringify(state));
    const loaded = monitor.loadState();
    const removed = monitor.cleanupExpired(loaded, new Date(2026, 8, 19), 0);
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

    // Simulate a complete provider outage and recovery. Seed an existing event
    // because the earlier cleanup test intentionally replaced the temp state.
    const priorEvent = {
      scrip_code: '532514', short_name: 'IGL', long_name: 'Indraprastha Gas Ltd',
      RD_Date: '01 Oct 2026', Purpose: 'Final Dividend - Rs. - 1.5000',
      dividend_per_share: 1.5, latest_price: 149.4, dividend_yield: 1.0
    };
    const priorKey = monitor.eventKey(priorEvent);
    fs.writeFileSync(process.env.DIVIDEND_STATE_FILE, JSON.stringify({
      companies: { [priorKey]: { scrip_code: '532514', short_name: 'IGL', long_name: 'Indraprastha Gas Ltd', record_date: '01-Oct-2026', purpose: priorEvent.Purpose, dividend_per_share: 1.5, latest_price: 149.4, dividend_yield: 1.0, first_seen: '23-Sep-2026 16:05:00' } },
      last_checked: '23-Sep-2026 16:05:00', health: {}
    }, null, 2));
    const cacheBeforeOutage = fs.readFileSync(process.env.DIVIDEND_CACHE_FILE, 'utf8');
    await assert.rejects(
      monitor.checkDividends({ now: new Date(2026, 8, 24, 16, 5, 0), fetchDividends: async () => { throw new Error('mock BSE 403'); } }),
      /mock BSE 403/
    );
    const outageState = monitor.loadState();
    assert.equal(outageState.health.outage_active, true);
    assert.equal(fs.readFileSync(process.env.DIVIDEND_CACHE_FILE, 'utf8'), cacheBeforeOutage);
    console.log('PASS: total outage preserves state/cache and records outage health');

    const recoveredRows = [{
      scrip_code: '532514', short_name: 'IGL', long_name: 'Indraprastha Gas Ltd',
      RD_Date: '01 Oct 2026', Purpose: 'Final Dividend - Rs. - 1.5000',
      dividend_per_share: 1.5, latest_price: 149.4, dividend_yield: 1.0, data_source: 'BSE'
    }];
    Object.defineProperty(recoveredRows, 'source', { value: 'BSE', enumerable: false });
    const recovery = await monitor.checkDividends({ now: new Date(2026, 8, 24, 16, 35, 0), fetchDividends: async () => recoveredRows });
    assert.equal(recovery.new_alerts, 0);
    assert.equal(monitor.loadState().health.outage_active, false);
    console.log('PASS: recovery closes outage without duplicate dividend alert');

    console.log('ALL LOCAL E2E TESTS PASSED');
  } finally {
    server.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
