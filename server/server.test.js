const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
  process.env.BSE_MOCK = '1';

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

    const data = await get('/api/dividends?Fdate=20260919&TDate=20261118');
    assert.equal(data.status, 200);
    const rows = JSON.parse(data.body);
    assert.equal(rows.length, 2);

    const igl = rows.find(x => x.scrip_code === '532514');
    assert(igl);
    assert.equal(igl.latest_price, 149.40);
    assert.equal(igl.dividend_per_share, 1.5);
    assert.equal(igl.dividend_yield, 1.0);
    assert(!Object.prototype.hasOwnProperty.call(igl, 'Ex_date'));

    console.log('PASS: dividend/share extraction');
    console.log('PASS: latest price lookup in mock mode');
    console.log('PASS: dividend yield calculation');
    console.log('PASS: Ex-Date removed from API payload');
  } finally {
    server.close();
  }

  const stateFile = path.join(os.tmpdir(), `bse-dividend-state-${Date.now()}.json`);
  process.env.DIVIDEND_STATE_FILE = stateFile;
  process.env.TELEGRAM_MOCK = '1';

  const monitor = require('./dividend-monitor');
  const state = { companies: {
    old: { record_date: '18-Sep-2026' },
    current: { record_date: '21-Sep-2026' }
  }, last_checked: null };

  fs.writeFileSync(stateFile, JSON.stringify(state));
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
  console.log('PASS: Telegram message contains company table values');

  fs.unlinkSync(stateFile);
  console.log('ALL LOCAL E2E TESTS PASSED');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
