'use strict';
/*
 * Painel /admin do Docinhos da Gigi — roteador único (uma só função serverless).
 * Ação em `?a=<acao>` (ou `a` no corpo JSON). Leituras = GET, mutações = POST (JSON).
 *
 * Segurança (resumo): sessão por cookie HttpOnly/Secure/SameSite=Strict (só o SHA-256 do token vai ao banco),
 * scrypt para senhas, anti força bruta por usuário e por IP, checagem de Origin/Host + Content-Type JSON
 * em toda requisição POST, SQL sempre parametrizado, entradas validadas e limitadas.
 *
 * A "caixa de comandos" (parseCommand) NÃO usa IA/LLM: são regras determinísticas em português
 * (normalização, verbos, casamento aproximado por tokens/prefixo/Levenshtein). Custo zero de tokens.
 */
const crypto = require('node:crypto');
const ordersLib = require('./_lib/orders');
const storeHours = require('./_lib/store-hours');
const shipping = require('./_lib/shipping');
const loyalty = require('./_lib/loyalty');

const SESSION_COOKIE = '__Host-dg_admin';
const SESSION_TTL_MS = 12 * 3600 * 1000;
const SESSION_TTL_S = 12 * 3600;
const MAX_INT4 = 2147483647;
const MAX_CENTS = 1000000; // R$ 10.000,00
const MAX_IMAGE_BYTES = 2000000;
const MAX_IMAGE_B64 = 2800000;
// Status de preparo (O6): regras e rótulos em api/_lib/orders.js. 'delivered' (painel antigo) vale como 'completed'.
const FILTER_STATUSES = [...ordersLib.STATUSES, 'delivered'];
const HISTORY_PAGE_MAX = 100;
const DEFAULT_SETTINGS = {
  store_address: 'Manoel Hare Peralta, 101',
  delivery_fee_cents: '0',
  store_paused: '0',
  store_paused_message: 'Estamos com os pedidos pausados no momento. Volte em instantes!',
  default_pause_label: 'volto logo <3'
};

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = message => { throw new HttpError(400, message); };
const { hasControlChars } = require('./_lib/validate');
const getSql = () => require('./_lib/db'); // carregado sob demanda: funções puras testáveis sem DATABASE_URL
const q = (text, params = []) => getSql().query(text, params);

// ---------- Senhas (scrypt): vivem em api/_lib/auth.js, compartilhadas com a conta do cliente ----------
const auth = require('./_lib/auth');
const { hashPassword, verifyPassword, dummyHash, sha256 } = auth;

// ---------- Anti força bruta (função pura) ----------
// failsMs: instantes (ms) das falhas do usuário desde o último login ok, da mais nova para a mais antiga (até 10).
function evaluateLock({ failsMs, ipFails, nowMs }) {
  const MIN15 = 15 * 60 * 1000, H24 = 24 * 3600 * 1000;
  const f = failsMs || [];
  if (f.length >= 10 && nowMs - f[9] < H24) return { locked: true, reason: '24h', until: f[9] + H24 };
  if (f.length >= 5 && f[0] - f[4] <= MIN15 && nowMs - f[0] < MIN15) return { locked: true, reason: '15m', until: f[0] + MIN15 };
  if (ipFails >= 20) return { locked: true, reason: 'ip', until: null };
  return { locked: false, reason: null, until: null };
}

// ---------- Validadores ----------
function vId(v, label = 'Identificador') {
  if (!Number.isInteger(v) || v < 1 || v > MAX_INT4) bad(`${label} inválido.`);
  return v;
}
function vInt(v, min, max, label) {
  if (!Number.isInteger(v) || v < min || v > max) bad(`${label}: informe um número inteiro de ${min} a ${max}.`);
  return v;
}
function vStr(v, min, max, label, { multiline = false } = {}) {
  if (typeof v !== 'string') bad(`${label} inválido.`);
  const s = v.trim();
  if (hasControlChars(s, multiline)) bad(`${label} contém caracteres inválidos.`);
  if (s.length < min || s.length > max) bad(min > 0 ? `${label}: use de ${min} a ${max} caracteres.` : `${label}: use até ${max} caracteres.`);
  return s;
}
function vBool(v, label) {
  if (typeof v !== 'boolean') bad(`${label} inválido.`);
  return v;
}
function vCents(v, label, nullable = false) {
  if (nullable && (v === null || v === '')) return null;
  if (!Number.isInteger(v) || v < 0 || v > MAX_CENTS) bad(`${label}: informe um valor de R$ 0,00 a R$ ${(MAX_CENTS / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}.`);
  return v;
}
function vEnum(v, list, label) {
  if (typeof v !== 'string' || !list.includes(v)) bad(`${label} inválido.`);
  return v;
}
function vUsername(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!/^[a-z0-9._-]{3,32}$/.test(s)) bad('Usuário inválido (3 a 32 letras minúsculas, números, ponto, hífen ou sublinhado).');
  return s;
}
function vPassword(v, label = 'Senha') {
  if (typeof v !== 'string' || v.length < 8 || v.length > 128) bad(`${label}: use de 8 a 128 caracteres.`);
  return v;
}
function vKey(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!/^[a-z0-9_-]{1,40}$/.test(s)) bad('Chave inválida (use letras minúsculas, números, hífen ou sublinhado).');
  return s;
}

// Valida só os campos presentes (spec: campo -> função validadora). Ao criar, os obrigatórios precisam existir.
function pickFields(body, spec, required = []) {
  const out = {};
  for (const [field, fn] of Object.entries(spec)) {
    if (Object.prototype.hasOwnProperty.call(body, field) && body[field] !== undefined) out[field] = fn(body[field]);
  }
  return { out, missing: required.filter(f => !(f in out)) };
}

// ---------- Imagem: assinatura (magic bytes) ----------
function detectImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('latin1', 4, 8) === 'ftyp' && ['avif', 'avis'].includes(buf.toString('latin1', 8, 12))) return 'image/avif';
  return null;
}
function decodeImage(b64) {
  if (typeof b64 !== 'string' || b64.length < 16 || b64.length > MAX_IMAGE_B64) bad('Imagem inválida ou grande demais (máximo 2 MB).');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) bad('Imagem inválida.');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > MAX_IMAGE_BYTES) bad('A imagem passa de 2 MB.');
  const mime = detectImage(buf);
  if (!mime) bad('Formato de imagem não suportado (use JPEG, PNG, WebP ou AVIF).');
  return { buf, mime };
}

// ---------- Caixa de comandos em português (regras determinísticas, SEM IA/LLM) ----------
const PAUSE_VERBS = new Set(['pausar', 'pausa', 'pause', 'desativar', 'desativa', 'desative', 'tirar', 'tira', 'tire', 'retirar', 'retira',
  'acabou', 'acabar', 'acabaram', 'acaba', 'esgotou', 'esgotar', 'esgotado', 'esgotaram', 'fora', 'falta', 'faltou', 'sem', 'remover',
  'ocultar', 'esconder', 'fechar', 'fecha', 'feche', 'desligar', 'desliga', 'parar', 'suspender']);
const RESUME_VERBS = new Set(['reativar', 'reativa', 'reative', 'ativar', 'ativa', 'ative', 'voltar', 'volta', 'voltou', 'tem', 'temos',
  'liberar', 'libera', 'libere', 'abrir', 'abre', 'abra', 'reabrir', 'reabre', 'ligar', 'liga', 'repor', 'chegou', 'chegaram', 'disponivel']);
const STOP = new Set(['o', 'a', 'os', 'as', 'de', 'do', 'da', 'dos', 'das', 'um', 'uma', 'uns', 'umas', 'pra', 'para', 'por', 'com', 'e',
  'que', 'ja', 'agora', 'favor', 'pode', 'ai', 'la', 'mais', 'em', 'no', 'na', 'nos', 'nas', 'meu', 'minha', 'nosso', 'nossa']);
const SPLITTERS = new Set(['no', 'na', 'nos', 'nas', 'em']);
const ALL_WORDS = new Set(['todos', 'todas', 'todo', 'toda', 'tudo']);
const SCOPE_WORDS = {
  produto: 'product', produtos: 'product', complemento: 'complement', complementos: 'complement', adicional: 'complement',
  adicionais: 'complement', extra: 'complement', extras: 'complement', categoria: 'category', categorias: 'category',
  secao: 'category', secoes: 'category'
};
const KIND_WORD = { product: 'produto', complement: 'complemento', category: 'categoria' };
const KIND_LABEL = { product: 'Produto', complement: 'Complemento', category: 'Categoria', link: 'Complemento no produto', store: 'Loja' };
const HELP_EXAMPLES = ['pausar nutella', 'acabou o kitkat no monte seu copo', 'pausar todos os geladinhos', 'reativar brigadeiro de oreo', 'fechar a loja', 'abrir a loja'];

const { norm, words, stem } = require('./_lib/text');
const nameTokens = name => words(name).filter(w => !STOP.has(w)).map(stem);

