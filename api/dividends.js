const { fetchDividends } = require('../server/bse-client');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const from = String(req.query?.Fdate || '');
  const to = String(req.query?.TDate || '');

  if (!/^\d{8}$/.test(from) || !/^\d{8}$/.test(to)) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'Fdate and TDate must be YYYYMMDD.' }));
    return;
  }

  try {
    const data = await fetchDividends(from, to);
    res.statusCode = 200;
    res.end(JSON.stringify(data));
  } catch (error) {
    console.error('Dividend API error:', error);
    res.statusCode = 502;
    res.end(JSON.stringify({ error: `BSE request failed: ${error?.message || 'Unknown error'}` }));
  }
};
