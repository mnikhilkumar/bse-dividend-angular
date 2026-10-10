module.exports = async function handler(req, res) {
  res.status(200).json({ ok: true, service: 'bse-dividend-angular-api' });
};