// Distância de edição com troca de letras vizinhas contando 1 ("pasuar" -> "pausar").
function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}
// Similaridade entre uma palavra digitada e uma palavra do nome: exata, prefixo ou erro de digitação leve.
function tokenSim(qt, nt) {
  if (qt === nt) return 1;
  if (qt.length >= 3 && nt.startsWith(qt)) return 0.9;
  if (nt.length >= 3 && qt.startsWith(nt) && nt.length >= qt.length - 2) return 0.85;
  if (qt.length >= 4 && nt.length >= 4) {
    const d = lev(qt, nt);
    if (d <= 1) return 0.8;
    if (qt.length >= 8 && d <= 2) return 0.7;
  }
  return 0;
}
// Retorna null se alguma palavra digitada não casa com o nome; senão { cov, nameCov, exact, score }.
function scoreEntity(qTokens, nTokens) {
  if (!nTokens.length) return null;
  let sum = 0, all = true;
  const used = new Set();
  for (const qt of qTokens) {
    let best = 0, bi = -1;
    nTokens.forEach((nt, i) => { const s = tokenSim(qt, nt); if (s > best) { best = s; bi = i; } });
    if (best === 0) all = false; else { sum += best; used.add(bi); }
  }
  let cov = all ? sum / qTokens.length : 0;
  const compact = qTokens.join('');
  if (!all && compact.length >= 4 && nTokens.join('').includes(compact)) { all = true; cov = 0.8; for (let i = 0; i < nTokens.length; i++) used.add(i); }
  if (!all) return null;
  const nameCov = used.size / nTokens.length;
  const a = [...new Set(qTokens)].sort().join('|'), b = [...new Set(nTokens)].sort().join('|');
  return { cov, nameCov, exact: a === b, score: cov * 0.6 + nameCov * 0.4 };
}

// Decide, entre os candidatos de um tipo, quais o usuário quis dizer.
// Retorna { kind: 'none' | 'one' | 'many', items: [{ type, ent, s }] }.
function resolveEntities(qTokens, pools, allFlag) {
  const cands = [];
  for (const [type, list] of pools) {
    for (const ent of list) {
      const s = scoreEntity(qTokens, nameTokens(ent.name));
      if (s) cands.push({ type, ent, s });
    }
  }
  if (!cands.length) return { kind: 'none', items: [] };
  cands.sort((a, b) => b.s.score - a.s.score || a.ent.name.localeCompare(b.ent.name));
  if (allFlag) return { kind: 'one', items: cands };
  const exacts = cands.filter(c => c.s.exact);
  if (exacts.length === 1) return { kind: 'one', items: exacts };
  if (exacts.length > 1) return { kind: 'many', items: exacts };
  if (cands.length === 1) return { kind: 'one', items: cands };
  if (cands[0].s.score - cands[1].s.score >= 0.15 && cands[0].s.cov >= 0.9) return { kind: 'one', items: [cands[0]] };
  return { kind: 'many', items: cands };
}

const MAX_CANDIDATES = 12;
function toTarget(type, ent, to, extra = {}) {
  return { type, id: ent.id, name: ent.name, from: type === 'link' ? extra.from : ent.active, to, ...extra };
}

/**
 * parseCommand(text, catalog) -> resultado puro, sem acesso ao banco.
 * catalog = { products:[{id,name,active,category_id}], complements:[{id,name,active}], categories:[{id,name,active}],
 *             links:[{product_id,complement_id,paused}], storePaused:boolean }
 * "available" (ligado) = ativo / não pausado. Pausar => to=false; reativar => to=true.
 * Resultados: { ok:true, action, targets, skipped } | { ok:false, kind:'ambiguous', action, candidates, message }
 *           | { ok:false, kind:'unknown'|'notfound', message, examples }
 */
function parseCommand(text, catalog) {
  const raw = typeof text === 'string' ? text.slice(0, 200) : '';
  const tokens = words(raw);
  const unknown = message => ({ ok: false, kind: 'unknown', message, examples: HELP_EXAMPLES });
  if (!tokens.length) return unknown('Escreva o que deseja fazer.');

  // 1) verbo (primeira ocorrência; se não houver, tolera erro de digitação no 1º termo)
  let vi = tokens.findIndex(t => PAUSE_VERBS.has(t) || RESUME_VERBS.has(t));
  if (vi < 0 && tokens[0].length >= 5) {
    const all = [...PAUSE_VERBS, ...RESUME_VERBS].filter(v => v.length >= 5);
    const hit = all.find(v => lev(tokens[0], v) <= 1);
    if (hit) { tokens[0] = hit; vi = 0; }
  }
  if (vi < 0) return unknown('Não entendi o que fazer. Use um verbo como pausar, acabou, reativar ou voltou.');
  const action = PAUSE_VERBS.has(tokens[vi]) ? 'pause' : 'resume';
  const to = action === 'resume';
  const rest = tokens.filter((_, i) => i !== vi);

  // 2) a loja inteira
  if (rest.some(t => t === 'loja' || t === 'lojinha')) {
    const open = !catalog.storePaused;
    if (open === to) return { ok: true, action, targets: [], skipped: 1, note: to ? 'A loja já está aberta.' : 'A loja já está pausada.' };
    return { ok: true, action, targets: [{ type: 'store', id: 0, name: 'Loja inteira', from: open, to }], skipped: 0 };
  }

  // 3) escopo explícito (produto/complemento/categoria) e palavra "todos"
  let scope = null, allFlag = false;
  const body = [];
  for (const t of rest) {
    if (SCOPE_WORDS[t] && !scope) scope = SCOPE_WORDS[t];
    else if (ALL_WORDS.has(t)) allFlag = true;
    else body.push(t);
  }
  const poolsFor = types => types.map(t => [t, t === 'product' ? catalog.products : t === 'complement' ? catalog.complements : catalog.categories]);
  const typesAllowed = scope ? [scope] : ['product', 'complement', 'category'];
  const qOf = list => list.filter(t => !STOP.has(t)).map(stem);

  // 4) complemento dentro de um produto: "acabou o kitkat no monte seu copo"
  const linkOf = (cid, pid) => catalog.links.find(l => l.complement_id === cid && l.product_id === pid);
  for (let i = 1; i < body.length - 1; i++) {
    const w = body[i];
    const isSplit = SPLITTERS.has(w) || (['de', 'do', 'da'].includes(w) && ALL_WORDS.has(rest[rest.indexOf(w) + 1] || ''));
    if (!isSplit) continue;
    const qL = qOf(body.slice(0, i));
    const rightRaw = rest.slice(rest.lastIndexOf(w) + 1);
    const rightAll = rightRaw.some(t => ALL_WORDS.has(t));
    const qR = qOf(rightRaw.filter(t => !ALL_WORDS.has(t) && !SCOPE_WORDS[t]));
    if (!qL.length) continue;
    const comps = resolveEntities(qL, poolsFor(['complement']), false);
    if (comps.kind === 'none') continue;
    const prods = qR.length ? resolveEntities(qR, poolsFor(['product']), rightAll) : { kind: rightAll ? 'one' : 'none', items: rightAll ? catalog.products.map(ent => ({ type: 'product', ent })) : [] };
    if (prods.kind === 'none') return { ok: false, kind: 'notfound', message: 'Não encontrei esse produto no cardápio.', examples: HELP_EXAMPLES };
    const pairs = [];
    for (const c of comps.items) for (const p of prods.items) {
      const l = linkOf(c.ent.id, p.ent.id);
      if (l) pairs.push({ c: c.ent, p: p.ent, l });
    }
    if (!pairs.length) return { ok: false, kind: 'notfound', message: 'Esse complemento não está vinculado a esse produto.', examples: HELP_EXAMPLES };
    const mk = x => ({ type: 'link', id: x.c.id, productId: x.p.id, name: `${x.c.name} em ${x.p.name}`, from: !x.l.paused, to });
    const ambiguous = (comps.kind === 'many' || (prods.kind === 'many' && !rightAll)) && pairs.length > 1;
    if (ambiguous) return { ok: false, kind: 'ambiguous', action, message: 'Encontrei mais de uma opção. Escolha:', candidates: pairs.slice(0, MAX_CANDIDATES).map(mk) };
    const targets = pairs.map(mk).filter(t => t.from !== to);
    return { ok: true, action, targets, skipped: pairs.length - targets.length };
  }

  // 5) "pausar tudo" / "pausar todos os complementos" sem nome
  const qAll = qOf(body);
  if (!qAll.length) {
    if (!allFlag && !scope) return unknown('Diga o que pausar ou reativar. Veja os exemplos:');
    const type = scope || 'product';
    const list = type === 'product' ? catalog.products : type === 'complement' ? catalog.complements : catalog.categories;
    const targets = list.filter(e => e.active !== to).map(e => toTarget(type, e, to));
    return { ok: true, action, targets, skipped: list.length - targets.length };
  }

  // 6) produto, complemento ou categoria pelo nome
  const res = resolveEntities(qAll, poolsFor(typesAllowed), allFlag);
  if (res.kind === 'none') return { ok: false, kind: 'notfound', message: 'Não encontrei nada com esse nome no cardápio.', examples: HELP_EXAMPLES };
  if (res.kind === 'many') {
    return { ok: false, kind: 'ambiguous', action, message: 'Encontrei mais de uma opção. Escolha:',
      candidates: res.items.slice(0, MAX_CANDIDATES).map(c => toTarget(c.type, c.ent, to)) };
  }
  let items = res.items;
  if (allFlag && !scope) {
    // "todos os geladinhos": prefere produtos; só usa complementos/categorias se não houver produto
    for (const t of ['product', 'complement', 'category']) {
      const only = items.filter(c => c.type === t);
      if (only.length) { items = only; break; }
    }
  }
  const targets = items.map(c => toTarget(c.type, c.ent, to)).filter(t => t.from !== to);
  return { ok: true, action, targets, skipped: items.length - targets.length };
}

