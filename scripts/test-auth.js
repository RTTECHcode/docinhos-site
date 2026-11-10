// Testes puros (sem banco) de api/_lib/auth.js: node scripts/test-auth.js
const assert = require('node:assert/strict');
const auth = require('../api/_lib/auth');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('ok   -', name); }
  catch (e) { console.error('FAIL -', name, '\n      ', e.message); process.exitCode = 1; }
}

(async () => {
  await test('senha: scrypt N=32768 r=8 p=1, sal aleatório, verifica certo e errado', async () => {
    const h1 = await auth.hashPassword('minha senha 123'), h2 = await auth.hashPassword('minha senha 123');
    const [alg, N, r, p, salt, dk] = h1.split('$');
    assert.deepEqual([alg, N, r, p], ['scrypt', '32768', '8', '1']);
    assert.ok(salt && dk);
    assert.notEqual(h1, h2, 'sal diferente a cada hash');
    assert.ok(!h1.includes('minha senha'));
    assert.equal(await auth.verifyPassword('minha senha 123', h1), true);
    assert.equal(await auth.verifyPassword('minha senha 124', h1), false);
    assert.equal(await auth.verifyPassword('', h1), false);
    assert.equal(await auth.verifyPassword('x', 'lixo'), false);
    assert.equal(await auth.verifyPassword('x', null), false);
  });

  await test('senha: 8 a 128 caracteres, só texto', () => {
    assert.equal(auth.validatePassword('12345678'), '12345678');
    for (const v of ['1234567', '', null, 12345678, 'x'.repeat(129)]) assert.throws(() => auth.validatePassword(v), auth.AuthError);
  });

  await test('resposta de segurança: normaliza (minúsculas, sem acento, trim, espaços colapsados)', () => {
    assert.equal(auth.normalizeAnswer('  Dona   MARÍA  da  Conceição '), 'dona maria da conceicao');
    assert.equal(auth.normalizeAnswer('Ação'), 'acao');
    assert.equal(auth.normalizeAnswer(null), '');
  });

  await test('resposta: mínimo 3 caracteres depois de normalizar; guarda só hash', async () => {
    for (const v of ['', 'ab', '  ab  ', 12345, null, 'x'.repeat(201)]) assert.throws(() => auth.validateAnswer(v), auth.AuthError, String(v));
    assert.equal(auth.validateAnswer(' Ana '), 'ana');
    const h = await auth.hashAnswer('Dona Maria');
    assert.ok(h.startsWith('scrypt$') && !/maria/i.test(h));
    assert.equal(await auth.verifyAnswer('  dona   MARIA ', h), true);
    assert.equal(await auth.verifyAnswer('dóna maria', h), true);
    assert.equal(await auth.verifyAnswer('dona mario', h), false);
    assert.equal(await auth.verifyAnswer('ab', h), false);
    assert.equal(await auth.verifyAnswer(undefined, h), false);
  });

  await test('lista fixa de perguntas: ids válidos; fora da lista é recusado; textos sem resposta pública', () => {
    assert.ok(auth.SECURITY_QUESTIONS.length >= 6);
    for (const q of auth.SECURITY_QUESTIONS) {
      assert.equal(auth.validateQuestionId(q.id), q.id);
      assert.ok(q.text.endsWith('?'));
      assert.ok(!/m[ãa]e|cidade|nascimento|cpf|pet|cachorro/i.test(q.text), 'pergunta com resposta pública: ' + q.text);
    }
    for (const v of ['qualquer', '', null, 5, 'constructor']) assert.throws(() => auth.validateQuestionId(v), auth.AuthError);
  });

  await test('pergunta falsa para conta inexistente é estável e vem da lista', () => {
    const a = auth.fakeQuestionFor('admin', 'ninguem'), b = auth.fakeQuestionFor('admin', 'ninguem');
    assert.equal(a, b);
    assert.ok(auth.QUESTION_IDS.includes(a));
    assert.ok(auth.QUESTION_IDS.includes(auth.fakeQuestionFor('cliente', '+5511999999999')));
  });

  await test('códigos de recuperação: 10 códigos únicos, formato legível, hash scrypt, uso único por id', async () => {
    const codes = await auth.generateRecoveryCodes();
    assert.equal(codes.length, auth.RECOVERY_CODE_COUNT);
    assert.equal(auth.RECOVERY_CODE_COUNT, 10);
    assert.equal(new Set(codes.map(c => c.code)).size, 10);
    for (const c of codes) {
      assert.match(c.code, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
      assert.ok(c.hash.startsWith('scrypt$') && !c.hash.includes(c.code.replace(/-/g, '')));
    }
    const cands = codes.map((c, i) => ({ id: i + 1, code_hash: c.hash }));
    assert.equal(await auth.matchRecoveryCode(codes[3].code, cands), 4);
    assert.equal(await auth.matchRecoveryCode(codes[3].code.toLowerCase().replace(/-/g, ' '), cands), 4, 'tolera minúsculas e separadores');
    assert.equal(await auth.matchRecoveryCode('AAAA-BBBB-CCCC', cands), null);
    assert.equal(await auth.matchRecoveryCode('curto', cands), null);
    assert.equal(await auth.matchRecoveryCode(codes[3].code, cands.filter(c => c.id !== 4)), null, 'código já usado não confere');
    assert.equal(await auth.matchRecoveryCode(codes[0].code, []), null);
  });

  await test('bloqueio por tentativas: 3 erros -> 1 h; 5 erros -> 30 min; expira; janela por falha mais recente', () => {
    const now = 10_000_000_000, H = 3600e3, M = 60e3;
    const lock = (fails, max, lockMs, at = now) => auth.evaluateAttemptLock({ failsMs: fails, nowMs: at, max, lockMs });
    assert.equal(lock([now - M, now - 2 * M], 3, H).locked, false);
    const l3 = lock([now - M, now - 2 * M, now - 3 * M], 3, H);
    assert.equal(l3.locked, true);
    assert.equal(l3.until, now - M + H);
    assert.equal(lock([now - M, now - 2 * M, now - 3 * M], 3, H, now - M + H).locked, false, 'terminou');
    assert.equal(lock([now - M, now - 2 * M, now - 3 * M], 3, H, now - M + H - 1).locked, true);
    assert.equal(lock([now - 2 * H, now - 2 * H - M, now - 2 * H - 2 * M], 3, H).locked, false, 'falhas antigas');
    assert.equal(lock([now - M, now - 2 * H, now - 3 * H], 3, H).locked, false, 'só 1 falha na janela');
    assert.equal(lock([1, 2, 3, 4], 5, 30 * M).locked, false);
    assert.equal(lock([now, now - 1, now - 2, now - 3, now - 4], 5, 30 * M).locked, true);
    assert.equal(lock([], 3, H).locked, false);
    assert.equal(lock(undefined, 3, H).locked, false);
  });

  await test('cookies, IP e CSRF', () => {
    assert.deepEqual(auth.parseCookies('a=1; __Host-dg_cliente=abc; b=x=y'), { a: '1', '__Host-dg_cliente': 'abc', b: 'x=y' });
    assert.deepEqual(auth.parseCookies(undefined), {});
    assert.equal(auth.clientIp({ headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } }), '203.0.113.9');
    assert.equal(auth.clientIp({ headers: {}, socket: { remoteAddress: '::1' } }), '::1');
    assert.equal(auth.clientIp({ headers: {} }), 'unknown');
    // x-real-ip (preenchido pela Vercel) vale mais que o x-forwarded-for, que o cliente pode forjar
    assert.equal(auth.clientIp({ headers: { 'x-real-ip': '198.51.100.7', 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } }), '198.51.100.7');
    assert.equal(auth.clientIp({ headers: { 'x-real-ip': '  ', 'x-forwarded-for': '203.0.113.9' } }), '203.0.113.9');
    assert.equal(auth.clientIp(undefined), 'unknown');
    const c = auth.buildCookie('__Host-dg_cliente', 'tok', { maxAge: 60, sameSite: 'Lax' });
    assert.equal(c, '__Host-dg_cliente=tok; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=60');
    assert.ok(/SameSite=Strict/.test(auth.buildCookie('s', 't', { maxAge: 1 })));
    assert.equal(auth.sameOrigin({ headers: { origin: 'https://x.com', host: 'x.com' } }), true);
    assert.equal(auth.sameOrigin({ headers: { origin: 'https://evil.com', host: 'x.com' } }), false);
    assert.equal(auth.sameOrigin({ headers: { host: 'x.com' } }), false);
    assert.equal(auth.sameOrigin({ headers: { origin: 'https://x.com', host: 'x.com', 'sec-fetch-site': 'cross-site' } }), false);
    assert.equal(auth.isJsonType({ headers: { 'content-type': 'application/json; charset=utf-8' } }), true);
    assert.equal(auth.isJsonType({ headers: { 'content-type': 'text/plain' } }), false);
  });

  await test('tokens: 32 bytes aleatórios, só o SHA-256 vai ao banco', () => {
    const t = auth.newToken();
    assert.ok(t && typeof t === 'object' ? (t.token && t.hash) : typeof t === 'string');
    assert.equal(auth.sha256('a'), 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
  });

  console.log(`\n${passed} testes passaram${process.exitCode ? ' (com falhas)' : ''}`);
})();
