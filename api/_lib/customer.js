'use strict';
/*
 * Conta do cliente (O10): funções de domínio. A rota HTTP (api/customer.js) é do A10 e só chama estas funções.
 * Senhas e respostas de segurança só em hash scrypt (api/_lib/auth.js). Mensagens em português do Brasil.
 * Decisões: docs/planos/decisoes.md (recuperação sem e-mail; consentimento de WhatsApp opcional, nunca pré-marcado).
 */
const auth = require('./auth');
const orders = require('./orders');
const loyalty = require('./loyalty');
const { hasControlChars } = require('./validate');

const COOKIE_NAME = '__Host-dg_cliente';
const SESSION_TTL_S = 30 * 24 * 3600;
const LOGIN_MAX_FAILS = 5;
const LOCK_MS = 30 * 60 * 1000;
const LONG_MAX_FAILS = 10;               // 10 erros em 24 h (por conta) = bloqueio de 24 h
const LONG_LOCK_MS = 24 * 3600 * 1000;
const RECOVERY_POINTS_LOCK = '48 hours';

// Texto do consentimento mostrado ao cliente. Mudou o texto = mude a versão (fica gravada com o aceite).
const CONSENT_VERSION = 'v1-2026-11';
const CONSENT_TEXT = 'Quero receber novidades, promoções e avisos de pedidos da Docinhos da Gigi pelo WhatsApp. Posso sair a qualquer momento respondendo SAIR ou pela minha conta.';

class CustomerError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code || null; }
}
const bad = (message, code) => { throw new CustomerError(400, message, code); };
const MSG_LOCKED = 'Muitas tentativas. Tente novamente em 30 minutos.';
const MSG_LOCKED_LONG = 'Muitas tentativas. Tente novamente mais tarde.';
const MSG_BAD_LOGIN = 'Telefone ou senha incorretos.';
const MSG_BAD_RECOVERY = 'Não foi possível recuperar a conta com esses dados.';
const MSG_DUPLICATE = 'Já existe uma conta com esse telefone ou e-mail. Entre ou recupere o acesso.';

// ---------- Validação ----------
// Telefone brasileiro em E.164: +55 + DDD (11 a 99) + 8 ou 9 dígitos (celular de 9 dígitos começa com 9).
function normalizePhone(input) {
  let d = String(input == null ? '' : input).replace(/\D/g, '');
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  if (!/^[1-9][1-9]\d{8,9}$/.test(d)) return null;
  if (d.length === 11 && d[2] !== '9') return null;
  return '+55' + d;
}
function vPhone(input) {
  const p = normalizePhone(input);
  if (!p) bad('Informe um telefone válido com DDD, por exemplo (11) 91234-5678.', 'invalid_phone');
  return p;
}
function vName(v) {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  if (s.length < 2 || s.length > 80 || hasControlChars(s, false)) bad('Informe seu nome (2 a 80 caracteres).', 'invalid_name');
  return s;
}
function vEmail(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (s.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) || hasControlChars(s, false)) bad('E-mail inválido.', 'invalid_email');
  return s;
}
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
// Dia e mês de nascimento são opcionais, mas vêm juntos (ou os dois vazios).
function vBirth(day, month) {
  const none = v => v === undefined || v === null || v === '';
  if (none(day) && none(month)) return { day: null, month: null };
  const d = Number(day), m = Number(month);
  if (none(day) || none(month) || !Number.isInteger(d) || !Number.isInteger(m) || m < 1 || m > 12 || d < 1 || d > DAYS_IN_MONTH[m - 1]) bad('Data de nascimento inválida (informe dia e mês).', 'invalid_birth');
  return { day: d, month: m };
}