// ---------- HTTP, sessão e anti força bruta ----------
const MSG_LOCKED = 'Muitas tentativas. Tente mais tarde.';
const MSG_BAD_LOGIN = 'Usuário ou senha incorretos.';

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}
function baseHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}
function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  const first = typeof xf === 'string' ? xf.split(',')[0].trim() : '';
  return (first || (req.socket && req.socket.remoteAddress) || 'unknown').slice(0, 64);
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
const sessionCookie = token => `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_S}`;
const clearCookie = () => `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;

// CSRF: toda requisição mutável precisa de Origin igual ao Host (e não pode vir de outro site).
function sameOrigin(req) {
  const origin = req.headers.origin, host = req.headers.host;
  if (!origin || !host) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  try { return new URL(origin).host === host; } catch { return false; }
}
const isJsonType = req => /^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''));

async function audit(username, action, detail) {
  try {
    await q('insert into admin_audit (username, action, detail) values ($1, $2, $3)',
      [username ? String(username).slice(0, 64) : null, action, detail ? String(detail).slice(0, 500) : null]);
  } catch (error) { console.error('Falha ao gravar auditoria:', error.message); }
}

async function lockStatus(username, ip) {
  const [fails, ipRows, nowRows] = await Promise.all([
    q(`select (extract(epoch from at) * 1000)::float8 as ms from login_attempts
        where username = $1 and ok = false and at > now() - interval '24 hours'
          and at > coalesce((select max(at) from login_attempts where username = $1 and ok = true), '-infinity'::timestamptz)
        order by at desc limit 10`, [username]),
    q(`select count(*)::int as n from login_attempts where ip = $1 and ok = false and at > now() - interval '15 minutes'`, [ip]),
    q(`select (extract(epoch from now()) * 1000)::float8 as ms`)
  ]);
  return evaluateLock({ failsMs: fails.map(r => Number(r.ms)), ipFails: ipRows[0].n, nowMs: Number(nowRows[0].ms) });
}
const recordAttempt = (username, ip, ok) =>
  q('insert into login_attempts (username, ip, ok) values ($1, $2, $3)', [String(username).slice(0, 64), ip, ok]);

async function createSession(userId, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  const ua = String(req.headers['user-agent'] || '').slice(0, 200);
  await q(`insert into admin_sessions (token_hash, user_id, expires_at, ip, ua)
           values ($1, $2, now() + make_interval(secs => $3::int), $4, $5)`, [sha256(token), userId, SESSION_TTL_S, clientIp(req), ua]);
  return token;
}

async function authenticate(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token || token.length > 100) return null;
  const tokenHash = sha256(token);
  const rows = await q(
    `select u.id, u.username, u.role, u.weak_password, (u.security_answer_hash is null) as needs_security
       from admin_sessions s join admin_users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now() and s.created_at > now() - interval '7 days' and u.active`, [tokenHash]);
  if (!rows[0]) return null;
  // Renovação deslizante: só grava se já passaram 30 min desde a última renovação.
  await q(`update admin_sessions set expires_at = now() + make_interval(secs => $2::int)
            where token_hash = $1 and expires_at < now() + make_interval(secs => $3::int)`, [tokenHash, SESSION_TTL_S, SESSION_TTL_S - 1800]);
  const u = rows[0];
  return { id: u.id, username: u.username, role: u.role, weak: u.weak_password, needsSecurity: !!u.needs_security, token, tokenHash, ip: clientIp(req) };
}

async function doLogin(req, res, body) {
  const username = typeof body.username === 'string' ? body.username.trim().toLowerCase().slice(0, 64) : '';
  const password = typeof body.password === 'string' ? body.password.slice(0, 256) : '';
  if (!username || !password) return send(res, 400, { error: 'Informe usuário e senha.' });
  const ip = clientIp(req);
  const dummy = await dummyHash();
  if ((await lockStatus(username, ip)).locked) return send(res, 429, { error: MSG_LOCKED });

  const user = (await q('select id, username, password_hash, role, weak_password, active, security_answer_hash from admin_users where username = $1', [username]))[0];
  const usable = !!(user && user.active);
  // scrypt roda sempre (mesmo sem usuário) para não vazar existência pelo tempo de resposta.
  const matches = await verifyPassword(password, usable ? user.password_hash : dummy);
  if (!(matches && usable)) {
    await recordAttempt(username, ip, false);
    await audit(username, 'login_falhou', 'ip ' + ip);
    if ((await lockStatus(username, ip)).locked) return send(res, 429, { error: MSG_LOCKED });
    return send(res, 401, { error: MSG_BAD_LOGIN });
  }
  await recordAttempt(username, ip, true);
  const token = await createSession(user.id, req);
  await q('update admin_users set last_login_at = now() where id = $1', [user.id]);
  await audit(username, 'login_ok', 'ip ' + ip);
  // Limpeza oportunista de dados antigos.
  await q(`delete from admin_sessions where expires_at < now()`);
  await q(`delete from login_attempts where at < now() - interval '7 days'`);
  res.setHeader('Set-Cookie', sessionCookie(token));
  return send(res, 200, { ok: true, user: { username: user.username, role: user.role, weakPassword: user.weak_password, needsSecurity: !user.security_answer_hash } });
}

// ---------- Helpers de banco ----------
// Os nomes de colunas vêm sempre das chaves fixas dos specs (nunca do cliente); valores vão por parâmetro.
function buildUpdate(table, fields, id) {
  const cols = Object.keys(fields);
  if (!cols.length) bad('Nada para alterar.');
  const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
  return q(`update ${table} set ${sets} where id = $${cols.length + 1} returning *`, [...cols.map(c => fields[c]), id]);
}
function buildInsert(table, fields) {
  const cols = Object.keys(fields);
  return q(`insert into ${table} (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning *`, cols.map(c => fields[c]));
}
async function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of await q('select key, value from settings')) if (r.key in DEFAULT_SETTINGS) out[r.key] = r.value;
  return out;
}
const publicSettings = s => ({ storeAddress: s.store_address, deliveryFeeCents: Number(s.delivery_fee_cents) || 0,
  storePaused: s.store_paused === '1', storePausedMessage: s.store_paused_message, defaultPauseLabel: s.default_pause_label });
const setSetting = (key, value) => q('insert into settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', [key, String(value)]);
async function getPinned() {
  const r = await q(`select value from settings where key = 'pinned_complements'`);
  try { const a = JSON.parse(r[0] ? r[0].value : '[]'); return Array.isArray(a) ? a.filter(Number.isInteger).slice(0, 50) : []; } catch { return []; }
}
const own = (rows, notFound) => { if (!rows[0]) throw new HttpError(404, notFound); return rows[0]; };
const imageIdOf = path => { const m = /^\/api\/img\?id=(\d{1,10})$/.exec(String(path || '')); return m ? Number(m[1]) : null; };

const PRODUCT_SPEC = {
  name: v => vStr(v, 1, 120, 'Nome'), description: v => vStr(v, 0, 500, 'Descrição', { multiline: true }),
  price_cents: v => vCents(v, 'Preço', true), category_id: v => vId(v, 'Categoria'),
  sort_order: v => vInt(v, 0, 100000, 'Ordem'), active: v => vBool(v, 'Ativo')
};
const CATEGORY_SPEC = { name: v => vStr(v, 1, 60, 'Nome'), sort_order: v => vInt(v, 0, 100000, 'Ordem'), active: v => vBool(v, 'Ativo') };
const COMPLEMENT_SPEC = {
  name: v => vStr(v, 1, 80, 'Nome'), price_cents: v => vCents(v, 'Preço'),
  kind: v => vEnum(v, ['size', 'additional'], 'Tipo'), active: v => vBool(v, 'Ativo')
};
const GROUP_SPEC = {
  key: vKey, label: v => vStr(v, 1, 80, 'Título do grupo'), min_choices: v => vInt(v, 0, 50, 'Mínimo'),
  max_choices: v => vInt(v, 1, 50, 'Máximo'), sort_order: v => vInt(v, 0, 100000, 'Ordem')
};

async function saveEntity({ table, spec, required, body, label, extra }) {
  const { out, missing } = pickFields(body, spec, required);
  if (body.id === undefined || body.id === null) {
    if (missing.length) bad('Preencha os campos obrigatórios.');
    return { created: true, row: (await buildInsert(table, { ...out, ...(extra || {}) }))[0] };
  }
  const id = vId(body.id);
  return { created: false, row: own(await buildUpdate(table, out, id), `${label} não encontrado.`) };
}

// ---------- Ações: catálogo ----------
const A = {}; // nome -> { m: 'GET'|'POST', role?: 'admin', fn(ctx) }

A.me = { m: 'GET', fn: async ({ user }) => ({ user: { username: user.username, role: user.role, weakPassword: user.weak, needsSecurity: user.needsSecurity } }) };

A.catalog = { m: 'GET', fn: async () => {
  const [categories, products, complements, links, groups, pinned, settings] = await Promise.all([
    q('select id, name, sort_order, active from categories order by sort_order, id'),
    q('select id, category_id, name, description, price_cents, image_path, active, sort_order, paused, pause_label from products order by sort_order, name'),
    q(`select c.id, c.name, c.price_cents, c.kind, c.active,
              (select count(*) from product_complements pc where pc.complement_id = c.id)::int as uses
         from complements c order by uses desc, c.name`),
    q('select product_id, complement_id, max_quantity, group_id, paused from product_complements'),
    q('select id, product_id, key, label, min_choices, max_choices, sort_order from product_groups order by product_id, sort_order, id'),
    getPinned(), getSettings()
  ]);
  return { categories, products, complements, links, groups, pinned, settings: publicSettings(settings), storeState: await storeHours.getStoreState(getSql()) };
} };

A.category_save = { m: 'POST', fn: async ({ body, user }) => {
  const r = await saveEntity({ table: 'categories', spec: CATEGORY_SPEC, required: ['name'], body, label: 'Categoria' });
  await audit(user.username, r.created ? 'categoria_criada' : 'categoria_editada', `#${r.row.id} ${r.row.name}`);
  return { ok: true, category: r.row };
} };

