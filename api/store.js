// API pública da loja (única função nova da fase O): GET /api/store?a=<acao>
//   a=state     -> { open, reason, reopens_at, next_open_at, closes_at, message, hours }
//   a=shipping  -> { bands, max_km, pickup_fee_cents }
//   a=quote     -> cotação de frete: ?cep=06000000&address=Rua X, 100[&number=100]  ->  { km, fee_cents, faixa, max_km }
// Nada aqui altera dados. O pedido (api/order.js) recalcula o frete por conta própria: a cotação é só informativa.
const { getStoreState } = require('./_lib/store-hours');
const shipping = require('./_lib/shipping');

const QUOTE_WINDOW_MS = 10 * 60 * 1000;
const QUOTE_MAX_PER_IP = 30;      // por IP em 10 min (por instância)
const hits = new Map();

function throttled(ip, now = Date.now()) {
  const list = (hits.get(ip) || []).filter(t => now - t < QUOTE_WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 2000) for (const [k, v] of hits) if (!v.some(t => now - t < QUOTE_WINDOW_MS)) hits.delete(k);
  return list.length > QUOTE_MAX_PER_IP;
}
const { clientIp } = require('./_lib/auth'); // x-real-ip (Vercel) primeiro; x-forwarded-for só como reserva

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Método não permitido' }); }
  const query = req.query || {};
  const action = typeof query.a === 'string' ? query.a : '';
  try {
    const sql = require('./_lib/db');
    if (action === 'state') {
      const s = await getStoreState(sql);
      return res.status(200).json({ open: s.open, reason: s.reason, reopens_at: s.reopens_at, next_open_at: s.next_open_at, closes_at: s.closes_at, message: s.message, hours: s.hours });
    }
    if (action === 'shipping') {
      const bands = await shipping.getBands(sql);
      return res.status(200).json({ bands, max_km: shipping.maxKmOf(bands), pickup_fee_cents: 0 });
    }
    if (action === 'quote') {
      if (throttled(clientIp(req))) return res.status(429).json({ error: 'Muitas consultas de frete. Aguarde alguns minutos.' });
      if (await shipping.tooManyNewLookups(sql)) return res.status(429).json({ error: 'Muitas consultas de frete agora. Tente de novo em instantes.' });
      const q = await shipping.quoteDelivery(sql, { cep: query.cep, address: query.address, number: query.number });
      return res.status(200).json({ km: q.km, fee_cents: q.fee_cents, faixa: q.band, max_km: q.max_km });
    }
    return res.status(404).json({ error: 'Ação não encontrada' });
  } catch (error) {
    if (error instanceof shipping.ShippingError) return res.status(error.status).json({ error: error.message, code: error.code, ...(error.max_km ? { max_km: error.max_km } : {}) });
    console.error('Erro em /api/store:', error.message);
    return res.status(500).json({ error: 'Não foi possível concluir a consulta' });
  }
};

module.exports._internal = { throttled };