// ---------- Visão pública ----------
function customerView(row) {
  const locked = row.points_locked_until && new Date(row.points_locked_until).getTime() > Date.now();
  const iso = v => (v ? new Date(v).toISOString() : null);
  return {
    id: row.id, name: row.name, phone: row.phone, email: row.email || null,
    whatsapp_consent: !!row.whatsapp_consent, whatsapp_consent_at: iso(row.whatsapp_consent_at),
    whatsapp_opt_out_at: iso(row.whatsapp_opt_out_at), whatsapp_confirmed_at: iso(row.whatsapp_confirmed_at),
    birth_day: row.birth_day, birth_month: row.birth_month,
    points_locked_until: locked ? iso(row.points_locked_until) : null,
    security_question_id: row.security_question, security_question: auth.questionText(row.security_question),
    created_at: iso(row.created_at)
  };
}
const CUSTOMER_COLUMNS = `id, name, phone, email, whatsapp_consent, whatsapp_consent_at, whatsapp_opt_out_at, whatsapp_confirmed_at,
  birth_day, birth_month, points_locked_until, security_question, created_at`;

// ---------- Sessão (cookie __Host-dg_cliente: HttpOnly, Secure, SameSite=Lax, Path=/) ----------
const sessionCookie = token => auth.buildCookie(COOKIE_NAME, token, { maxAge: SESSION_TTL_S, sameSite: 'Lax' });
const clearSessionCookie = () => auth.buildCookie(COOKIE_NAME, '', { maxAge: 0, sameSite: 'Lax' });

async function createSession(sql, customerId, ctx = {}) {
  const token = auth.newToken();
  await sql.query(
    `insert into customer_sessions (token_hash, customer_id, expires_at, ip, ua) values ($1, $2, now() + make_interval(secs => $3::int), $4, $5)`,
    [auth.sha256(token), customerId, SESSION_TTL_S, ctx.ip || null, String(ctx.ua || '').slice(0, 200)]);
  return token;
}
const killSessions = (sql, customerId, exceptHash) =>
  sql.query('delete from customer_sessions where customer_id = $1 and token_hash <> $2', [customerId, exceptHash || '']);

// Cliente da requisição (ou null). Retorna { customer: <linha completa>, tokenHash }.
async function getSession(sql, req) {
  const token = auth.parseCookies(req && req.headers && req.headers.cookie)[COOKIE_NAME];
  if (!token || token.length > 100) return null;
  const tokenHash = auth.sha256(token);
  const [row] = await sql.query(
    `select c.* from customer_sessions s join customers c on c.id = s.customer_id
      where s.token_hash = $1 and s.expires_at > now() and c.active`, [tokenHash]);
  return row ? { customer: row, tokenHash } : null;
}

async function logout(sql, token) {
  if (typeof token === 'string' && token) await sql.query('delete from customer_sessions where token_hash = $1', [auth.sha256(token)]);
}
// Atalho para a rota: lê o cookie, encerra a sessão e devolve o Set-Cookie que limpa o cookie.
async function logoutFromRequest(sql, req) {
  const token = auth.parseCookies(req && req.headers && req.headers.cookie)[COOKIE_NAME];
  await logout(sql, token);
  return clearSessionCookie();
}

// ---------- Bloqueio por tentativas ----------
// Login e recuperação: 5 erros = 30 min (por conta e por IP) e 10 erros em 24 h = 24 h (por conta). Acerto zera a contagem.
// Scopes (migração scripts/migrate-2026-11-10-scopes.js): 'login', 'recover', 'register' (cadastro, por IP; phone = '')
// e 'password' (senha atual errada na troca de senha, phone = telefone da conta; contagem separada do login).
// LEGADO: antes da migração, cadastro e troca de senha iam para scope 'login' com chaves falsas na coluna phone
// ('#cadastro' e '#senha:+55...'). Essas linhas continuam sendo LIDAS (só lidas) dentro das mesmas janelas
// (1 h no cadastro, até 48 h na troca de senha) para não perder bloqueios em curso. Depois de 48 h do deploy,
// o código de legado pode sair. A contagem por IP do login/recuperação só olha telefone real (phone like '+%').
const LEGACY_REGISTER_KEY = '#cadastro';
const legacyPasswordKey = phone => '#senha:' + phone;