A.product_save = { m: 'POST', fn: async ({ body, user }) => {
  const r = await saveEntity({ table: 'products', spec: PRODUCT_SPEC, required: ['name', 'category_id'], body, label: 'Produto' });
  await audit(user.username, r.created ? 'produto_criado' : 'produto_editado', `#${r.row.id} ${r.row.name}`);
  return { ok: true, product: r.row };
} };

A.product_toggle = { m: 'POST', fn: async ({ body, user }) => {
  const id = vId(body.id), active = vBool(body.active, 'Ativo');
  const row = own(await q('update products set active = $2 where id = $1 returning id, name, active', [id, active]), 'Produto não encontrado.');
  await audit(user.username, active ? 'produto_ativado' : 'produto_pausado', `#${row.id} ${row.name}`);
  return { ok: true, product: row };
} };

A.product_delete = { m: 'POST', fn: async ({ body, user }) => {
  const id = vId(body.id);
  const row = own(await q('delete from products where id = $1 returning id, name, image_path', [id]), 'Produto não encontrado.');
  const imgId = imageIdOf(row.image_path);
  if (imgId) await q('delete from images where id = $1', [imgId]);
  await audit(user.username, 'produto_excluido', `#${row.id} ${row.name}`);
  return { ok: true };
} };

A.product_image = { m: 'POST', fn: async ({ body, user }) => {
  const productId = vId(body.product_id, 'Produto');
  const old = own(await q('select id, image_path from products where id = $1', [productId]), 'Produto não encontrado.');
  const { buf, mime } = decodeImage(body.data);
  const img = (await q(`insert into images (mime, data) values ($1, decode($2::text, 'base64')) returning id`, [mime, buf.toString('base64')]))[0];
  const path = `/api/img?id=${img.id}`;
  await q('update products set image_path = $2 where id = $1', [productId, path]);
  const oldId = imageIdOf(old.image_path);
  if (oldId) await q('delete from images where id = $1', [oldId]);
  await audit(user.username, 'foto_enviada', `produto #${productId} (${mime}, ${buf.length} bytes)`);
  return { ok: true, image_path: path };
} };

A.product_image_remove = { m: 'POST', fn: async ({ body, user }) => {
  const productId = vId(body.product_id, 'Produto');
  const old = own(await q('select id, image_path from products where id = $1', [productId]), 'Produto não encontrado.');
  await q('update products set image_path = null where id = $1', [productId]);
  const oldId = imageIdOf(old.image_path);
  if (oldId) await q('delete from images where id = $1', [oldId]);
  await audit(user.username, 'foto_removida', `produto #${productId}`);
  return { ok: true };
} };

A.complement_save = { m: 'POST', fn: async ({ body, user }) => {
  const r = await saveEntity({ table: 'complements', spec: COMPLEMENT_SPEC, required: ['name', 'kind'], body, label: 'Complemento' });
  await audit(user.username, r.created ? 'complemento_criado' : 'complemento_editado', `#${r.row.id} ${r.row.name}`);
  return { ok: true, complement: r.row };
} };

A.complement_toggle = { m: 'POST', fn: async ({ body, user }) => {
  const id = vId(body.id), active = vBool(body.active, 'Ativo');
  const row = own(await q('update complements set active = $2 where id = $1 returning id, name, active', [id, active]), 'Complemento não encontrado.');
  await audit(user.username, active ? 'complemento_ativado' : 'complemento_pausado', `#${row.id} ${row.name}`);
  return { ok: true, complement: row };
} };

A.complement_delete = { m: 'POST', fn: async ({ body, user }) => {
  const id = vId(body.id);
  const row = own(await q('delete from complements where id = $1 returning id, name', [id]), 'Complemento não encontrado.');
  await audit(user.username, 'complemento_excluido', `#${row.id} ${row.name}`);
  return { ok: true };
} };

// ---------- Ações: vínculos produto x complemento e grupos ----------
A.link_save = { m: 'POST', fn: async ({ body, user }) => {
  const productId = vId(body.product_id, 'Produto'), complementId = vId(body.complement_id, 'Complemento');
  const maxQty = body.max_quantity === undefined ? 1 : vInt(body.max_quantity, 1, 50, 'Quantidade máxima');
  const paused = body.paused === undefined ? false : vBool(body.paused, 'Pausado');
  const comp = own(await q('select id, kind, name from complements where id = $1', [complementId]), 'Complemento não encontrado.');
  own(await q('select id from products where id = $1', [productId]), 'Produto não encontrado.');
  let groupId = body.group_id === undefined || body.group_id === null ? null : vId(body.group_id, 'Grupo');
  if (comp.kind === 'size') groupId = null;
  if (groupId !== null) own(await q('select id from product_groups where id = $1 and product_id = $2', [groupId, productId]), 'Grupo não pertence a este produto.');
  await q(`insert into product_complements (product_id, complement_id, max_quantity, group_id, paused) values ($1, $2, $3, $4, $5)
           on conflict (product_id, complement_id) do update set max_quantity = excluded.max_quantity, group_id = excluded.group_id, paused = excluded.paused`,
  [productId, complementId, maxQty, groupId, paused]);
  await audit(user.username, 'vinculo_salvo', `produto #${productId} + ${comp.name}`);
  return { ok: true };
} };

A.link_delete = { m: 'POST', fn: async ({ body, user }) => {
  const productId = vId(body.product_id, 'Produto'), complementId = vId(body.complement_id, 'Complemento');
  own(await q('delete from product_complements where product_id = $1 and complement_id = $2 returning product_id', [productId, complementId]), 'Vínculo não encontrado.');
  await audit(user.username, 'vinculo_removido', `produto #${productId} - complemento #${complementId}`);
  return { ok: true };
} };

A.link_toggle = { m: 'POST', fn: async ({ body, user }) => {
  const productId = vId(body.product_id, 'Produto'), complementId = vId(body.complement_id, 'Complemento'), paused = vBool(body.paused, 'Pausado');
  own(await q('update product_complements set paused = $3 where product_id = $1 and complement_id = $2 returning product_id', [productId, complementId, paused]), 'Vínculo não encontrado.');
  await audit(user.username, paused ? 'vinculo_pausado' : 'vinculo_reativado', `produto #${productId} - complemento #${complementId}`);
  return { ok: true };
} };

A.group_save = { m: 'POST', fn: async ({ body, user }) => {
  const { out } = pickFields(body, GROUP_SPEC);
  let row;
  if (body.id === undefined || body.id === null) {
    const productId = vId(body.product_id, 'Produto');
    own(await q('select id from products where id = $1', [productId]), 'Produto não encontrado.');
    if (!out.key || !out.label || out.max_choices === undefined) bad('Preencha título, chave e máximo.');
    const g = { product_id: productId, min_choices: 0, sort_order: 0, ...out };
    if (g.min_choices > g.max_choices) bad('O mínimo não pode ser maior que o máximo.');
    row = (await buildInsert('product_groups', g))[0];
  } else {
    const id = vId(body.id);
    const cur = own(await q('select * from product_groups where id = $1', [id]), 'Grupo não encontrado.');
    const merged = { ...cur, ...out };
    if (merged.min_choices > merged.max_choices) bad('O mínimo não pode ser maior que o máximo.');
    row = own(await buildUpdate('product_groups', out, id), 'Grupo não encontrado.');
  }
  await audit(user.username, 'grupo_salvo', `#${row.id} ${row.label} (produto #${row.product_id})`);
  return { ok: true, group: row };
} };

