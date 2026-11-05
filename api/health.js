const sql = require('./db');
module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });
  try { await sql`select 1`; res.status(200).json({ ok: true }); }
  catch { res.status(500).json({ ok: false }); }
};
