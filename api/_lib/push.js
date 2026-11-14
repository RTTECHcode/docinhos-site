'use strict';
// U-06 (v4): Web Push para avisar pedido pago no celular/PC do admin (PWA do painel).
// Feito só com node:crypto (sem dependência nova): VAPID (RFC 8292, JWT ES256) e criptografia aes128gcm (RFC 8291).
// Chaves nas variáveis VAPID_PUBLIC_KEY (ponto P-256 sem compressão, base64url, 65 bytes), VAPID_PRIVATE_KEY
// (base64url, 32 bytes) e VAPID_SUBJECT (mailto: ou https:). Gere com scripts/gerar-vapid.js.
// Sem as três variáveis (ou com valor inválido) o push fica DESLIGADO: nada é enviado e nada lança erro.
// A notificação nunca leva dado pessoal: só "Pedido DG-1234 pago" e o valor.
const crypto = require('node:crypto');

class PushError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

const b64u = buf => Buffer.from(buf).toString('base64url');
const fromB64u = s => Buffer.from(String(s || ''), 'base64url');

// Servidores de push dos navegadores (o servidor só faz POST para esses domínios: evita SSRF com endpoint inventado).
const PUSH_HOST_SUFFIXES = [
  'fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com', 'push.apple.com'
];
const MAX_PER_USER = 10;
const SEND_TIMEOUT_MS = 5000;
const TTL_SECONDS = 3600;
const MAX_FAILS = 5; // falhas seguidas (fora 404/410) antes de apagar a inscrição

// Configuração VAPID em vigor, ou null (push desligado). Nunca devolve a chave privada para fora deste módulo.
function config(env = process.env) {
  const pub = String(env.VAPID_PUBLIC_KEY || '').trim();
  const priv = String(env.VAPID_PRIVATE_KEY || '').trim();
  const subject = String(env.VAPID_SUBJECT || '').trim();
  if (!pub || !priv || !subject) return null;
  if (!/^(mailto:[^\s@]+@[^\s@]+\.[^\s@]+|https:\/\/[^\s]+)$/.test(subject)) return null;
  const p = fromB64u(pub), d = fromB64u(priv);
  if (p.length !== 65 || p[0] !== 4 || d.length !== 32) return null;
  try {
    const key = crypto.createPrivateKey({
      key: { kty: 'EC', crv: 'P-256', d: b64u(d), x: b64u(p.subarray(1, 33)), y: b64u(p.subarray(33)) }, format: 'jwk'
    });
    // Confere se a chave pública bate com a privada (evita par trocado).
    const check = crypto.createPublicKey(key).export({ format: 'jwk' });
    if (check.x !== b64u(p.subarray(1, 33)) || check.y !== b64u(p.subarray(33))) return null;
    return { publicKey: b64u(p), key, subject };
  } catch {
    return null;
  }
}
const enabled = (env = process.env) => config(env) !== null;
const publicKey = (env = process.env) => { const c = config(env); return c ? c.publicKey : null; };

