const crypto = require('node:crypto');

const MP_PAYMENTS_URL = 'https://api.mercadopago.com/v1/payments/';

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

// Valida x-signature: HMAC-SHA256 de "id:{data.id};request-id:{x-request-id};ts:{ts};".
// nowMs injetável para teste.
function verifySignature({ secret, signatureHeader, requestId, dataId, nowMs = Date.now() }) {
  const { ts, v1 } = parseSignature(signatureHeader);
  if (!ts || !v1 || !requestId || !dataId) return false;
  const tsSec = tsToSeconds(ts);
  if (tsSec === null || Math.abs(nowMs / 1000 - tsSec) > MAX_SIGNATURE_AGE_S) return false;
  const expected = crypto.createHmac('sha256', secret)
    .update(`id:${dataId};request-id:${requestId};ts:${ts};`)
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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

// Pix (payment_method_id 'pix') vira 'pix'; qualquer outro pagamento vem do Checkout Pro com cartão.
function paymentMethodOf(pay) {
  return pay && pay.payment_method_id === 'pix' ? 'pix' : 'mercadopago_card';
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const { type, dataId } = parseNotification(req.query, req.body);

  const secret = process.env.MERCADOPAGO_WEBHOOK_SECRET;
  if (!secret && process.env.VERCEL_ENV === 'production') {
    // Fail-closed: em produção, sem segredo não há como validar a origem da notificação.
    console.error('MERCADOPAGO_WEBHOOK_SECRET não definido em produção: notificação recusada.');
    return res.status(500).json({ error: 'Configuração ausente' });
  }
  if (secret) {
    const ok = verifySignature({
      secret,
      signatureHeader: req.headers['x-signature'],
      requestId: req.headers['x-request-id'],
      dataId
    });
    if (!ok) return res.status(401).json({ error: 'Assinatura inválida' });
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

  // Em serverless o processamento precisa terminar antes da resposta; são só 1 GET + 1 UPDATE.
  try {
    const mpRes = await fetch(MP_PAYMENTS_URL + dataId, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(8000)
    });
    if (mpRes.status === 404) return res.status(200).json({ ok: true });
    if (!mpRes.ok) {
      console.error('Mercado Pago respondeu', mpRes.status, 'ao buscar pagamento', dataId);
      return res.status(500).json({ error: 'Falha ao consultar pagamento' }); // MP tenta de novo
    }
    const pay = await mpRes.json();
    const code = pay.external_reference;
    if (!code || !pay.status) return res.status(200).json({ ok: true });

    const sql = require('./_lib/db'); // carregado aqui para o parser poder ser testado sem DATABASE_URL
    const [order] = await sql.query('select id, total_cents from orders where code = $1', [String(code)]);
    if (!order) return res.status(200).json({ ok: true });

    // Só confirma se moeda e valor pago batem com o total gravado no servidor.
    if (pay.currency_id && pay.currency_id !== 'BRL') {
      console.error('Moeda do pagamento diferente de BRL', code, dataId);
      return res.status(200).json({ ok: true });
    }
    if (Math.round(Number(pay.transaction_amount) * 100) !== order.total_cents) {
      console.error('Valor do pagamento diferente do pedido', code, dataId);
      return res.status(200).json({ ok: true });
    }

    // Idempotente: só grava se algo mudou; um pagamento recusado não sobrescreve um já aprovado.
    await sql.query(
      `update orders set payment_status = $2, payment_id = $3, payment_method = $4
       where code = $1
         and (payment_status is distinct from $2 or payment_id is distinct from $3)
         and not (payment_status = 'approved' and payment_id is distinct from $3 and $2 <> 'approved')`,
      [String(code), String(pay.status), String(pay.id), paymentMethodOf(pay)]
    );
    // Pontos (O11): só chega aqui com moeda e valor conferidos. Idempotente: aprovado credita e confirma o resgate;
    // rejeitado/cancelado devolve a reserva; estornado reverte. Roda a cada notificação para consertar execução interrompida.
    await require('./_lib/loyalty').onPaymentStatus(sql, order.id);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Erro no webhook do Mercado Pago:', error.message);
    return res.status(500).json({ error: 'Erro ao processar notificação' });
  }
};

module.exports._internal = { parseSignature, verifySignature, tsToSeconds, parseNotification, paymentMethodOf };
