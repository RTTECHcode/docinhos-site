'use strict';
/*
 * Segurança de conta compartilhada entre api/admin.js e api/_lib/customer.js (pasta _lib não vira função na Vercel).
 * Senhas, respostas de segurança e códigos de recuperação só existem em hash (crypto.scrypt nativo, sem dependências).
 * Decisões em docs/planos/decisoes.md (O9).
 */
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scryptAsync = promisify(crypto.scrypt);

const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, keylen: 64 };

class AuthError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code || null; }
}
const bad = (message, code) => { throw new AuthError(400, message, code); };

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

// ---------- Hash scrypt ----------
async function derive(password, salt, N, r, p, keylen) {
  return scryptAsync(String(password).normalize('NFKC'), salt, keylen, { N, r, p, maxmem: 128 * N * r * 2 + 1048576 });
}
async function hashPassword(password) {
  const { N, r, p, keylen } = SCRYPT_PARAMS;
  const salt = crypto.randomBytes(16);
  const dk = await derive(password, salt, N, r, p, keylen);
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${dk.toString('base64')}`;
}
async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  if (![N, r, p].every(Number.isInteger) || N < 1024 || N > 131072 || (N & (N - 1)) !== 0 || r < 1 || r > 16 || p < 1 || p > 4) return false;
  const expected = Buffer.from(parts[5], 'base64');
  if (!expected.length) return false;
  const dk = await derive(password, Buffer.from(parts[4], 'base64'), N, r, p, expected.length);
  return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
}
let dummyHashPromise = null; // gasta o mesmo tempo quando a conta não existe (não vaza existência pelo tempo)
const dummyHash = () => (dummyHashPromise ||= hashPassword(crypto.randomBytes(12).toString('hex')));

function validatePassword(v, label = 'Senha') {
  if (typeof v !== 'string' || v.length < 8 || v.length > 128) bad(`${label}: use de 8 a 128 caracteres.`);
  return v;
}

// ---------- Pergunta e resposta de segurança ----------
// Lista fixa. Nada de "nome da mãe" ou "cidade natal" (respostas públicas). O id é o que fica no banco.
const SECURITY_QUESTIONS = [
  { id: 'prof_favorito', text: 'Qual era o nome do seu professor ou professora favorito(a) na escola?' },
  { id: 'primeiro_celular', text: 'Qual era a marca e o modelo do seu primeiro celular?' },
  { id: 'apelido_familia', text: 'Qual era o apelido que só a sua família usava para você?' },
  { id: 'primeiro_show', text: 'Qual foi o primeiro show ou festa a que você foi?' },
  { id: 'melhor_amigo', text: 'Qual era o nome do seu melhor amigo ou amiga de infância?' },
  { id: 'primeiro_prato', text: 'Qual foi o primeiro prato que você aprendeu a cozinhar?' },
  { id: 'primeiro_livro', text: 'Qual foi o primeiro livro de que você gostou muito?' },
  { id: 'primeiro_emprego', text: 'Qual era o nome do seu primeiro chefe ou da sua primeira empresa?' }
];
const QUESTION_IDS = SECURITY_QUESTIONS.map(q => q.id);
const questionText = id => (SECURITY_QUESTIONS.find(q => q.id === id) || {}).text || null;

const MIN_ANSWER_LEN = 3;
// minúsculas, sem acento, trim e espaços colapsados
function normalizeAnswer(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim().replace(/\s+/g, ' ');
}
function validateQuestionId(id) {
  if (typeof id !== 'string' || !QUESTION_IDS.includes(id)) bad('Escolha uma das perguntas de segurança da lista.', 'invalid_question');
  return id;
}
// Retorna a resposta normalizada ou lança AuthError 400.
function validateAnswer(answer) {
  if (typeof answer !== 'string' || answer.length > 200) bad('Informe a resposta de segurança (mínimo 3 caracteres).', 'invalid_answer');
  const n = normalizeAnswer(answer);
  if (n.length < MIN_ANSWER_LEN) bad('A resposta de segurança precisa ter pelo menos 3 caracteres.', 'invalid_answer');
  return n;
}
const hashAnswer = answer => hashPassword(validateAnswer(answer));
async function verifyAnswer(answer, stored) {
  if (typeof answer !== 'string' || answer.length > 200) return false;
  const n = normalizeAnswer(answer);
  if (n.length < MIN_ANSWER_LEN) return false;
  return verifyPassword(n, stored);
}

// Pergunta "falsa" estável para contas inexistentes: a tela de recuperação responde igual para qualquer usuário.
function fakeQuestionFor(scope, identifier) {
  const key = sha256(String(process.env.DATABASE_URL || 'dg-pergunta-falsa'));
  const h = crypto.createHmac('sha256', key).update(`${scope}:${String(identifier)}`).digest();
  return SECURITY_QUESTIONS[h.readUInt32BE(0) % SECURITY_QUESTIONS.length].id;
}

// ---------- Códigos de recuperação (admin) ----------
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sem I, L, O, 0, 1
const CODE_LEN = 12;
const RECOVERY_CODE_COUNT = 10;
function randomCode() {
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return out;
}
const formatRecoveryCode = raw => raw.match(/.{1,4}/g).join('-');
const normalizeRecoveryCode = input => String(input == null ? '' : input).toUpperCase().replace(/[^A-Z0-9]/g, '');
// Retorna [{ code: 'ABCD-EFGH-JKMN', hash }]. O texto puro só pode ser mostrado uma vez.
async function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  const raws = Array.from({ length: count }, randomCode);
  const hashes = await Promise.all(raws.map(hashPassword));
  return raws.map((raw, i) => ({ code: formatRecoveryCode(raw), hash: hashes[i] }));
}
// candidates: [{ id, code_hash }] (só os não usados). Retorna o id do código que confere, ou null.
async function matchRecoveryCode(input, candidates) {
  const n = normalizeRecoveryCode(input);
  if (n.length !== CODE_LEN || !candidates.length) return null;
  const results = await Promise.all(candidates.map(c => verifyPassword(n, c.code_hash)));
  const i = results.findIndex(Boolean);
  return i >= 0 ? candidates[i].id : null;
}

// ---------- Bloqueio por tentativas (função pura) ----------
// failsMs: instantes (ms) das falhas desde o último sucesso, da mais nova para a mais antiga.
// Bloqueia quando há `max` falhas dentro de `lockMs` contadas a partir da falha mais recente;
// o bloqueio dura `lockMs` a contar dessa falha mais recente.
function evaluateAttemptLock({ failsMs, nowMs, max, lockMs }) {
  const f = failsMs || [];
  if (f.length < max) return { locked: false, until: null };
  const newest = f[0];
  const inWindow = f.filter(t => t > newest - lockMs).length;
  if (inWindow >= max && nowMs < newest + lockMs) return { locked: true, until: newest + lockMs };
  return { locked: false, until: null };
}

// ---------- HTTP ----------
// IP do cliente. Na Vercel, x-real-ip é preenchido pela própria plataforma (o cliente não consegue forjar);
// o primeiro valor do x-forwarded-for fica só como reserva (fora da Vercel, ex.: servidor local).
function clientIp(req) {
  const h = (req && req.headers) || {};
  const real = typeof h['x-real-ip'] === 'string' ? h['x-real-ip'].trim() : '';
  const xf = h['x-forwarded-for'];
  const first = typeof xf === 'string' ? xf.split(',')[0].trim() : '';
  return (real || first || (req && req.socket && req.socket.remoteAddress) || 'unknown').slice(0, 64);
}
function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
// CSRF: requisição mutável precisa de Origin igual ao Host e não pode vir de outro site.
function sameOrigin(req) {
  const origin = req.headers.origin, host = req.headers.host;
  if (!origin || !host) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  try { return new URL(origin).host === host; } catch { return false; }
}
const isJsonType = req => /^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''));
function buildCookie(name, value, { maxAge, sameSite = 'Strict' }) {
  return `${name}=${value}; HttpOnly; Secure; SameSite=${sameSite}; Path=/; Max-Age=${maxAge}`;
}

module.exports = {
  AuthError, SCRYPT_PARAMS, sha256, newToken,
  hashPassword, verifyPassword, dummyHash, validatePassword,
  SECURITY_QUESTIONS, QUESTION_IDS, questionText, normalizeAnswer, validateQuestionId, validateAnswer, hashAnswer, verifyAnswer, fakeQuestionFor,
  RECOVERY_CODE_COUNT, generateRecoveryCodes, matchRecoveryCode, normalizeRecoveryCode,
  evaluateAttemptLock, clientIp, parseCookies, buildCookie, sameOrigin, isJsonType
};