// Retorna null (livre) ou a mensagem de bloqueio (genérica). ip === null: sem limite por IP.
// legacyKey: chave antiga (scope 'login') que também conta para esta contagem, ou null.
async function lockMessage(sql, scope, phone, ip, legacyKey = null) {
  const [byPhone, byIp, now] = await Promise.all([
    sql.query(`select (extract(epoch from at) * 1000)::float8 as ms from customer_login_attempts a
                where ((scope = $1 and phone = $2) or (scope = 'login' and phone = $3::text)) and ok = false and at > now() - interval '48 hours'
                  and at > coalesce((select max(at) from customer_login_attempts
                                       where ((scope = $1 and phone = $2) or (scope = 'login' and phone = $3::text)) and ok = true), '-infinity'::timestamptz)
                order by at desc limit ${LONG_MAX_FAILS}`, [scope, phone, legacyKey]),
    ip === null ? [] : sql.query(`select (extract(epoch from at) * 1000)::float8 as ms from customer_login_attempts
                where scope = $1 and ip = $2 and phone like '+%' and ok = false and at > now() - interval '30 minutes'
                order by at desc limit 10`, [scope, ip || 'unknown']),
    sql.query(`select (extract(epoch from now()) * 1000)::float8 as ms`)
  ]);
  const nowMs = Number(now[0].ms);
  const f = rows => rows.map(r => Number(r.ms));
  if (auth.evaluateAttemptLock({ failsMs: f(byPhone), nowMs, max: LONG_MAX_FAILS, lockMs: LONG_LOCK_MS }).locked) return MSG_LOCKED_LONG;
  if (auth.evaluateAttemptLock({ failsMs: f(byPhone), nowMs, max: LOGIN_MAX_FAILS, lockMs: LOCK_MS }).locked
    || auth.evaluateAttemptLock({ failsMs: f(byIp), nowMs, max: LOGIN_MAX_FAILS, lockMs: LOCK_MS }).locked) return MSG_LOCKED;
  return null;
}
async function assertNotLocked(sql, scope, phone, ip, legacyKey = null) {
  const msg = await lockMessage(sql, scope, phone, ip, legacyKey);
  if (msg) throw new CustomerError(429, msg, 'locked');
}
const recordAttempt = (sql, scope, phone, ip, ok) =>
  sql.query('insert into customer_login_attempts (scope, phone, ip, ok) values ($1, $2, $3, $4)', [scope, phone, ip || 'unknown', ok]);

// Cadastro: tentativas deste IP na última hora (toda tentativa conta: 201, 400, 409...). Inclui as linhas antigas ('#cadastro').
async function registerAttemptsLastHour(sql, ip) {
  const [r] = await sql.query(
    `select count(*)::int as n from customer_login_attempts
      where ip = $2 and at > now() - interval '1 hour' and (scope = 'register' or (scope = 'login' and phone = $1))`,
    [LEGACY_REGISTER_KEY, ip || 'unknown']);
  return r.n;
}
const recordRegisterAttempt = (sql, ip) => recordAttempt(sql, 'register', '', ip, true);

// Troca de senha: contagem própria (não soma com o login). 5 erros = 30 min, 10 em 24 h = 24 h. Sem limite por IP (já exige sessão).
const assertPasswordNotLocked = (sql, phone) => assertNotLocked(sql, 'password', phone, null, legacyPasswordKey(phone));
const recordPasswordAttempt = (sql, phone, ip, ok) => recordAttempt(sql, 'password', phone, ip, ok);

// ---------- Consentimento ----------
async function recordConsentEvent(sql, customerId, action, { ip, source }) {
  await sql.query(
    `insert into customer_consent_events (customer_id, channel, action, text_version, source, ip) values ($1, 'whatsapp', $2, $3, $4, $5)`,
    [customerId, action, CONSENT_VERSION, String(source || 'conta').slice(0, 40), ip || null]);
}

/**
 * Cria a conta e já abre a sessão. Retorna { customer, token } (o token vai no cookie; nunca no corpo da resposta).
 * input: { name, phone, email?, password, security_question (id da lista), security_answer, whatsapp_consent (boolean, padrão false),
 *          birth_day?, birth_month? }   ctx: { ip, ua, source }
 */
