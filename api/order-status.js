// GET /api/order-status?t=<token de rastreio>  ->  status público do pedido (sem telefone nem endereço).
// GET /api/order-status?code=DGxxxxxxxxxx      ->  formato antigo: { code, payment_status } (mantido).
// O DG-#### (public_code) NÃO serve de chave de consulta: tem só 9000 combinações e seria adivinhável.
// Conferência de reserva (W3): se o pagamento ainda está pendente, o pedido tem menos de 2 h e a última conferência
// desse pedido foi há mais de ~30 s, consulta o Mercado Pago e aplica o resultado (mesmas regras do webhook).
// Assim a tela do cliente muda sozinha mesmo quando o aviso do Mercado Pago não chega.
const CODE_RE = /^DG[0-9A-F]{10}$/;
const { TRACKING_RE, hashTrackingToken, trackingView, TRACKING_COLUMNS, sweepOrders } = require('./_lib/orders');
const { clientIp } = require('./_lib/auth');
const { hitExceeded } = require('./_lib/rate-limit');
const payments = require('./_lib/payments');

// A1-12: limite por IP, guardado no banco (tabela rate_hits, vale para todas as instâncias da Vercel).
// A página do pedido consulta a cada 5 s (120 em 10 min por aba).
const WINDOW_MINUTES = 10;
const MAX_PER_IP = 300;
const MSG_RATE_LIMITED = 'Muitas consultas em pouco tempo. Aguarde alguns minutos.';
const throttled = (sql, ip) => hitExceeded(sql, 'order_status', ip, { windowMinutes: WINDOW_MINUTES, max: MAX_PER_IP });

// Conferência de reserva: no máximo 2 consultas ao Mercado Pago por pedido a cada minuto (uma a cada ~30 s),
// contadas no banco por pedido (escopo 'payment_check', chave "order:<id>"), só para pedido pendente com menos de 2 h.
const CHECK_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const CHECK_MAX_PER_MINUTE = 2;
const CHECK_TIMEOUT_MS = 4000; // a página consulta a cada 5 s: não segura a resposta por muito tempo
const PENDING_STATUSES = new Set(['pending', 'in_process', 'authorized']);

function shouldCheck(row, nowMs = Date.now()) {
  if (!row || !PENDING_STATUSES.has(row.payment_status)) return false;
  if (!row.payment_method || !row.code) return false; // pedido sem pagamento gerado
  const age = nowMs - new Date(row.created_at).getTime();
  return age >= 0 && age < CHECK_MAX_AGE_MS;
}

// Nunca derruba a consulta do cliente: qualquer falha só vai para o log.
async function backupCheck(sql, id) {
  try {
    const [row] = await sql.query('select id, code, payment_id, payment_method, payment_status, created_at from orders where id = $1', [id]);
    if (!shouldCheck(row)) return null;
    if (!process.env.MERCADOPAGO_ACCESS_TOKEN) return null;
    if (await hitExceeded(sql, 'payment_check', 'order:' + row.id, { windowMinutes: 0, max: CHECK_MAX_PER_MINUTE })) return null;
    return await payments.checkOrderPayment(sql, row, { source: 'order-status', timeoutMs: CHECK_TIMEOUT_MS });
  } catch (error) {
    console.error('Conferência de pagamento falhou:', error.message);
    return null;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });
  const query = req.query || {};
  const token = typeof query.t === 'string' ? query.t : '';
  const code = typeof query.code === 'string' ? query.code : '';
  const notFound = () => res.status(404).json({ error: 'Pedido não encontrado' });
  try {
    const sql = require('./_lib/db');
    // Limite antes de qualquer consulta ao pedido. Toda chamada conta (até 404 e as já barradas).
    if (await throttled(sql, clientIp(req))) return res.status(429).json({ error: MSG_RATE_LIMITED, code: 'rate_limited' });
    if (token) {
      if (!TRACKING_RE.test(token)) return notFound();
      const [found] = await sql.query('select id from orders where tracking_token_hash = $1', [hashTrackingToken(token)]);
      if (!found) return notFound();
      await backupCheck(sql, found.id);
      await sweepOrders(sql, { id: found.id }); // pronto há mais de 1 h vira concluído (sem cron)
      const [row] = await sql.query(`select ${TRACKING_COLUMNS} from orders where id = $1`, [found.id]);
      return res.status(200).json(trackingView(row));
    }
    if (!CODE_RE.test(code)) return notFound();
    const [found] = await sql.query('select id from orders where code = $1', [code]);
    if (!found) return notFound();
    await backupCheck(sql, found.id);
    const [row] = await sql.query('select code, payment_status from orders where id = $1', [found.id]);
    return res.status(200).json({ code: row.code, payment_status: row.payment_status });
  } catch (error) {
    console.error('Erro ao consultar pedido:', error.message);
    return res.status(500).json({ error: 'Não foi possível consultar o pedido' });
  }
};

module.exports._internal = { CODE_RE, throttled, MAX_PER_IP, shouldCheck, backupCheck, CHECK_MAX_AGE_MS, CHECK_MAX_PER_MINUTE };
