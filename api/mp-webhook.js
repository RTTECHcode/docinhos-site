const crypto = require('node:crypto');
const payments = require('./_lib/payments');

// Extrai ts e v1 do header x-signature ("ts=...,v1=...").
function parseSignature(header) {
  const out = {};
  for (const part of String(header || '').split(',')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const MAX_SIGNATURE_AGE_S = 300; // recusa assinaturas com mais de 5 min de diferença (anti-replay)

// ts do Mercado Pago pode vir em milissegundos (13 dígitos) ou segundos (10 dígitos).
// Valores >= 1e11 são tratados como ms (1e11 s seria o ano 5138; 1e11 ms é março de 1973).
// Retorna o instante em segundos, ou null se não for um número inteiro positivo.
function tsToSeconds(ts) {
  if (!/^\d{1,16}$/.test(String(ts))) return null;
  const n = Number(ts);
  if (!(n > 0)) return null;
  return n >= 1e11 ? n / 1000 : n;
}

// Motivo da recusa da assinatura, ou null se ela for válida. Nunca inclui o segredo nem o v1.
// Manifest assinado: "id:{data.id};request-id:{x-request-id};ts:{ts};". nowMs injetável para teste.
function signatureProblem({ secret, signatureHeader, requestId, dataId, nowMs = Date.now() }) {
  if (!signatureHeader) return 'sem x-signature';
  const { ts, v1 } = parseSignature(signatureHeader);
  if (!ts || !v1) return 'x-signature sem ts ou v1';
  if (!requestId) return 'sem x-request-id';
  if (!dataId) return 'sem data.id';
  const tsSec = tsToSeconds(ts);
  if (tsSec === null) return 'ts inválido';
  const age = Math.round(nowMs / 1000 - tsSec);
  if (Math.abs(age) > MAX_SIGNATURE_AGE_S) return `ts fora da janela (${age} s)`;
  // trim: espaço ou quebra de linha colados junto com o segredo na Vercel invalidavam toda assinatura.
  const expected = crypto.createHmac('sha256', String(secret).trim())
    .update(`id:${dataId};request-id:${requestId};ts:${ts};`)
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  if (!(a.length === b.length && crypto.timingSafeEqual(a, b))) return 'HMAC diferente (segredo da Vercel não confere com a assinatura secreta do app no Mercado Pago?)';
  return null;
}

function verifySignature(args) {
  return signatureProblem(args) === null;
}

// Normaliza a notificação: { type, dataId } (data.id vem na query e/ou no corpo).
function parseNotification(query, body) {
  const q = query || {};
  const bd = body && typeof body === 'object' ? body : {};
  const type = String(bd.type || q.type || q.topic || '');
  // O manifest assinado usa o data.id da query; o corpo só serve de reserva.
  let dataId = String(q['data.id'] ?? (bd.data && bd.data.id) ?? '');
  if (/^[a-z0-9]+$/i.test(dataId)) dataId = dataId.toLowerCase();
  return { type, dataId };
}

// Formato antigo (IPN, user agent "MercadoPago Feed v2.0"): ?topic=payment&id=123 ou corpo { resource, topic },
// sem data.id e sem assinatura. Não é processado (o mesmo pagamento chega também no formato Webhooks, assinado);
// responde 200 para o Mercado Pago não reenviar. A notification_url já vai com ?source_news=webhooks para evitá-lo.
function isLegacyIpn(query, body) {
  const q = query || {};
  const bd = body && typeof body === 'object' ? body : {};
  if (q['data.id'] !== undefined || (bd.data && bd.data.id !== undefined)) return false;
  return Boolean(q.topic || q.id || bd.topic || bd.resource);
}

const paymentMethodOf = payments.paymentMethodOf;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  if (isLegacyIpn(req.query, req.body)) return res.status(200).json({ ok: true, ignored: 'ipn' });

  const { type, dataId } = parseNotification(req.query, req.body);

  const secret = (process.env.MERCADOPAGO_WEBHOOK_SECRET || '').trim();
  if (!secret && process.env.VERCEL_ENV === 'production') {
    // Fail-closed: em produção, sem segredo não há como validar a origem da notificação.
    console.error('MERCADOPAGO_WEBHOOK_SECRET não definido em produção: notificação recusada.');
    return res.status(500).json({ error: 'Configuração ausente' });
  }
  if (secret) {
    const requestId = req.headers['x-request-id'];
    const problem = signatureProblem({ secret, signatureHeader: req.headers['x-signature'], requestId, dataId });
    if (problem) {
      // Log sem segredo e sem v1: só o motivo e o que identifica o aviso no painel do Mercado Pago.
      console.warn('Webhook do Mercado Pago recusado (401):', problem,
        JSON.stringify({ type, data_id: dataId, request_id: requestId || null, user_agent: req.headers['user-agent'] || null }));
      return res.status(401).json({ error: 'Assinatura inválida' });
    }
  } else {
    console.warn('MERCADOPAGO_WEBHOOK_SECRET não definido: assinatura não validada (o pagamento é sempre confirmado via API do Mercado Pago).');
  }

  // Só o tópico "payment" interessa; os demais recebem 200 para não gerar retentativas.
  if (type !== 'payment' || !/^\d+$/.test(dataId)) return res.status(200).json({ ok: true });

  const token = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!token) {
    console.error('MERCADOPAGO_ACCESS_TOKEN não definido');
    return res.status(500).json({ error: 'Configuração ausente' });
  }

  // Em serverless o processamento precisa terminar antes da resposta. Regras de moeda, valor, idempotência e pontos
  // ficam em _lib/payments.js (as mesmas da conferência no acompanhamento e do botão do painel).
  try {
    const pay = await payments.fetchPayment(token, dataId);
    if (!pay) return res.status(200).json({ ok: true }); // 404 no Mercado Pago
    const sql = require('./_lib/db'); // carregado aqui para o parser poder ser testado sem DATABASE_URL
    await payments.syncPayment(sql, pay, { source: 'webhook' });
    return res.status(200).json({ ok: true });
  } catch (error) {
    if (error instanceof payments.PaymentLookupError) {
      console.error('Mercado Pago respondeu', error.status, 'ao buscar pagamento', dataId);
      return res.status(500).json({ error: 'Falha ao consultar pagamento' }); // MP tenta de novo
    }
    console.error('Erro no webhook do Mercado Pago:', error.message);
    return res.status(500).json({ error: 'Erro ao processar notificação' });
  }
};

const { CANCELLED_PAID_ACTION, noteCancelledPaid } = payments;
module.exports._internal = { CANCELLED_PAID_ACTION, noteCancelledPaid, parseSignature, verifySignature, signatureProblem, tsToSeconds, parseNotification, isLegacyIpn, paymentMethodOf };