async function createAccount(sql, input, ctx = {}) {
  const b = input && typeof input === 'object' ? input : {};
  const name = vName(b.name), phone = vPhone(b.phone), email = vEmail(b.email);
  const password = auth.validatePassword(b.password);
  const question = auth.validateQuestionId(b.security_question);
  const answer = auth.validateAnswer(b.security_answer); // normalizada (mín. 3 caracteres)
  const birth = vBirth(b.birth_day, b.birth_month);
  if (b.whatsapp_consent !== undefined && typeof b.whatsapp_consent !== 'boolean') bad('Consentimento inválido.', 'invalid_consent');
  const consent = b.whatsapp_consent === true; // nunca pré-marcado: só true explícito vale
  // Duplicado ANTES do scrypt: o 409 sai barato (o hash é a parte cara). O 23505 abaixo continua cobrindo corrida.
  const [dup] = await sql.query('select 1 from customers where phone = $1 or ($2::text is not null and lower(email) = $2) limit 1', [phone, email]);
  if (dup) throw new CustomerError(409, MSG_DUPLICATE, 'duplicate');
  const [answerHash, passwordHash] = await Promise.all([auth.hashPassword(answer), auth.hashPassword(password)]);
  let row;
  try {
    [row] = await sql.query(
      `insert into customers (name, phone, email, password_hash, security_question, security_answer_hash, whatsapp_consent,
                              whatsapp_consent_at, whatsapp_consent_text, whatsapp_consent_version, whatsapp_consent_ip, birth_day, birth_month)
       values ($1, $2, $3, $4, $5, $6, $7, case when $7 then now() end, case when $7 then $8::text end, case when $7 then $9::text end,
               case when $7 then $10::text end, $11, $12)
       returning ${CUSTOMER_COLUMNS}`,
      [name, phone, email, passwordHash, question, answerHash, consent, CONSENT_TEXT, CONSENT_VERSION, ctx.ip || null, birth.day, birth.month]);
  } catch (e) {
    if (e && e.code === '23505') throw new CustomerError(409, MSG_DUPLICATE, 'duplicate');
    throw e;
  }
  if (consent) await recordConsentEvent(sql, row.id, 'opt_in', { ip: ctx.ip, source: ctx.source || 'cadastro' });
  const token = await createSession(sql, row.id, ctx);
  return { customer: customerView(row), token };
}

/** Entra com telefone + senha. Retorna { customer, token }. Erros: 400 formato, 401 credenciais, 429 bloqueio. */
async function login(sql, { phone: phoneInput, password }, ctx = {}) {
  const phone = vPhone(phoneInput);
  if (typeof password !== 'string' || !password || password.length > 256) throw new CustomerError(401, MSG_BAD_LOGIN, 'bad_login');
  const ip = ctx.ip || 'unknown';
  const dummy = await auth.dummyHash();
  await assertNotLocked(sql, 'login', phone, ip);
  const [row] = await sql.query('select * from customers where phone = $1', [phone]);
  const usable = !!(row && row.active);
  const matches = await auth.verifyPassword(password, usable ? row.password_hash : dummy); // gasta o mesmo tempo sem conta
  if (!(matches && usable)) {
    await recordAttempt(sql, 'login', phone, ip, false);
    await assertNotLocked(sql, 'login', phone, ip);
    throw new CustomerError(401, MSG_BAD_LOGIN, 'bad_login');
  }
  await recordAttempt(sql, 'login', phone, ip, true);
  await sql.query('update customers set last_login_at = now() where id = $1', [row.id]);
  const token = await createSession(sql, row.id, ctx);
  await sql.query('delete from customer_sessions where expires_at < now()');
  await sql.query(`delete from customer_login_attempts where at < now() - interval '7 days'`);
  return { customer: customerView(row), token };
}