A.group_delete = { m: 'POST', fn: async ({ body, user }) => {
  const id = vId(body.id);
  const row = own(await q('delete from product_groups where id = $1 returning id, label', [id]), 'Grupo não encontrado.');
  await audit(user.username, 'grupo_excluido', `#${row.id} ${row.label}`);
  return { ok: true };
} };

// ---------- Pausa rápida, favoritos e loja ----------
A.pin_toggle = { m: 'POST', fn: async ({ body, user }) => {
  const id = vId(body.complement_id, 'Complemento'), pinned = vBool(body.pinned, 'Fixado');
  own(await q('select id from complements where id = $1', [id]), 'Complemento não encontrado.');
  const cur = (await getPinned()).filter(x => x !== id);
  if (pinned) cur.unshift(id);
  await setSetting('pinned_complements', JSON.stringify(cur.slice(0, 50)));
  await audit(user.username, pinned ? 'favorito_fixado' : 'favorito_removido', `complemento #${id}`);
  return { ok: true, pinned: cur.slice(0, 50) };
} };

A.store_save = { m: 'POST', fn: async ({ body, user }) => {
  const spec = {
    store_address: v => vStr(v, 3, 200, 'Endereço'), delivery_fee_cents: v => vCents(v, 'Taxa de entrega'),
    store_paused: v => (vBool(v, 'Loja pausada') ? '1' : '0'), store_paused_message: v => vStr(v, 0, 200, 'Mensagem')
  };
  const { out } = pickFields(body, spec);
  if (!Object.keys(out).length) bad('Nada para alterar.');
  for (const [k, v] of Object.entries(out)) await setSetting(k, v);
  await audit(user.username, 'loja_atualizada', Object.keys(out).map(k => (k === 'store_paused' ? `${k}=${out[k]}` : k)).join(', '));
  return { ok: true, settings: publicSettings(await getSettings()) };
} };

async function loadCommandCatalog() {
  const [products, complements, categories, links, settings] = await Promise.all([
    q('select id, name, active, category_id from products'), q('select id, name, active from complements'),
    q('select id, name, active from categories'), q('select product_id, complement_id, paused from product_complements'), getSettings()
  ]);
  return { products, complements, categories, links, storePaused: settings.store_paused === '1' };
}

// Prévia: nada é alterado aqui. O cliente mostra o antes/depois e só então chama command_apply.
A.command = { m: 'POST', fn: async ({ body }) => {
  const text = vStr(body.text, 1, 200, 'Comando');
  return parseCommand(text, await loadCommandCatalog());
} };

A.command_apply = { m: 'POST', fn: async ({ body, user }) => {
  if (!Array.isArray(body.targets) || !body.targets.length || body.targets.length > 300) bad('Nada para aplicar.');
  const groups = { product: { on: [], off: [] }, complement: { on: [], off: [] }, category: { on: [], off: [] }, link: { on: [], off: [] } };
  let store = null;
  for (const t of body.targets) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) bad('Alvo inválido.');
    const to = vBool(t.to, 'Estado');
    if (t.type === 'store') { store = to; continue; }
    if (!groups[t.type]) bad('Tipo de alvo inválido.');
    const id = vId(t.id);
    groups[t.type][to ? 'on' : 'off'].push(t.type === 'link' ? [vId(t.productId, 'Produto'), id] : id);
  }
  const queries = [];
  const tables = { product: 'products', complement: 'complements', category: 'categories' };
  for (const [type, table] of Object.entries(tables)) {
    for (const [side, ids] of Object.entries(groups[type])) {
      if (ids.length) queries.push(getSql().query(`update ${table} set active = $2 where id = any($1::int[]) returning id`, [ids, side === 'on']));
    }
  }
  for (const [side, pairs] of Object.entries(groups.link)) {
    if (pairs.length) queries.push(getSql().query(
      `update product_complements pc set paused = $3 from unnest($1::int[], $2::int[]) as t(pid, cid)
        where pc.product_id = t.pid and pc.complement_id = t.cid returning pc.product_id`,
      [pairs.map(p => p[0]), pairs.map(p => p[1]), side === 'off']));
  }
  if (store !== null) queries.push(getSql().query(
    `insert into settings (key, value) values ('store_paused', $1) on conflict (key) do update set value = excluded.value returning key`, [store ? '0' : '1']));
  if (!queries.length) bad('Nada para aplicar.');
  const results = await getSql().transaction(queries);
  const changed = results.reduce((n, r) => n + r.length, 0);
  await audit(user.username, 'comando_aplicado', `${changed} alterações (${body.targets.length} alvos)`);
  return { ok: true, changed };
} };

// ---------- Ações: pedidos ----------
// 'completed' também inclui o valor antigo 'delivered'.
const statusGroup = f => (f === 'completed' || f === 'delivered' ? ['completed', 'delivered'] : [f]);

// Lista do painel: só pedidos com menos de 24 h (todos os status). Os mais antigos ficam no histórico (order_history).
A.orders = { m: 'GET', fn: async ({ query }) => {
  const f = String(query.get('f') || '');
  const status = FILTER_STATUSES.includes(f) ? statusGroup(f) : null;
  const search = String(query.get('s') || '').trim().toLowerCase().slice(0, 60);
  await ordersLib.sweepOrders(getSql()); // pronto há mais de 1 h vira concluído (sem cron)
  const rows = await q(
    `select ${ordersLib.ADMIN_COLUMNS} from orders
      where created_at > now() - interval '24 hours'
        and ($1::text[] is null or fulfillment_status = any($1::text[]))
        and ($2::boolean = false or payment_status = 'approved')
        and ($3::text = '' or strpos(lower(code), $3) > 0 or strpos(lower(coalesce(public_code, '')), $3) > 0 or strpos(lower(customer_name), $3) > 0)
      order by created_at desc limit 200`, [status, f === 'paid', search]);
  return { orders: rows.map(ordersLib.adminView), window_hours: 24 };
} };

const vDate = (v, label) => {
  if (v === '' || v === null || v === undefined) return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z'))) bad(`${label}: use o formato AAAA-MM-DD.`);
  return v;
};
// Histórico: pedidos com mais de 24 h. Filtros: from/to (datas no horário de São Paulo), f (status), s (busca), page, page_size.
A.order_history = { m: 'GET', fn: async ({ query }) => {
  const from = vDate(query.get('from'), 'Data inicial'), to = vDate(query.get('to'), 'Data final');
  const f = String(query.get('f') || '');
  const status = FILTER_STATUSES.includes(f) ? statusGroup(f) : null;
  const search = String(query.get('s') || '').trim().toLowerCase().slice(0, 60);
  const pageSize = Math.min(Math.max(Number.parseInt(query.get('page_size'), 10) || 20, 1), HISTORY_PAGE_MAX);
  const page = Math.min(Math.max(Number.parseInt(query.get('page'), 10) || 1, 1), 100000);
  await ordersLib.sweepOrders(getSql());
  const rows = await q(
    `select ${ordersLib.ADMIN_COLUMNS}, count(*) over ()::int as total_rows from orders
      where created_at <= now() - interval '24 hours'
        and ($1::date is null or created_at >= ($1::date)::timestamp at time zone 'America/Sao_Paulo')
        and ($2::date is null or created_at < (($2::date + 1))::timestamp at time zone 'America/Sao_Paulo')
        and ($3::text[] is null or fulfillment_status = any($3::text[]))
        and ($4::boolean = false or payment_status = 'approved')
        and ($5::text = '' or strpos(lower(code), $5) > 0 or strpos(lower(coalesce(public_code, '')), $5) > 0 or strpos(lower(customer_name), $5) > 0)
      order by created_at desc, id desc limit $6 offset $7`,
    [from, to, status, f === 'paid', search, pageSize, (page - 1) * pageSize]);
  let total = rows.length ? rows[0].total_rows : 0;
  if (!rows.length && page > 1) { // página além do fim: o total real ainda precisa ser informado
    total = (await q(
      `select count(*)::int as n from orders where created_at <= now() - interval '24 hours'
        and ($1::date is null or created_at >= ($1::date)::timestamp at time zone 'America/Sao_Paulo')
        and ($2::date is null or created_at < (($2::date + 1))::timestamp at time zone 'America/Sao_Paulo')
        and ($3::text[] is null or fulfillment_status = any($3::text[]))
        and ($4::boolean = false or payment_status = 'approved')
        and ($5::text = '' or strpos(lower(code), $5) > 0 or strpos(lower(coalesce(public_code, '')), $5) > 0 or strpos(lower(customer_name), $5) > 0)`,
      [from, to, status, f === 'paid', search]))[0].n;
  }
  return { orders: rows.map(({ total_rows, ...r }) => ordersLib.adminView(r)), page, page_size: pageSize, total, total_pages: Math.max(1, Math.ceil(total / pageSize)) };
} };

