'use strict';
/*
 * Conta do cliente (A10): roteador único em /api/customer?a=<acao> (uma só função serverless).
 * Regras de negócio ficam em api/_lib/customer.js, auth.js e loyalty.js; aqui só HTTP, CSRF, limites e formato das respostas.
 *
 * Segurança (resumo): POST só com JSON + Origin igual ao Host + Sec-Fetch-Site same-origin; cookie __Host-dg_cliente
 * (HttpOnly, Secure, SameSite=Lax, Path=/) montado por _lib; Cache-Control no-store; métodos restritos (405);
 * mensagens genéricas (não revelam se o telefone existe); erros sem stack; corpo limitado; SQL parametrizado.
 *
 * CONTRATO com a loja (A6): GET ?a=me retorna { logged_in: false } ou
 * { logged_in: true, customer: { name, points: { balance, locked_until } } }. NÃO mude esse formato.
 */
const auth = require('./_lib/auth');
const customerLib = require('./_lib/customer');
const loyalty = require('./_lib/loyalty');
const getSql = () => require('./_lib/db'); // carregado sob demanda, como no admin

const MAX_BODY_BYTES = 20 * 1024;
const REGISTER_MAX_PER_HOUR = 15;   // contas novas (sessões abertas) por IP em 1 h
const PASSWORD_MAX_FAILS = 5;       // senha atual errada ao trocar a senha: 5 erros = 30 min
const MSG_LOGIN_REQUIRED = 'Entre na sua conta para continuar.';
const MSG_METHOD = 'Método não permitido.';
const MSG_LOCKED = customerLib.MSG_LOCKED;

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code || null; }
}

function send(res, status, payload, extraHeaders) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (extraHeaders && extraHeaders['Set-Cookie']) res.setHeader('Set-Cookie', extraHeaders['Set-Cookie']);
  res.end(JSON.stringify(payload));
}
function baseHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}
function readBody(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
  if (Buffer.isBuffer(b)) { try { b = JSON.parse(b.toString('utf8')); } catch { b = null; } }
  return b && typeof b === 'object' && !Array.isArray(b) ? b : null;
}
const ctxOf = (req, source) => ({ ip: auth.clientIp(req), ua: req.headers['user-agent'], source });
const profileView = p => ({
  name: p.name, phone: p.phone, email: p.email,
  whatsapp_consent: p.whatsapp_consent, whatsapp_consent_at: p.whatsapp_consent_at, whatsapp_opt_out_at: p.whatsapp_opt_out_at,
  birth_day: p.birth_day, birth_month: p.birth_month, points_locked_until: p.points_locked_until,
  security_question: p.security_question, created_at: p.created_at
});

// ---------- Rótulos em português ----------
const PAYMENT_LABELS = {
  approved: 'pago', authorized: 'aguardando pagamento', pending: 'aguardando pagamento', in_process: 'aguardando pagamento',
  rejected: 'recusado', cancelled: 'cancelado', refunded: 'estornado', charged_back: 'estornado'
};
const paymentLabel = s => PAYMENT_LABELS[s] || 'aguardando pagamento';
function orderView(o) {
  const items = Array.isArray(o.items) ? o.items.slice(0, 30) : [];
  return {
    public_code: o.public_code, created_at: o.created_at, total_cents: o.total_cents,
    subtotal_cents: o.subtotal_cents, delivery_fee_cents: o.delivery_fee_cents, discount_cents: o.discount_cents, points_redeemed: o.points_redeemed,
    fulfillment_status: o.fulfillment_status, fulfillment_label: o.fulfillment_label,
    payment_status: o.payment_status, payment_label: paymentLabel(o.payment_status),
    delivery_method: o.delivery_method,
    items_summary: items.map(i => `${Number(i && i.qty) || 1}x ${String((i && i.name) || 'Item').slice(0, 80)}${i && i.size ? ` (${String(i.size).slice(0, 40)})` : ''}`),
    // Os pedidos guardam só o SHA-256 do token de acompanhamento: sem token não há link. A tela mostra o status direto.
    tracking_url: null
  };
}
// Descrição do extrato em português (o servidor monta; a tela só exibe com textContent).
function ledgerDescription(row) {
  const code = row.public_code ? ` ${row.public_code}` : '';
  switch (row.kind) {
    case 'earn': return `Pontos do pedido${code} (pagamento aprovado)`;
    case 'redeem_reserve': return `Pontos reservados para o pedido${code}`;
    case 'redeem_release': return `Pontos devolvidos${code ? ` (pedido${code} não foi pago)` : ''}`;
    case 'redeem_commit': return `Desconto aplicado no pedido${code}`;
    case 'reversal': return `Pontos estornados do pedido${code}`;
    case 'adjust': return row.note ? `Ajuste da loja: ${String(row.note).slice(0, 120)}` : 'Ajuste da loja';
    default: return 'Movimentação de pontos';
  }
}

