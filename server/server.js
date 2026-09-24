const http = require('http');
const { URL } = require('url');
const { fetchDividends } = require('./bse-client');
const { loadDividendCache, filterRows } = require('./dividend-cache');

const PORT = Number(process.env.PORT || 3000);

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (requestUrl.pathname === '/api/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (requestUrl.pathname === '/api/dividends') {
    try {
      const from = requestUrl.searchParams.get('Fdate') || '';
      const to = requestUrl.searchParams.get('TDate') || '';
      const purposeCode = requestUrl.searchParams.get('Purposecode') || 'P9';
      const category = requestUrl.searchParams.get('ddlcategorys') || 'E';
      const industry = requestUrl.searchParams.get('ddlindustrys') || '';
      const segment = requestUrl.searchParams.get('segment') || '0';

      if (!/^\d{8}$/.test(from) || !/^\d{8}$/.test(to)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Fdate and TDate must be YYYYMMDD.' }));
        return;
      }

      try {
        const data = await fetchDividends(from, to, {
          Purposecode: purposeCode,
          ddlcategorys: category,
          ddlindustrys: industry,
          segment
        });
        if (data.length > 0) {
          res.writeHead(200);
          res.end(JSON.stringify(data));
          return;
        }
      } catch (error) {
        console.warn(`Live BSE request failed; trying cached snapshot: ${error.message}`);
      }

      const cache = loadDividendCache();
      if (cache && Array.isArray(cache.data) && cache.data.length > 0) {
        const data = filterRows(cache.data, from, to);
        res.writeHead(200);
        res.end(JSON.stringify(data));
        return;
      }

      res.writeHead(503);
      res.end(JSON.stringify({ error: 'BSE returned no dividend records and no cached snapshot is available.' }));
      return;
    } catch (error) {
      console.error(error);
      res.writeHead(502);
      res.end(JSON.stringify({ error: `BSE request failed: ${error.message}` }));
      return;
    }
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`BSE backend running at http://localhost:${PORT}`);
  });
}

module.exports = server;