// Status: new -> accepted -> preparing -> ready -> awaiting_delivery -> completed (+ cancelled). Só avança; cancelar vale até concluir.
A.order_status = { m: 'POST', fn: async ({ body, user }) => {
  const id = vId(body.id, 'Pedido');
  let status = vEnum(body.status, FILTER_STATUSES, 'Status');
  if (status === 'delivered') status = 'completed';
  const reason = body.reason === undefined || body.reason === null || body.reason === '' ? null : vStr(body.reason, 1, 200, 'Motivo');
  const row = await ordersLib.changeStatus(getSql(), { id, to: status, reason });
  if (status === 'cancelled' && row.changed) await loyalty.releaseReserve(getSql(), id, 'pedido cancelado'); // devolve os pontos reservados (se não foi pago)
  if (row.changed) await audit(user.username, 'pedido_status', `${row.public_code || row.code} -> ${status}`);
  return { ok: true, order: { id: row.id, code: row.code, public_code: row.public_code, fulfillment_status: row.fulfillment_status, fulfillment_label: ordersLib.statusLabel(row.fulfillment_status, row.delivery_method) } };
} };

// ---------- Ações: conta e usuários ----------
const killSessions = (userId, exceptHash) =>
  q('delete from admin_sessions where user_id = $1 and token_hash <> $2', [userId, exceptHash || '']);

A.logout = { m: 'POST', fn: async ({ user, res }) => {
  await q('delete from admin_sessions where token_hash = $1', [user.tokenHash]);
  await audit(user.username, 'logout', null);
  res.setHeader('Set-Cookie', clearCookie());
  return { ok: true };
} };

A.password_change = { m: 'POST', fn: async ({ body, user }) => {
  const current = typeof body.current_password === 'string' ? body.current_password.slice(0, 256) : '';
  const next = vPassword(body.new_password, 'Nova senha');
  const row = own(await q('select password_hash from admin_users where id = $1', [user.id]), 'Usuário não encontrado.');
  if (!(await verifyPassword(current, row.password_hash))) {
    await audit(user.username, 'troca_senha_falhou', null);
    throw new HttpError(400, 'A senha atual está incorreta.');
  }
  if (next === current) bad('A nova senha precisa ser diferente da atual.');
  await q('update admin_users set password_hash = $2, weak_password = false where id = $1', [user.id, await hashPassword(next)]);
  await killSessions(user.id, user.tokenHash);
  await audit(user.username, 'senha_trocada', null);
  return { ok: true };
} };

A.audit = { m: 'GET', fn: async () => ({
  rows: await q('select id, username, action, detail, at from admin_audit order by at desc, id desc limit 50')
}) };

A.users = { m: 'GET', role: 'admin', fn: async () => ({
  users: await q('select id, username, role, active, weak_password, created_at, last_login_at from admin_users order by id')
}) };

A.user_create = { m: 'POST', role: 'admin', fn: async ({ body, user }) => {
  const username = vUsername(body.username), password = vPassword(body.password);
  const role = body.role === undefined ? 'staff' : vEnum(body.role, ['admin', 'staff'], 'Perfil');
  const row = (await q(`insert into admin_users (username, password_hash, role, weak_password) values ($1, $2, $3, false) returning id, username, role`,
    [username, await hashPassword(password), role]))[0];
  await audit(user.username, 'usuario_criado', `${row.username} (${row.role})`);
  return { ok: true, target: row };
} };

A.user_toggle = { m: 'POST', role: 'admin', fn: async ({ body, user }) => {
  const id = vId(body.id, 'Usuário'), active = vBool(body.active, 'Ativo');
  if (id === user.id && !active) bad('Você não pode desativar o seu próprio usuário.');
  const row = own(await q('update admin_users set active = $2 where id = $1 returning id, username, active', [id, active]), 'Usuário não encontrado.');
  if (!active) await killSessions(id, '');
  await audit(user.username, active ? 'usuario_ativado' : 'usuario_desativado', row.username);
  return { ok: true, target: row };
} };

A.user_reset = { m: 'POST', role: 'admin', fn: async ({ body, user }) => {
  const id = vId(body.id, 'Usuário'), password = vPassword(body.new_password, 'Nova senha');
  const row = own(await q('update admin_users set password_hash = $2, weak_password = false where id = $1 returning id, username',
    [id, await hashPassword(password)]), 'Usuário não encontrado.');
  await killSessions(id, id === user.id ? user.tokenHash : '');
  await audit(user.username, 'senha_redefinida', row.username);
  return { ok: true };
} };

// ---------- Segurança da conta: pergunta/resposta, códigos de recuperação e recuperação de senha (O9) ----------
const RECOVERY_MAX_FAILS = 3;
const RECOVERY_LOCK_MS = 3600 * 1000;
const MSG_RECOVERY_LOCKED = 'Muitas tentativas. Tente novamente em 1 hora.';
const MSG_RECOVERY_FAIL = 'Não foi possível recuperar com esses dados.';

async function recoveryLocked(username, ip) {
  const [byUser, byIp, nowRows] = await Promise.all([
    q(`select (extract(epoch from at) * 1000)::float8 as ms from admin_recovery_attempts
        where username = $1 and ok = false and at > now() - interval '1 hour'
          and at > coalesce((select max(at) from admin_recovery_attempts where username = $1 and ok = true), '-infinity'::timestamptz)
        order by at desc limit 10`, [username]),
    q(`select (extract(epoch from at) * 1000)::float8 as ms from admin_recovery_attempts
        where ip = $1 and ok = false and at > now() - interval '1 hour' order by at desc limit 10`, [ip]),
    q(`select (extract(epoch from now()) * 1000)::float8 as ms`)
  ]);
  const nowMs = Number(nowRows[0].ms), ms = rows => rows.map(r => Number(r.ms));
  const p = { nowMs, max: RECOVERY_MAX_FAILS, lockMs: RECOVERY_LOCK_MS };
  return auth.evaluateAttemptLock({ failsMs: ms(byUser), ...p }).locked || auth.evaluateAttemptLock({ failsMs: ms(byIp), ...p }).locked;
}
const recordRecovery = (username, ip, ok) => q('insert into admin_recovery_attempts (username, ip, ok) values ($1, $2, $3)', [username.slice(0, 64), ip, ok]);

// Pública: pergunta de segurança do usuário. Usuário inexistente (ou sem pergunta) recebe uma pergunta falsa estável.
async function doRecoverQuestion(req, res, body) {
  const username = typeof body.username === 'string' ? body.username.trim().toLowerCase().slice(0, 64) : '';
  if (!username) return send(res, 400, { error: 'Informe o usuário.' });
  const user = (await q('select security_question, active from admin_users where username = $1', [username]))[0];
  const id = user && user.active && user.security_question ? user.security_question : auth.fakeQuestionFor('admin', username);
  return send(res, 200, { question_id: id, question: auth.questionText(id) });
}

// Pública: usuário + resposta + código de recuperação (uso único) + nova senha. 3 erros = bloqueio de 1 h (usuário e IP).
async function doRecover(req, res, body) {
  const username = typeof body.username === 'string' ? body.username.trim().toLowerCase().slice(0, 64) : '';
  if (!username || typeof body.answer !== 'string' || typeof body.code !== 'string') return send(res, 400, { error: 'Informe usuário, resposta e código de recuperação.' });
  let next;
  try { next = auth.validatePassword(body.new_password, 'Nova senha'); } catch (e) { return send(res, 400, { error: e.message }); }
  const ip = clientIp(req);
  const dummy = await dummyHash();
  if (await recoveryLocked(username, ip)) return send(res, 429, { error: MSG_RECOVERY_LOCKED });
  const user = (await q('select id, username, security_answer_hash, active from admin_users where username = $1', [username]))[0];
  const usable = !!(user && user.active && user.security_answer_hash);
  const answerOk = await auth.verifyAnswer(body.answer, usable ? user.security_answer_hash : dummy); // gasta o mesmo tempo sem usuário
  let codeId = null;
  if (usable && answerOk) {
    const codes = await q('select id, code_hash from admin_recovery_codes where user_id = $1 and used_at is null', [user.id]);
    codeId = await auth.matchRecoveryCode(body.code, codes);
  }
  if (!(usable && answerOk && codeId)) {
    await recordRecovery(username, ip, false);
    await audit(username, 'recuperacao_falhou', 'ip ' + ip);
    if (await recoveryLocked(username, ip)) return send(res, 429, { error: MSG_RECOVERY_LOCKED });
    return send(res, 400, { error: MSG_RECOVERY_FAIL });
  }
  const used = await q('update admin_recovery_codes set used_at = now() where id = $1 and used_at is null returning id', [codeId]);
  if (!used.length) { // outro pedido usou o mesmo código ao mesmo tempo
    await recordRecovery(username, ip, false);
    return send(res, 400, { error: MSG_RECOVERY_FAIL });
  }
  await recordRecovery(username, ip, true);
  await q('update admin_users set password_hash = $2, weak_password = false where id = $1', [user.id, await hashPassword(next)]);
  await killSessions(user.id, '');
  await q('delete from login_attempts where username = $1', [username]);
  await audit(username, 'senha_recuperada', 'ip ' + ip);
  return send(res, 200, { ok: true });
}

// Estas ações funcionam mesmo antes de a pessoa cadastrar a pergunta de segurança; as outras ficam bloqueadas.
const ALLOWED_WITHOUT_SECURITY = new Set(['me', 'security_questions', 'security_setup', 'logout']);

A.security_questions = { m: 'GET', fn: async () => ({ questions: auth.SECURITY_QUESTIONS }) };