// ---------- Limites extras (além dos de _lib/customer.js) ----------
// Cadastro: no máximo REGISTER_MAX_PER_HOUR contas novas por IP por hora (cada conta abre uma linha em customer_sessions com o IP).
async function checkRegisterLimit(sql, ip) {
  const [r] = await sql.query(`select count(*)::int as n from customer_sessions where ip = $1 and created_at > now() - interval '1 hour'`, [ip]);
  if (r.n >= REGISTER_MAX_PER_HOUR) throw new HttpError(429, 'Muitas tentativas. Tente novamente mais tarde.', 'locked');
}
// Troca de senha: senha atual errada conta como falha de login (5 erros desde o último acerto = 30 min).
async function passwordLocked(sql, phone) {
  const [r] = await sql.query(
    `select count(*)::int as n from customer_login_attempts
      where scope = 'login' and phone = $1 and ok = false and at > now() - interval '30 minutes'
        and at > coalesce((select max(at) from customer_login_attempts where scope = 'login' and phone = $1 and ok = true), '-infinity'::timestamptz)`, [phone]);
  return r.n >= PASSWORD_MAX_FAILS;
}
const logPasswordAttempt = (sql, phone, ip, ok) =>
  sql.query(`insert into customer_login_attempts (scope, phone, ip, ok) values ('login', $1, $2, $3)`, [phone, ip || 'unknown', ok]);

async function requireSession(sql, req) {
  const session = await customerLib.getSession(sql, req);
  if (!session) throw new HttpError(401, MSG_LOGIN_REQUIRED, 'login_required');
  return session;
}
const str = v => (typeof v === 'string' ? v : '');

// ---------- Ações: { m: método, fn(ctx) } ----------
const A = {
  // Contrato com a loja: formato fixo.
  me: { m: 'GET', async fn({ sql, req }) {
    const session = await customerLib.getSession(sql, req);
    if (!session) return { body: { logged_in: false } };
    const pts = await loyalty.getBalance(sql, session.customer.id);
    const locked = pts.locked_until || null;
    return { body: { logged_in: true, customer: { name: session.customer.name, points: { balance: pts.balance, locked_until: locked } } } };
  } },

  questions: { m: 'GET', async fn() {
    return { body: {
      questions: customerLib.SECURITY_QUESTIONS.map(q => ({ id: q.id, text: q.text })),
      consent: { text: customerLib.CONSENT_TEXT, version: customerLib.CONSENT_VERSION }
    } };
  } },

  register: { m: 'POST', async fn({ sql, req, body }) {
    const ctx = ctxOf(req, 'cadastro');
    await checkRegisterLimit(sql, ctx.ip);
    // Só campos conhecidos. O consentimento só vale com true booleano explícito (nunca pré-marcado).
    const input = {
      name: body.name, phone: body.phone, email: body.email, password: body.password,
      security_question: body.security_question, security_answer: body.security_answer,
      whatsapp_consent: body.whatsapp_consent === true, birth_day: body.birth_day, birth_month: body.birth_month
    };
    const { customer, token } = await customerLib.createAccount(sql, input, ctx);
    return { status: 201, cookie: customerLib.sessionCookie(token), body: { ok: true, customer: { name: customer.name }, whatsapp_consent: customer.whatsapp_consent } };
  } },

  login: { m: 'POST', async fn({ sql, req, body }) {
    const { customer, token } = await customerLib.login(sql, { phone: body.phone, password: body.password }, ctxOf(req));
    return { cookie: customerLib.sessionCookie(token), body: { ok: true, customer: { name: customer.name } } };
  } },

  logout: { m: 'POST', async fn({ sql, req }) {
    return { cookie: await customerLib.logoutFromRequest(sql, req), body: { ok: true } };
  } },

  // Recuperação passo 1: pergunta (conta inexistente recebe pergunta falsa estável, igual na forma).
  recover_question: { m: 'POST', async fn({ sql, body }) {
    const q = await customerLib.recoveryQuestion(sql, { phone: body.phone });
    return { body: { question_id: q.question_id, question: q.question } };
  } },

  // Recuperação passo 2: telefone + resposta + nova senha. Derruba sessões e trava pontos por 48 h (feito em _lib).
  recover: { m: 'POST', async fn({ sql, req, body }) {
    const r = await customerLib.recover(sql, { phone: body.phone, answer: body.answer, new_password: body.new_password }, ctxOf(req));
    return { cookie: customerLib.clearSessionCookie(), body: { ok: true, points_locked_until: r.points_locked_until, points_lock_hours: 48 } };
  } },

  profile: { m: 'GET', async fn({ sql, req }) {
    const { customer } = await requireSession(sql, req);
    return { body: { customer: profileView(customerLib.customerView(customer)) } };
  } },

  orders: { m: 'GET', async fn({ sql, req, query }) {
    const { customer } = await requireSession(sql, req);
    const list = await customerLib.listOrders(sql, customer.id, { limit: query.get('limit') || 20, offset: query.get('offset') || 0 });
    return { body: { orders: list.map(orderView) } };
  } },

  points: { m: 'GET', async fn({ sql, req }) {
    const { customer } = await requireSession(sql, req);
    const p = await customerLib.getPoints(sql, customer.id, { limit: 50 });
    return { body: {
      balance: p.balance, reserved: p.reserved, earned_total: p.earned_total, locked_until: p.locked_until,
      points_per_real: p.points_per_real, block_points: p.block_points, block_value_cents: p.block_value_cents,
      history: p.history.map(h => ({
        id: Number(h.id), kind: h.kind, points: h.points, created_at: new Date(h.created_at).toISOString(),
        public_code: h.public_code || null, description: ledgerDescription(h)
      }))
    } };
  } },

  consent: { m: 'POST', async fn({ sql, req, body }) {
    const { customer } = await requireSession(sql, req);
    if (typeof body.whatsapp_consent !== 'boolean') throw new HttpError(400, 'Consentimento inválido.', 'invalid_consent');
    const p = await customerLib.setWhatsappConsent(sql, customer.id, body.whatsapp_consent, ctxOf(req, 'conta'));
    return { body: { ok: true, customer: profileView(p) } };
  } },

  password: { m: 'POST', async fn({ sql, req, body }) {
    const { customer, tokenHash } = await requireSession(sql, req);
    if (await passwordLocked(sql, customer.phone)) throw new HttpError(429, MSG_LOCKED, 'locked');
    try {
      await customerLib.changePassword(sql, customer.id, { current_password: str(body.current_password), new_password: body.new_password }, tokenHash);
    } catch (e) {
      if (e && e.code === 'bad_password') await logPasswordAttempt(sql, customer.phone, auth.clientIp(req), false);
      throw e;
    }
    await logPasswordAttempt(sql, customer.phone, auth.clientIp(req), true);
    return { body: { ok: true } };
  } }
};