// ---------- Recuperação (telefone + resposta de segurança) ----------
/** Pergunta para a tela de recuperação. Conta inexistente recebe uma pergunta estável falsa (não revela se o telefone existe). */
async function recoveryQuestion(sql, { phone: phoneInput }) {
  const phone = vPhone(phoneInput);
  const [row] = await sql.query('select security_question from customers where phone = $1 and active', [phone]);
  const id = row ? row.security_question : auth.fakeQuestionFor('cliente', phone);
  return { question_id: id, question: auth.questionText(id) };
}

/**
 * Recupera o acesso: telefone + resposta + nova senha. 5 erros bloqueiam por 30 min (conta e IP); 10 em 24 h, por 24 h (conta).
 * Depois de recuperar: derruba todas as sessões e trava o resgate de pontos por 48 h.
 */
async function recover(sql, { phone: phoneInput, answer, new_password }, ctx = {}) {
  const phone = vPhone(phoneInput);
  const next = auth.validatePassword(new_password, 'Nova senha');
  const ip = ctx.ip || 'unknown';
  const dummy = await auth.dummyHash();
  await assertNotLocked(sql, 'recover', phone, ip);
  const [row] = await sql.query('select id, security_answer_hash, active from customers where phone = $1', [phone]);
  const usable = !!(row && row.active);
  const ok = await auth.verifyAnswer(answer, usable ? row.security_answer_hash : dummy);
  if (!(ok && usable)) {
    await recordAttempt(sql, 'recover', phone, ip, false);
    await assertNotLocked(sql, 'recover', phone, ip);
    throw new CustomerError(400, MSG_BAD_RECOVERY, 'bad_recovery');
  }
  await recordAttempt(sql, 'recover', phone, ip, true);
  const [upd] = await sql.query(
    `update customers set password_hash = $2, points_locked_until = now() + interval '${RECOVERY_POINTS_LOCK}' where id = $1 returning points_locked_until`,
    [row.id, await auth.hashPassword(next)]);
  await killSessions(sql, row.id, '');
  return { ok: true, points_locked_until: new Date(upd.points_locked_until).toISOString() };
}

// ---------- Conta logada ----------
async function getProfile(sql, customerId) {
  const [row] = await sql.query(`select ${CUSTOMER_COLUMNS} from customers where id = $1 and active`, [customerId]);
  if (!row) throw new CustomerError(404, 'Conta não encontrada.', 'not_found');
  return customerView(row);
}

async function updateProfile(sql, customerId, input) {
  const b = input && typeof input === 'object' ? input : {};
  const sets = [], params = [customerId];
  const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (b.name !== undefined) add('name', vName(b.name));
  if (b.email !== undefined) add('email', vEmail(b.email));
  if (b.birth_day !== undefined || b.birth_month !== undefined) { const bd = vBirth(b.birth_day, b.birth_month); add('birth_day', bd.day); add('birth_month', bd.month); }
  if (!sets.length) bad('Nada para alterar.');
  try {
    await sql.query(`update customers set ${sets.join(', ')} where id = $1`, params);
  } catch (e) {
    if (e && e.code === '23505') throw new CustomerError(409, 'Esse e-mail já está em uso.', 'duplicate');
    throw e;
  }
  return getProfile(sql, customerId);
}

async function changePassword(sql, customerId, { current_password, new_password }, keepTokenHash) {
  const next = auth.validatePassword(new_password, 'Nova senha');
  const [row] = await sql.query('select password_hash from customers where id = $1 and active', [customerId]);
  if (!row || !(await auth.verifyPassword(typeof current_password === 'string' ? current_password.slice(0, 256) : '', row.password_hash))) {
    throw new CustomerError(400, 'A senha atual está incorreta.', 'bad_password');
  }
  if (next === current_password) bad('A nova senha precisa ser diferente da atual.');
  await sql.query('update customers set password_hash = $2 where id = $1', [customerId, await auth.hashPassword(next)]);
  await killSessions(sql, customerId, keepTokenHash);
  return { ok: true };
}

/**
 * Troca a pergunta/resposta de segurança (exige a senha atual). Não gera códigos (só o admin usa códigos).
 */
