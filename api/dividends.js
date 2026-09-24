const { fetchDividends } = require('../server/bse-client');
const { loadDividendCache, filterRows } = require('../server/dividend-cache');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const from = String(req.query?.Fdate || '');
  const to = String(req.query?.TDate || '');
  if (!/^\d{8}$/.test(from) || !/^\d{8}$/.test(to)) {
    return res.status(400).json({ error: 'Fdate and TDate must be YYYYMMDD.' });
  }

  // Vercel must use the live BSE DefaultData/w endpoint first. The BSE
  // client builds the exact requested query, including strSearch=S.
  // The committed snapshot is only a fallback when BSE is temporarily
  // unreachable, so the browser request is not silently turned into [].
  try {
    const data = await fetchDividends(from, to);
    if (data.length > 0) return res.status(200).json(data);
  } catch (error) {
    console.error('Live BSE request failed; trying cached snapshot:', error);
  }

  const cache = loadDividendCache();
  if (cache && Array.isArray(cache.data) && cache.data.length > 0) {
    return res.status(200).json(filterRows(cache.data, from, to));
  }

  return res.status(503).json({
    error: 'BSE returned no dividend records and no cached snapshot is available.'
  });
};