// JWT ES256 para o cabeçalho Authorization: vapid t=..., k=...
function vapidHeader(endpoint, cfg, nowSec = Math.floor(Date.now() / 1000)) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: nowSec + 12 * 3600, sub: cfg.subject }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: cfg.key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${cfg.publicKey}`;
}

// RFC 8291: cifra a mensagem para a inscrição (p256dh = chave do navegador, auth = segredo de 16 bytes).
// Retorna o corpo completo (cabeçalho aes128gcm + texto cifrado).
function encrypt(plaintext, p256dh, auth, { salt = crypto.randomBytes(16), ecdh = null } = {}) {
  const uaPublic = fromB64u(p256dh), authSecret = fromB64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) throw new PushError(400, 'Inscrição de notificação inválida.', 'invalid_subscription');
  const local = ecdh || crypto.createECDH('prime256v1');
  if (!ecdh) local.generateKeys();
  const asPublic = local.getPublicKey();
  const shared = local.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}

// Valida a inscrição vinda do navegador (PushSubscription.toJSON()). Retorna { endpoint, p256dh, auth }.
function validateSubscription(sub) {
  const bad = () => { throw new PushError(400, 'Inscrição de notificação inválida.', 'invalid_subscription'); };
  if (!sub || typeof sub !== 'object' || Array.isArray(sub)) bad();
  const endpoint = typeof sub.endpoint === 'string' ? sub.endpoint.trim() : '';
  const keys = sub.keys && typeof sub.keys === 'object' ? sub.keys : {};
  if (!endpoint || endpoint.length > 1000) bad();
  let url;
  try { url = new URL(endpoint); } catch { bad(); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) bad();
  const host = url.hostname.toLowerCase();
  if (!PUSH_HOST_SUFFIXES.some(s => host === s || host.endsWith('.' + s))) {
    throw new PushError(400, 'Este navegador usa um serviço de notificação não suportado.', 'unsupported_push_service');
  }
  const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh.trim() : '';
  const auth = typeof keys.auth === 'string' ? keys.auth.trim() : '';
  const p = fromB64u(p256dh), a = fromB64u(auth);
  if (!/^[A-Za-z0-9_-]+=*$/.test(p256dh) || !/^[A-Za-z0-9_-]+=*$/.test(auth) || p.length !== 65 || p[0] !== 4 || a.length !== 16) bad();
  return { endpoint: url.href, p256dh, auth };
}

async function subscribe(sql, username, sub, userAgent) {
  if (!enabled()) throw new PushError(409, 'As notificações estão desligadas no servidor (faltam as chaves VAPID).', 'push_disabled');
  const s = validateSubscription(sub);
  const ua = String(userAgent || '').slice(0, 200) || null;
  // Mesmo endpoint de outro usuário (aparelho trocou de dono): passa para o usuário atual.
  const rows = await sql.query(
    `insert into admin_push_subscriptions (username, endpoint, p256dh, auth, user_agent)
     select $1::text, $2::text, $3::text, $4::text, $5::text
      where (select count(*) from admin_push_subscriptions where username = $1::text and endpoint <> $2::text) < $6::int
     on conflict (endpoint) do update set username = excluded.username, p256dh = excluded.p256dh, auth = excluded.auth,
            user_agent = excluded.user_agent, fail_count = 0, last_error = null
     returning id, created_at`, [username, s.endpoint, s.p256dh, s.auth, ua, MAX_PER_USER]);
  if (!rows.length) throw new PushError(409, `Limite de ${MAX_PER_USER} aparelhos com notificação por usuário. Desative em um aparelho antigo.`, 'push_limit');
  return { id: rows[0].id, created_at: new Date(rows[0].created_at).toISOString() };
}

// Remove a inscrição. Só a do próprio usuário (ou de qualquer um, se for admin). Idempotente.
async function unsubscribe(sql, user, endpoint) {
  if (typeof endpoint !== 'string' || !endpoint.trim() || endpoint.length > 1000) throw new PushError(400, 'Informe o aparelho.', 'invalid_subscription');
  const rows = await sql.query(
    `delete from admin_push_subscriptions where endpoint = $1 and (username = $2 or $3::boolean) returning id`,
    [endpoint.trim(), user.username, user.role === 'admin']);
  return { removed: rows.length };
}

async function countFor(sql, username) {
  const [r] = await sql.query('select count(*)::int n from admin_push_subscriptions where username = $1', [username]);
  return r.n;
}

// Envia uma mensagem (objeto JSON) para uma inscrição. Nunca lança: retorna { ok, status, gone }.
async function sendOne(row, message, { cfg = config(), fetchImpl = fetch, timeoutMs = SEND_TIMEOUT_MS } = {}) {
  if (!cfg) return { ok: false, status: 0, gone: false, error: 'disabled' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const body = encrypt(JSON.stringify(message), row.p256dh, row.auth);
    const res = await fetchImpl(row.endpoint, {
      method: 'POST', signal: ac.signal, redirect: 'error',
      headers: {
        Authorization: vapidHeader(row.endpoint, cfg), TTL: String(TTL_SECONDS), Urgency: 'high',
        'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream'
      },
      body
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status, gone: res.status === 404 || res.status === 410 };
  } catch (e) {
    return { ok: false, status: 0, gone: false, error: e && e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

// Envia para várias inscrições e faz a faxina (404/410 apaga, falha repetida apaga). Nunca lança.
async function sendMany(sql, rows, message, opts = {}) {
  const cfg = opts.cfg || config();
  if (!cfg || !rows.length) return { sent: 0, failed: 0, removed: 0 };
  const results = await Promise.all(rows.map(r => sendOne(r, message, { ...opts, cfg })));
  let sent = 0, failed = 0, removed = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = results[i];
    try {
      if (r.ok) {
        sent++;
        await sql.query('update admin_push_subscriptions set last_ok_at = now(), fail_count = 0, last_error = null where id = $1', [rows[i].id]);
      } else if (r.gone) {
        removed++;
        await sql.query('delete from admin_push_subscriptions where id = $1', [rows[i].id]);
      } else {
        failed++;
        const [u] = await sql.query(
          `update admin_push_subscriptions set fail_count = fail_count + 1, last_error = $2 where id = $1 returning fail_count`,
          [rows[i].id, String(r.error || 'http ' + r.status).slice(0, 60)]);
        if (u && u.fail_count >= MAX_FAILS) { removed++; await sql.query('delete from admin_push_subscriptions where id = $1', [rows[i].id]); }
      }
    } catch (e) {
      console.error('Falha ao atualizar inscrição de push:', e.message);
    }
  }
  return { sent, failed, removed };
}

const brl = cents => 'R$ ' + (cents / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
function paidMessage(order) {
  const code = order.public_code || order.code;
  return { title: `Pedido ${code} pago`, body: brl(order.total_cents), tag: `pedido-${code}`, url: '/admin/#pedidos' };
}

// Pedido pago (webhook e conferência): avisa todos os aparelhos inscritos UMA vez por pedido.
// Só pedidos das últimas 24 h e não cancelados (webhook atrasado de pedido antigo não dispara aviso).
// Nunca lança (o pagamento já foi gravado; o aviso é extra).
async function notifyPaid(sql, orderId, opts = {}) {
  try {
    const cfg = opts.cfg || config();
    if (!cfg) return { skipped: 'disabled' };
    const [order] = await sql.query(
      `update orders set push_notified_at = now()
        where id = $1 and push_notified_at is null and payment_status = 'approved'
          and fulfillment_status is distinct from 'cancelled' and created_at > now() - interval '24 hours'
        returning code, public_code, total_cents`, [orderId]);
    if (!order) return { skipped: 'already_or_not_eligible' };
    const rows = await sql.query('select id, endpoint, p256dh, auth from admin_push_subscriptions order by id limit 200');
    return await sendMany(sql, rows, paidMessage(order), { ...opts, cfg });
  } catch (e) {
    console.error('Falha ao enviar push de pedido pago:', e.message);
    return { skipped: 'error' };
  }
}

// Teste do painel: manda só para os aparelhos do próprio usuário.
async function sendTest(sql, username, opts = {}) {
  const cfg = opts.cfg || config();
  if (!cfg) throw new PushError(409, 'As notificações estão desligadas no servidor (faltam as chaves VAPID).', 'push_disabled');
  const rows = await sql.query('select id, endpoint, p256dh, auth from admin_push_subscriptions where username = $1 order by id', [username]);
  if (!rows.length) throw new PushError(409, 'Nenhum aparelho com notificação ativada para o seu usuário.', 'no_subscription');
  return sendMany(sql, rows, { title: 'Teste de notificação', body: 'Os avisos de pedido pago vão chegar assim.', tag: 'teste', url: '/admin/' }, { ...opts, cfg });
}

module.exports = {
  PushError, PUSH_HOST_SUFFIXES, MAX_PER_USER, config, enabled, publicKey, vapidHeader, encrypt, validateSubscription,
  subscribe, unsubscribe, countFor, sendOne, sendMany, paidMessage, notifyPaid, sendTest
};
