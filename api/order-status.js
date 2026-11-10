// GET /api/order-status?code=DGxxxxxxxxxx -> { code, payment_status } (sem dados pessoais).
const CODE_RE = /^DG[0-9A-F]{10}$/;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });
  const code = req.query && typeof req.query.code === 'string' ? req.query.code : '';
  if (!CODE_RE.test(code)) return res.status(404).json({ error: 'Pedido não encontrado' });
  try {
    const sql = require('./_lib/db');
    const [row] = await sql.query('select code, payment_status from orders where code = $1', [code]);
    if (!row) return res.status(404).json({ error: 'Pedido não encontrado' });
    return res.status(200).json({ code: row.code, payment_status: row.payment_status });
  } catch (error) {
    console.error('Erro ao consultar pedido:', error.message);
    return res.status(500).json({ error: 'Não foi possível consultar o pedido' });
  }
};

module.exports._internal = { CODE_RE };