A.security_status = { m: 'GET', fn: async ({ user }) => {
  const row = own(await q('select security_question, security_set_at from admin_users where id = $1', [user.id]), 'Usuário não encontrado.');
  const left = (await q('select count(*)::int as n from admin_recovery_codes where user_id = $1 and used_at is null', [user.id]))[0].n;
  return { security: { set: !!row.security_question, question_id: row.security_question, question: auth.questionText(row.security_question), set_at: row.security_set_at, codes_left: left } };
} };

// Gera 10 códigos novos (apaga os antigos) e devolve o texto UMA vez. No banco só vão os hashes.
async function replaceRecoveryCodes(userId) {
  const gen = await auth.generateRecoveryCodes();
  await getSql().transaction([
    getSql().query('delete from admin_recovery_codes where user_id = $1', [userId]),
    getSql().query('insert into admin_recovery_codes (user_id, code_hash) select $1::int, unnest($2::text[])', [userId, gen.map(c => c.hash)])
  ]);
  return gen.map(c => c.code);
}

A.security_setup = { m: 'POST', fn: async ({ body, user }) => {
  const questionId = auth.validateQuestionId(body.question_id);
  const answerHash = await auth.hashAnswer(body.answer);
  const row = own(await q('select password_hash, security_answer_hash from admin_users where id = $1', [user.id]), 'Usuário não encontrado.');
  const had = !!row.security_answer_hash;
  if (had) { // trocar pergunta já cadastrada exige a senha atual
    const current = typeof body.current_password === 'string' ? body.current_password.slice(0, 256) : '';
    if (!(await verifyPassword(current, row.password_hash))) {
      await audit(user.username, 'troca_pergunta_falhou', null);
      throw new HttpError(400, 'A senha atual está incorreta.');
    }
  }
  await q('update admin_users set security_question = $2, security_answer_hash = $3, security_set_at = now() where id = $1', [user.id, questionId, answerHash]);
  const codes = await replaceRecoveryCodes(user.id);
  await audit(user.username, had ? 'pergunta_trocada' : 'pergunta_cadastrada', `${codes.length} códigos novos`);
  return { ok: true, codes, codes_notice: 'Guarde estes códigos agora: eles não serão mostrados de novo. Cada um vale uma vez.' };
} };

A.recovery_codes_new = { m: 'POST', fn: async ({ body, user }) => {
  const row = own(await q('select password_hash from admin_users where id = $1', [user.id]), 'Usuário não encontrado.');
  const current = typeof body.current_password === 'string' ? body.current_password.slice(0, 256) : '';
  if (!(await verifyPassword(current, row.password_hash))) throw new HttpError(400, 'A senha atual está incorreta.');
  const codes = await replaceRecoveryCodes(user.id);
  await audit(user.username, 'codigos_recuperacao_novos', `${codes.length} códigos`);
  return { ok: true, codes, codes_notice: 'Guarde estes códigos agora: eles não serão mostrados de novo. Cada um vale uma vez.' };
} };

// ---------- Pausa de produtos (O2) ----------
// "paused" (volto logo) é diferente de "active" (ativo/oculto): produto pausado continua aparecendo no cardápio, sem poder ser pedido.
A.product_pause = { m: 'POST', fn: async ({ body, user }) => {
  const id = vId(body.id), paused = vBool(body.paused, 'Pausado');
  let label;
  if (Object.prototype.hasOwnProperty.call(body, 'pause_label')) label = body.pause_label === null || body.pause_label === '' ? null : vStr(body.pause_label, 1, 60, 'Etiqueta');
  const row = own(await q(
    `update products set paused = $2, pause_label = case when $3::boolean then $4::text else pause_label end where id = $1
     returning id, name, paused, pause_label`, [id, paused, label !== undefined, label === undefined ? null : label]), 'Produto não encontrado.');
  await audit(user.username, paused ? 'produto_em_pausa' : 'produto_retomado', `#${row.id} ${row.name}`);
  return { ok: true, product: row };
} };

A.pause_default_label = { m: 'POST', fn: async ({ body, user }) => {
  const label = vStr(body.label, 1, 60, 'Etiqueta padrão');
  await setSetting('default_pause_label', label);
  await audit(user.username, 'etiqueta_padrao_alterada', label);
  return { ok: true, defaultPauseLabel: label };
} };

// ---------- Horários e estado da loja (O3, O4) ----------
A.store_hours = { m: 'GET', fn: async () => ({ hours: await storeHours.loadHours(getSql()), timezone: storeHours.TZ }) };

A.store_hours_save = { m: 'POST', fn: async ({ body, user }) => {
  const rows = await storeHours.saveHours(getSql(), body.hours);
  await audit(user.username, 'horarios_salvos', `${rows.length} faixas`);
  return { ok: true, hours: rows };
} };

A.store_state = { m: 'GET', fn: async () => {
  const state = await storeHours.getStoreState(getSql());
  const manual = await storeHours.loadManual(getSql());
  return { state, manual: manual && { closed_until: manual.closed_until && manual.closed_until.toISOString(), closed_indefinitely: manual.closed_indefinitely, closed_message: manual.closed_message, updated_by: manual.updated_by, updated_at: manual.updated_at } };
} };

A.store_close = { m: 'POST', fn: async ({ body, user }) => {
  await storeHours.closeStore(getSql(), { minutes: body.minutes, indefinite: body.indefinite === true, message: body.message, user: user.username });
  await audit(user.username, 'loja_fechada', body.indefinite === true ? 'até reabrir' : `${body.minutes} min`);
  return { ok: true, state: await storeHours.getStoreState(getSql()) };
} };

A.store_reopen = { m: 'POST', fn: async ({ user }) => {
  await storeHours.reopenStore(getSql(), user.username);
  await audit(user.username, 'loja_reaberta', null);
  return { ok: true, state: await storeHours.getStoreState(getSql()) };
} };

// ---------- Frete por faixas (O5) ----------
async function shippingInfo() {
  const [bands, rows] = await Promise.all([shipping.getBands(getSql()),
    q(`select key, value from settings where key in ('store_origin_address', 'store_origin_lat', 'store_origin_lon')`)]);
  const st = {};
  for (const r of rows) st[r.key] = r.value;
  const lat = Number(st.store_origin_lat), lon = Number(st.store_origin_lon);
  return {
    bands, max_km: shipping.maxKmOf(bands), pickup_fee_cents: 0,
    origin_address: st.store_origin_address || shipping.DEFAULT_ORIGIN_ADDRESS,
    origin: st.store_origin_lat && Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null
  };
}
A.shipping_get = { m: 'GET', fn: async () => ({ shipping: await shippingInfo() }) };

A.shipping_save = { m: 'POST', fn: async ({ body, user }) => {
  let warning = null;
  if (body.bands === undefined && body.origin_address === undefined) bad('Nada para alterar.');
  if (body.bands !== undefined) {
    await shipping.saveBands(getSql(), body.bands);
    await audit(user.username, 'frete_faixas_salvas', JSON.stringify(await shipping.getBands(getSql())).slice(0, 400));
  }
  if (body.origin_address !== undefined) {
    const address = vStr(body.origin_address, 5, 200, 'Endereço de origem');
    await setSetting('store_origin_address', address);
    await q(`delete from settings where key in ('store_origin_lat', 'store_origin_lon')`);
    try { await shipping.getOrigin(getSql(), { refresh: true }); }
    catch (e) { warning = 'Endereço salvo, mas não foi possível localizá-lo agora. Ele será localizado no próximo cálculo de frete.'; }
    await audit(user.username, 'frete_origem_alterada', address);
  }
  return { ok: true, shipping: await shippingInfo(), ...(warning ? { warning } : {}) };
} };

// ---------- Sinônimos de ingredientes e pausa em lote com prévia (O8) ----------
const SYN_SPEC = { canonical: v => vStr(v, 2, 60, 'Nome principal'), synonym: v => vStr(v, 2, 60, 'Sinônimo') };

A.synonyms = { m: 'GET', fn: async () => ({ synonyms: await q('select id, canonical, synonym from ingredient_synonyms order by canonical_norm, synonym_norm') }) };

A.synonym_save = { m: 'POST', fn: async ({ body, user }) => {
  const { out, missing } = pickFields(body, SYN_SPEC, ['canonical', 'synonym']);
  if (missing.length) bad('Informe o nome principal e o sinônimo.');
  const cn = norm(out.canonical), sn = norm(out.synonym);
  if (cn.length < 2 || sn.length < 2) bad('Use letras ou números no nome e no sinônimo.');
  if (cn === sn) bad('O sinônimo precisa ser diferente do nome principal.');
  let row;
  if (body.id === undefined || body.id === null) {
    row = (await q(`insert into ingredient_synonyms (canonical, synonym, canonical_norm, synonym_norm) values ($1, $2, $3, $4) returning id, canonical, synonym`, [out.canonical, out.synonym, cn, sn]))[0];
  } else {
    row = own(await q(`update ingredient_synonyms set canonical = $2, synonym = $3, canonical_norm = $4, synonym_norm = $5 where id = $1 returning id, canonical, synonym`,
      [vId(body.id), out.canonical, out.synonym, cn, sn]), 'Sinônimo não encontrado.');
  }
  await audit(user.username, 'sinonimo_salvo', `${row.canonical} = ${row.synonym}`);
  return { ok: true, synonym: row };
} };

