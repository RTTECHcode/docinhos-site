// API pública da loja (única função nova da fase O): GET /api/store?a=<acao>
//   a=state     -> { open, reason, reopens_at, next_open_at, closes_at, message, hours }
//   a=shipping  -> { bands, max_km, pickup_fee_cents }
//   a=cep       -> endereço do CEP (v3 D3): ?cep=06000000  ->  { cep, street, district, city, uf }; 404 cep_not_found; 429 rate_limited
//   a=quote     -> cotação de frete: ?cep=06000000&address=Rua X, 100[&number=100]  ->  { km, fee_cents, faixa, max_km }
// Nada aqui altera dados. O pedido (api/order.js) recalcula o frete por conta própria: a cotação é só informativa.
const { getStoreState } = require('./_lib/store-hours');
const shipping = require('./_lib/shipping');
const { hitExceeded } = require('./_lib/rate-limit');

// Limite de cotações por IP, guardado no banco (tabela rate_hits, vale para todas as instâncias da Vercel).
const QUOTE_WINDOW_MINUTES = 10;
const QUOTE_MAX_PER_IP = 30;      // por IP em 10 min
const throttled = (sql, ip) => hitExceeded(sql, 'shipping_quote', ip, { windowMinutes: QUOTE_WINDOW_MINUTES, max: QUOTE_MAX_PER_IP });
// Consulta de CEP: limite próprio por IP (escopo cep_lookup). O resultado vem do cache em banco (cep_cache) quando possível.
const CEP_MAX_PER_IP = 30;        // por IP em 10 min
const cepThrottled = (sql, ip) => hitExceeded(sql, 'cep_lookup', ip, { windowMinutes: QUOTE_WINDOW_MINUTES, max: CEP_MAX_PER_IP });
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
    if (action === 'cep') {
      if (await cepThrottled(sql, clientIp(req))) return res.status(429).json({ error: 'Muitas consultas de CEP. Aguarde alguns minutos ou preencha o endereço à mão.', code: 'rate_limited' });
      return res.status(200).json(await shipping.lookupCep(sql, query.cep));
    }
    if (action === 'quote') {
      if (await throttled(sql, clientIp(req))) return res.status(429).json({ error: 'Muitas consultas de frete. Aguarde alguns minutos.', code: 'rate_limited' });
      if (await shipping.tooManyNewLookups(sql)) return res.status(429).json({ error: 'Muitas consultas de frete agora. Tente de novo em instantes.', code: 'shipping_busy' });
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

module.exports._internal = { throttled, QUOTE_MAX_PER_IP, cepThrottled, CEP_MAX_PER_IP };
