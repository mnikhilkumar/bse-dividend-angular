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
  const purposeCode = String(req.query?.Purposecode || 'P9');
  const category = String(req.query?.ddlcategorys || 'E');
  const industry = String(req.query?.ddlindustrys || '');
  const segment = String(req.query?.segment || '0');

  if (!/^\d{8}$/.test(from) || !/^\d{8}$/.test(to)) {
    return res.status(400).json({ error: 'Fdate and TDate must be YYYYMMDD.' });
  }

  // Vercel live path: forward the browser's dividend filters to the BSE
  // DefaultData/w endpoint. BSE's required live endpoint uses strSearch=S.
  // The committed snapshot remains only a fallback when BSE cannot be reached
  // from the Vercel runtime (for example, BSE blocks the serverless IP).
  try {
    const data = await fetchDividends(from, to, {
      Purposecode: purposeCode,
      ddlcategorys: category,
      ddlindustrys: industry,
      segment
    });
    if (data.length > 0) {
      res.setHeader('X-Dividend-Source', data[0]?.data_source || 'BSE');
      return res.status(200).json(data);
    }
  } catch (error) {
    console.error('Live BSE request failed; trying cached snapshot:', error);
  }

  const cache = loadDividendCache();
  if (cache && Array.isArray(cache.data) && cache.data.length > 0) {
    res.setHeader('X-Dividend-Source', 'cache-fallback');
    return res.status(200).json(filterRows(cache.data, from, to));
  }

  return res.status(503).json({
    error: 'No valid dividend records were returned by BSE and no cached snapshot is available.'
  });
};