A.synonym_delete = { m: 'POST', fn: async ({ body, user }) => {
  const row = own(await q('delete from ingredient_synonyms where id = $1 returning id, canonical, synonym', [vId(body.id)]), 'Sinônimo não encontrado.');
  await audit(user.username, 'sinonimo_excluido', `${row.canonical} = ${row.synonym}`);
  return { ok: true };
} };

// Termos de busca = o digitado + os sinônimos (um nível de fechamento: oreo <-> biscoito oreo).
function expandTerms(term, synRows) {
  const set = new Set([norm(term)]);
  for (let changed = true; changed;) {
    changed = false;
    for (const r of synRows) {
      if ((set.has(r.canonical_norm) || set.has(r.synonym_norm)) && !(set.has(r.canonical_norm) && set.has(r.synonym_norm))) {
        set.add(r.canonical_norm); set.add(r.synonym_norm); changed = true;
      }
    }
  }
  return [...set].filter(Boolean);
}
// Casamento por palavras inteiras (com plural tolerado): o termo precisa aparecer em sequência no texto.
function textMatches(text, termList) {
  const tokens = words(text).map(stem);
  if (!tokens.length) return null;
  for (const term of termList) {
    const t = words(term).map(stem);
    if (!t.length) continue;
    for (let i = 0; i + t.length <= tokens.length; i++) if (t.every((w, j) => tokens[i + j] === w)) return term;
  }
  return null;
}
function searchByTerms(termList, { products, complements, links }) {
  const foundProducts = [];
  for (const p of products) {
    const inName = textMatches(p.name, termList);
    const inDesc = inName ? null : textMatches(p.description || '', termList);
    if (inName || inDesc) foundProducts.push({ id: p.id, name: p.name, matched_in: inName ? 'nome' : 'descrição', matched_term: inName || inDesc, active: p.active, paused: p.paused, pause_label: p.pause_label });
  }
  const foundComplements = [];
  for (const c of complements) {
    const hit = textMatches(c.name, termList);
    if (!hit) continue;
    foundComplements.push({
      id: c.id, name: c.name, matched_term: hit, active: c.active,
      links: links.filter(l => l.complement_id === c.id).map(l => ({ product_id: l.product_id, product_name: l.product_name, paused: l.paused }))
    });
  }
  return { products: foundProducts, complements: foundComplements };
}

// PRÉVIA: só lê. Mostra o que seria afetado; nada muda até pause_apply (com confirmação).
A.pause_preview = { m: 'POST', fn: async ({ body }) => {
  const term = vStr(body.term, 2, 60, 'Ingrediente');
  if (norm(term).length < 2) bad('Escreva o nome do ingrediente.');
  const [syn, products, complements, links] = await Promise.all([
    q('select canonical_norm, synonym_norm from ingredient_synonyms'),
    q('select id, name, description, active, paused, pause_label from products order by name'),
    q('select id, name, active from complements order by name'),
    q(`select pc.product_id, pc.complement_id, pc.paused, p.name as product_name from product_complements pc join products p on p.id = pc.product_id`)
  ]);
  const terms = expandTerms(term, syn);
  const found = searchByTerms(terms, { products, complements, links });
  const linkCount = found.complements.reduce((n, c) => n + c.links.length, 0);
  return { ok: true, term, terms, ...found, summary: { products: found.products.length, complements: found.complements.length, links: linkCount } };
} };

// APLICA depois da confirmação: pausa (ou retoma) em lote os produtos e os vínculos produto-complemento escolhidos na prévia.
A.pause_apply = { m: 'POST', fn: async ({ body, user }) => {
  if (body.confirm !== true) bad('Confirme para aplicar a pausa.');
  const paused = vBool(body.paused, 'Pausado');
  const productIds = body.product_ids === undefined ? [] : body.product_ids;
  const linkList = body.links === undefined ? [] : body.links;
  if (!Array.isArray(productIds) || !Array.isArray(linkList) || productIds.length > 300 || linkList.length > 600) bad('Lista inválida.');
  if (!productIds.length && !linkList.length) bad('Nada para aplicar.');
  const pids = productIds.map(v => vId(v, 'Produto'));
  const pairs = linkList.map(l => { if (!l || typeof l !== 'object') bad('Vínculo inválido.'); return [vId(l.product_id, 'Produto'), vId(l.complement_id, 'Complemento')]; });
  let label = null, setLabel = false;
  if (body.pause_label !== undefined) { setLabel = true; label = body.pause_label === null || body.pause_label === '' ? null : vStr(body.pause_label, 1, 60, 'Etiqueta'); }
  const queries = [];
  if (pids.length) queries.push(getSql().query(
    `update products set paused = $2, pause_label = case when $3::boolean then $4::text else pause_label end where id = any($1::int[]) returning id`,
    [pids, paused, setLabel, label]));
  if (pairs.length) queries.push(getSql().query(
    `update product_complements pc set paused = $3 from unnest($1::int[], $2::int[]) as t(pid, cid)
      where pc.product_id = t.pid and pc.complement_id = t.cid returning pc.product_id`, [pairs.map(p => p[0]), pairs.map(p => p[1]), paused]));
  const results = await getSql().transaction(queries);
  const productsChanged = pids.length ? results[0].length : 0, linksChanged = pairs.length ? results[results.length - 1].length : 0;
  await audit(user.username, paused ? 'pausa_em_lote' : 'retomada_em_lote', `${productsChanged} produtos, ${linksChanged} vínculos`);
  return { ok: true, products_changed: productsChanged, links_changed: linksChanged };
} };

// ---------- Roteador ----------
function readBody(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
  if (Buffer.isBuffer(b)) { try { b = JSON.parse(b.toString('utf8')); } catch { b = null; } }
  return b && typeof b === 'object' && !Array.isArray(b) ? b : null;
}

async function handler(req, res) {
  baseHeaders(res);
  try {
    if (req.method !== 'GET' && req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return send(res, 405, { error: 'Método não permitido.' }); }
    const url = new URL(req.url || '/', 'http://localhost');
    const query = url.searchParams;
    let body = {};
    if (req.method === 'POST') {
      if (!sameOrigin(req)) return send(res, 403, { error: 'Origem não permitida.' });
      if (!isJsonType(req)) return send(res, 415, { error: 'Envie os dados como JSON.' });
      body = readBody(req);
      if (!body) return send(res, 400, { error: 'Dados inválidos.' });
    }
    const name = String(query.get('a') || body.a || '').slice(0, 40);

    if (name === 'login') {
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(res, 405, { error: 'Método não permitido.' }); }
      return await doLogin(req, res, body);
    }

    if (name === 'recover_question' || name === 'recover') {
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(res, 405, { error: 'Método não permitido.' }); }
      return await (name === 'recover' ? doRecover : doRecoverQuestion)(req, res, body);
    }

    const user = await authenticate(req);
    if (!user) return send(res, 401, { error: 'Sessão expirada. Entre novamente.' });
    if (user.needsSecurity && !ALLOWED_WITHOUT_SECURITY.has(name)) {
      return send(res, 403, { error: 'Cadastre sua pergunta de segurança para continuar.', code: 'security_setup_required' });
    }
    const action = Object.prototype.hasOwnProperty.call(A, name) ? A[name] : null;
    if (!action) return send(res, 404, { error: 'Ação não encontrada.' });
    if (action.m !== req.method) { res.setHeader('Allow', action.m); return send(res, 405, { error: 'Método não permitido.' }); }
    if (action.role && user.role !== action.role) return send(res, 403, { error: 'Sem permissão para esta ação.' });

    const result = await action.fn({ req, res, body, query, user });
    const stillNeeds = user.needsSecurity && name !== 'security_setup';
    return send(res, 200, { ...result, user: { username: user.username, role: user.role, weakPassword: name === 'password_change' ? false : user.weak, needsSecurity: stillNeeds } });
  } catch (error) {
    if (error instanceof HttpError) return send(res, error.status, { error: error.message });
    if ([auth.AuthError, ordersLib.OrderError, storeHours.StoreError, shipping.ShippingError, loyalty.LoyaltyError].some(C => error instanceof C)) {
      return send(res, error.status, { error: error.message, ...(error.code ? { code: error.code } : {}) });
    }
    if (error && error.code === '23505') return send(res, 400, { error: 'Já existe um item com esse nome ou chave.' });
    if (error && error.code === '23503') return send(res, 400, { error: 'Referência inválida ou item em uso.' });
    console.error('Erro no admin:', error && error.message);
    return send(res, 500, { error: 'Não foi possível concluir a operação.' });
  }
}

module.exports = handler;
module.exports._internal = {
  hashPassword, verifyPassword, evaluateLock, parseCommand, norm, detectImage, decodeImage, sameOrigin, isJsonType,
  vId, vInt, vStr, vBool, vCents, vEnum, vUsername, vPassword, vKey, HttpError, FILTER_STATUSES, DEFAULT_SETTINGS, SESSION_COOKIE, expandTerms, textMatches, searchByTerms
};