async function changeSecurity(sql, customerId, { current_password, security_question, security_answer }) {
  const question = auth.validateQuestionId(security_question);
  const answerHash = await auth.hashAnswer(security_answer);
  const [row] = await sql.query('select password_hash from customers where id = $1 and active', [customerId]);
  if (!row || !(await auth.verifyPassword(typeof current_password === 'string' ? current_password.slice(0, 256) : '', row.password_hash))) {
    throw new CustomerError(400, 'A senha atual está incorreta.', 'bad_password');
  }
  await sql.query('update customers set security_question = $2, security_answer_hash = $3 where id = $1', [customerId, question, answerHash]);
  return { ok: true };
}

/**
 * Liga/desliga o consentimento de WhatsApp. Cada mudança grava customer_consent_events (opt_in | opt_out).
 * Sem mudança (já estava no estado pedido) não grava nada. whatsapp_confirmed_at fica para a dupla confirmação futura.
 */
async function setWhatsappConsent(sql, customerId, consent, ctx = {}) {
  if (typeof consent !== 'boolean') bad('Consentimento inválido.', 'invalid_consent');
  const [cur] = await sql.query('select whatsapp_consent from customers where id = $1 and active', [customerId]);
  if (!cur) throw new CustomerError(404, 'Conta não encontrada.', 'not_found');
  if (!!cur.whatsapp_consent === consent) return getProfile(sql, customerId);
  if (consent) {
    await sql.query(
      `update customers set whatsapp_consent = true, whatsapp_consent_at = now(), whatsapp_consent_text = $2, whatsapp_consent_version = $3,
              whatsapp_consent_ip = $4, whatsapp_confirmed_at = null where id = $1`,
      [customerId, CONSENT_TEXT, CONSENT_VERSION, ctx.ip || null]);
  } else {
    await sql.query('update customers set whatsapp_consent = false, whatsapp_opt_out_at = now() where id = $1', [customerId]);
  }
  await recordConsentEvent(sql, customerId, consent ? 'opt_in' : 'opt_out', { ip: ctx.ip, source: ctx.source || 'conta' });
  return getProfile(sql, customerId);
}

/** Pedidos do cliente (mais novos primeiro), sem telefone/endereço de outras pessoas: só os dele. */
async function listOrders(sql, customerId, { limit = 20, offset = 0 } = {}) {
  await orders.sweepOrders(sql);
  const n = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 50), off = Math.max(Number.parseInt(offset, 10) || 0, 0);
  const rows = await sql.query(
    `select public_code, items, subtotal_cents, delivery_fee_cents, discount_cents, points_redeemed, ${orders.TRACKING_COLUMNS}
       from orders where customer_id = $1 order by created_at desc, id desc limit ${n} offset ${off}`, [customerId]);
  return rows.map(r => ({
    ...orders.trackingView(r), items: r.items, subtotal_cents: r.subtotal_cents, delivery_fee_cents: r.delivery_fee_cents,
    discount_cents: r.discount_cents, points_redeemed: r.points_redeemed
  }));
}

/** Pontos: saldo, reservas, bloqueio e últimos lançamentos. */
async function getPoints(sql, customerId, { limit = 30 } = {}) {
  const [summary, history] = await Promise.all([loyalty.getBalance(sql, customerId), loyalty.listLedger(sql, customerId, limit)]);
  return { ...summary, history };
}

module.exports = {
  COOKIE_NAME, SESSION_TTL_S, CONSENT_VERSION, CONSENT_TEXT, CustomerError, MSG_LOCKED, MSG_LOCKED_LONG,
  registerAttemptsLastHour, recordRegisterAttempt, assertPasswordNotLocked, recordPasswordAttempt,
  SECURITY_QUESTIONS: auth.SECURITY_QUESTIONS,
  normalizePhone, customerView, sessionCookie, clearSessionCookie,
  createAccount, login, logout, logoutFromRequest, getSession, recoveryQuestion, recover,
  getProfile, updateProfile, changePassword, changeSecurity, setWhatsappConsent, listOrders, getPoints, killSessions
};
