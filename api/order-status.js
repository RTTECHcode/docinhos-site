// GET /api/order-status?t=<token de rastreio>  ->  status público do pedido (sem telefone nem endereço).
// GET /api/order-status?code=DGxxxxxxxxxx      ->  formato antigo: { code, payment_status } (mantido).
// O DG-#### (public_code) NÃO serve de chave de consulta: tem só 9000 combinações e seria adivinhável.
const CODE_RE = /^DG[0-9A-F]{10}$/;
const { TRACKING_RE, hashTrackingToken, trackingView, TRACKING_COLUMNS, sweepOrders } = require('./_lib/orders');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });
  const query = req.query || {};
  const token = typeof query.t === 'string' ? query.t : '';
  const code = typeof query.code === 'string' ? query.code : '';
  const notFound = () => res.status(404).json({ error: 'Pedido não encontrado' });
  try {
    const sql = require('./_lib/db');
    if (token) {
      if (!TRACKING_RE.test(token)) return notFound();
      const [found] = await sql.query('select id from orders where tracking_token_hash = $1', [hashTrackingToken(token)]);
      if (!found) return notFound();
      await sweepOrders(sql, { id: found.id }); // pronto há mais de 1 h vira concluído (sem cron)
      const [row] = await sql.query(`select ${TRACKING_COLUMNS} from orders where id = $1`, [found.id]);
      return res.status(200).json(trackingView(row));
    }
    if (!CODE_RE.test(code)) return notFound();
    const [row] = await sql.query('select code, payment_status from orders where code = $1', [code]);
    if (!row) return notFound();
    return res.status(200).json({ code: row.code, payment_status: row.payment_status });
  } catch (error) {
    console.error('Erro ao consultar pedido:', error.message);
    return res.status(500).json({ error: 'Não foi possível consultar o pedido' });
  }
};

module.exports._internal = { CODE_RE };