async function handler(req, res) {
  baseHeaders(res);
  try {
    if (req.method !== 'GET' && req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return send(res, 405, { error: MSG_METHOD }); }
    const url = new URL(req.url || '/', 'http://localhost');
    const query = url.searchParams;
    const name = String(query.get('a') || '').slice(0, 40);
    const action = Object.prototype.hasOwnProperty.call(A, name) ? A[name] : null;
    if (!action) return send(res, 404, { error: 'Ação não encontrada.' });
    if (action.m !== req.method) { res.setHeader('Allow', action.m); return send(res, 405, { error: MSG_METHOD }); }

    let body = {};
    if (req.method === 'POST') {
      // CSRF: Origin igual ao Host, não vindo de outro site, e corpo JSON.
      if (!auth.sameOrigin(req)) return send(res, 403, { error: 'Origem não permitida.' });
      if (!auth.isJsonType(req)) return send(res, 415, { error: 'Envie os dados como JSON.' });
      if (Number(req.headers['content-length'] || 0) > MAX_BODY_BYTES) return send(res, 413, { error: 'Dados grandes demais.' });
      body = readBody(req);
      if (!body) return send(res, 400, { error: 'Dados inválidos.' });
    }

    const result = await action.fn({ sql: getSql(), req, res, body, query });
    return send(res, result.status || 200, result.body, result.cookie ? { 'Set-Cookie': result.cookie } : null);
  } catch (error) {
    const known = error instanceof HttpError || error instanceof customerLib.CustomerError || error instanceof auth.AuthError || error instanceof loyalty.LoyaltyError;
    if (known) return send(res, error.status, { error: error.message, ...(error.code ? { code: error.code } : {}) });
    console.error('Erro na conta do cliente:', error && error.message); // sem stack e sem dados pessoais
    return send(res, 500, { error: 'Não foi possível concluir a operação.' });
  }
}

module.exports = handler;
module.exports._internal = { orderView, ledgerDescription, paymentLabel, profileView };
