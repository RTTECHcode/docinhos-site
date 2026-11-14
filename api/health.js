// GET /api/health (público, para o monitor externo: UptimeRobot ou Better Stack). v4 O-01.
// Responde só ok e verificações sim/não: banco, MERCADOPAGO_ACCESS_TOKEN e MERCADOPAGO_WEBHOOK_SECRET presentes
// (nunca o valor) e nenhum aviso do Mercado Pago recusado (401) nas últimas 24 h. 503 se alguma falhar.
// Detalhes (hora do último aviso aceito, quantidade de 401) só no painel: GET /api/admin?a=health_detail.
const { healthChecks } = require('./_lib/monitor');
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).json({ error: 'Método não permitido' });
  const r = await healthChecks(() => require('./_lib/db'));
  return res.status(r.ok ? 200 : 503).json({ ok: r.ok, checks: r.checks });
};
