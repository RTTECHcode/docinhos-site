// Testes das funções de conta do cliente (api/_lib/customer.js, O10) e dos pontos (O11) no banco de desenvolvimento:
//   node -r ./scripts/dev-env.js scripts/test-customer.js
// Cria clientes "ZZ-TESTE ..." e apaga tudo no começo e no fim.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sql = require('../api/_lib/db');
const customer = require('../api/_lib/customer');
const loyalty = require('../api/_lib/loyalty');
const auth = require('../api/_lib/auth');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + String((e && e.message) || e).split('\n').slice(0, 4).join(' | ')); process.exitCode = 1; }
}
const Q = (text, params = []) => sql.query(text, params);
const rejects = async (promise, status, code) => {
  try { await promise; } catch (e) {
    assert.equal(e.status, status, `status ${e.status}: ${e.message}`);
    if (code) assert.equal(e.code, code);
    return e;
  }
  assert.fail('deveria ter falhado');
};
let ipN = 0;
const nextIp = () => `198.18.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}`;
const phoneOf = () => '119' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
const base = (over = {}) => ({ name: 'ZZ-TESTE Cliente', phone: phoneOf(), password: 'SenhaBoa-123', security_question: 'prof_favorito', security_answer: 'Dona Maria', ...over });
const cookieReq = token => ({ headers: { cookie: `${customer.COOKIE_NAME}=${token}` } });

async function cleanup() {
  await Q(`delete from loyalty_ledger where customer_id in (select id from customers where name like 'ZZ-TESTE%')`);
  await Q(`delete from customers where name like 'ZZ-TESTE%'`); // sessões e eventos de consentimento saem em cascata
  await Q(`delete from customer_login_attempts where ip like '198.18.%'`);
}

(async () => {
  await cleanup();

  console.log('\nCadastro');
  let acc, ctx;
  await t('cria conta com pergunta e resposta, abre sessão; senha e resposta só em hash; consentimento NÃO vem marcado', async () => {
    ctx = { ip: nextIp(), ua: 'teste' };
    const input = base();
    acc = await customer.createAccount(sql, input, ctx);
    assert.ok(acc.token && acc.token.length >= 32);
    assert.equal(acc.customer.whatsapp_consent, false);
    assert.ok(!('password_hash' in acc.customer) && !JSON.stringify(acc.customer).includes('scrypt'));
    assert.equal(acc.customer.phone, '+55' + input.phone);
    const row = (await Q('select password_hash, security_answer_hash from customers where id = $1', [acc.customer.id]))[0];
    assert.ok(row.password_hash.startsWith('scrypt$32768$8$1$') && row.security_answer_hash.startsWith('scrypt$'));
    assert.ok(!/maria/i.test(row.security_answer_hash));
    assert.equal((await Q('select count(*)::int n from customer_consent_events where customer_id = $1', [acc.customer.id]))[0].n, 0, 'sem aceite, sem evento');
    assert.equal((await Q('select count(*)::int n from customer_sessions where customer_id = $1', [acc.customer.id]))[0].n, 1);
    acc.input = input;
  });
  await t('consentimento marcado de propósito grava texto, versão, IP e evento opt_in', async () => {
    const c = await customer.createAccount(sql, base({ whatsapp_consent: true }), { ip: nextIp(), source: 'cadastro' });
    assert.equal(c.customer.whatsapp_consent, true);
    const r = (await Q('select whatsapp_consent_text, whatsapp_consent_version, whatsapp_consent_ip from customers where id = $1', [c.customer.id]))[0];
    assert.equal(r.whatsapp_consent_text, customer.CONSENT_TEXT); assert.equal(r.whatsapp_consent_version, customer.CONSENT_VERSION);
    const ev = await Q('select action, text_version, source from customer_consent_events where customer_id = $1', [c.customer.id]);
    assert.deepEqual(ev.map(e => e.action), ['opt_in']); assert.equal(ev[0].source, 'cadastro'); assert.equal(ev[0].text_version, customer.CONSENT_VERSION);
    for (const v of ['true', 1, 'sim', null]) await rejects(customer.createAccount(sql, base({ whatsapp_consent: v }), { ip: nextIp() }), 400, 'invalid_consent');
  });
  await t('validações: telefone, senha curta, pergunta fora da lista, resposta curta, nascimento, nome, e-mail; telefone duplicado -> 409', async () => {
    const bad = async over => rejects(customer.createAccount(sql, base(over), { ip: nextIp() }), 400);
    await bad({ phone: '123' }); await bad({ phone: '11 8 1234 5678' }); await bad({ password: 'curta' });
    await bad({ security_question: 'nome_da_mae' }); await bad({ security_question: undefined }); await bad({ security_answer: 'ab' }); await bad({ security_answer: undefined });
    await bad({ birth_day: 31, birth_month: 2 }); await bad({ birth_day: 5 }); await bad({ name: 'x' }); await bad({ email: 'sem-arroba' });
    const dup = await rejects(customer.createAccount(sql, { ...base(), phone: acc.input.phone }, { ip: nextIp() }), 409, 'duplicate');
    assert.match(dup.message, /Entre ou recupere/);
    const ok = await customer.createAccount(sql, base({ birth_day: 29, birth_month: 2, email: 'zz-teste@example.com' }), { ip: nextIp() });
    assert.deepEqual([ok.customer.birth_day, ok.customer.birth_month, ok.customer.email], [29, 2, 'zz-teste@example.com']);
  });

  console.log('\nLogin e sessão');
  await t('login certo abre sessão; getSession lê o cookie; sair derruba; token desconhecido não entra', async () => {
    const l = await customer.login(sql, { phone: acc.input.phone, password: acc.input.password }, { ip: nextIp(), ua: 'x' });
    const s = await customer.getSession(sql, cookieReq(l.token));
    assert.equal(s.customer.id, acc.customer.id);
    assert.equal(await customer.getSession(sql, cookieReq('naoexiste')), null);
    assert.equal(await customer.getSession(sql, { headers: {} }), null);
    const clear = await customer.logoutFromRequest(sql, cookieReq(l.token));
    assert.match(clear, /^__Host-dg_cliente=; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=0/);
    assert.equal(await customer.getSession(sql, cookieReq(l.token)), null);
    assert.match(customer.sessionCookie('abc'), /^__Host-dg_cliente=abc; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=2592000$/);
  });
  await t('senha errada e telefone inexistente: mesma mensagem 401; 5 erros bloqueiam 30 min (telefone e IP); dados certos também barram', async () => {
    const ip = nextIp();
    const wrong = await rejects(customer.login(sql, { phone: acc.input.phone, password: 'errada-123' }, { ip }), 401, 'bad_login');
    const none = await rejects(customer.login(sql, { phone: phoneOf(), password: 'errada-123' }, { ip: nextIp() }), 401, 'bad_login');
    assert.equal(wrong.message, none.message);
    for (let i = 0; i < 3; i++) await rejects(customer.login(sql, { phone: acc.input.phone, password: 'errada-123' }, { ip }), 401);
    const fifth = await rejects(customer.login(sql, { phone: acc.input.phone, password: 'errada-123' }, { ip }), 429, 'locked');
    assert.match(fifth.message, /30 minutos/);
    await rejects(customer.login(sql, { phone: acc.input.phone, password: acc.input.password }, { ip }), 429, 'locked');
    await rejects(customer.login(sql, { phone: acc.input.phone, password: acc.input.password }, { ip: nextIp() }), 429, 'locked'); // outro IP, mesmo telefone
    const other = await customer.createAccount(sql, base(), { ip: nextIp() });
    await rejects(customer.login(sql, { phone: other.customer.phone.slice(3), password: 'SenhaBoa-123' }, { ip }), 429, 'locked'); // mesmo IP, outro telefone
    await Q(`update customer_login_attempts set at = now() - interval '31 minutes' where phone = $1 or ip = $2`, ['+55' + acc.input.phone, ip]);
    const back = await customer.login(sql, { phone: acc.input.phone, password: acc.input.password }, { ip });
    assert.equal(back.customer.id, acc.customer.id, 'depois de 30 min libera');
  });

  console.log('\nRecuperação e troca de senha');
  await t('recoveryQuestion: pergunta real; telefone inexistente recebe pergunta falsa estável da lista', async () => {
    const real = await customer.recoveryQuestion(sql, { phone: acc.input.phone });
    assert.equal(real.question_id, 'prof_favorito'); assert.match(real.question, /professor/);
    const f1 = await customer.recoveryQuestion(sql, { phone: '11900000001' }), f2 = await customer.recoveryQuestion(sql, { phone: '11900000001' });
    assert.deepEqual(f1, f2); assert.ok(auth.QUESTION_IDS.includes(f1.question_id));
  });
  await t('recover: resposta errada = mensagem genérica; 5 erros bloqueiam; resposta certa troca a senha, derruba sessões e trava pontos 48 h', async () => {
    const ip = nextIp();
    const e1 = await rejects(customer.recover(sql, { phone: acc.input.phone, answer: 'outra', new_password: 'NovaSenha-456' }, { ip }), 400, 'bad_recovery');
    const e2 = await rejects(customer.recover(sql, { phone: phoneOf(), answer: 'outra', new_password: 'NovaSenha-456' }, { ip }), 400, 'bad_recovery');
    assert.equal(e1.message, e2.message);
    for (let i = 0; i < 2; i++) await rejects(customer.recover(sql, { phone: acc.input.phone, answer: 'outra', new_password: 'NovaSenha-456' }, { ip }), 400);
    await rejects(customer.recover(sql, { phone: acc.input.phone, answer: 'outra', new_password: 'NovaSenha-456' }, { ip }), 429, 'locked');
    await rejects(customer.recover(sql, { phone: acc.input.phone, answer: 'dona maria', new_password: 'NovaSenha-456' }, { ip }), 429, 'locked');
    await Q(`update customer_login_attempts set at = now() - interval '31 minutes' where ip = $1`, [ip]);
    const before = await customer.login(sql, { phone: acc.input.phone, password: acc.input.password }, { ip: nextIp() });
    const r = await customer.recover(sql, { phone: acc.input.phone, answer: '  DONA   maria ', new_password: 'NovaSenha-456' }, { ip });
    assert.equal(r.ok, true);
    const hours = (new Date(r.points_locked_until).getTime() - Date.now()) / 3600e3;
    assert.ok(hours > 47.9 && hours <= 48.01, 'bloqueio de 48 h: ' + hours);
    assert.equal(await customer.getSession(sql, cookieReq(before.token)), null, 'sessões derrubadas');
    await rejects(customer.login(sql, { phone: acc.input.phone, password: acc.input.password }, { ip: nextIp() }), 401);
    const again = await customer.login(sql, { phone: acc.input.phone, password: 'NovaSenha-456' }, { ip: nextIp() });
    assert.ok(again.token);
    acc.input.password = 'NovaSenha-456'; acc.token = again.token;
    assert.ok((await customer.getProfile(sql, acc.customer.id)).points_locked_until, 'perfil informa o bloqueio dos pontos');
  });
  await t('changePassword exige a senha atual, mantém a sessão atual e derruba as outras; changeSecurity exige a senha atual', async () => {
    const s2 = await customer.login(sql, { phone: acc.input.phone, password: acc.input.password }, { ip: nextIp() });
    const keep = auth.sha256(acc.token);
    await rejects(customer.changePassword(sql, acc.customer.id, { current_password: 'errada-xx', new_password: 'Outra-Senha-9' }, keep), 400, 'bad_password');
    await rejects(customer.changePassword(sql, acc.customer.id, { current_password: acc.input.password, new_password: acc.input.password }, keep), 400);
    await rejects(customer.changePassword(sql, acc.customer.id, { current_password: acc.input.password, new_password: 'curta' }, keep), 400);
    assert.deepEqual(await customer.changePassword(sql, acc.customer.id, { current_password: acc.input.password, new_password: 'Outra-Senha-9' }, keep), { ok: true });
    assert.ok(await customer.getSession(sql, cookieReq(acc.token)), 'sessão atual continua');
    assert.equal(await customer.getSession(sql, cookieReq(s2.token)), null, 'as outras caem');
    acc.input.password = 'Outra-Senha-9';
    await rejects(customer.changeSecurity(sql, acc.customer.id, { current_password: 'errada', security_question: 'melhor_amigo', security_answer: 'Beto' }), 400, 'bad_password');
    await rejects(customer.changeSecurity(sql, acc.customer.id, { current_password: acc.input.password, security_question: 'fora', security_answer: 'Beto' }), 400);
    await customer.changeSecurity(sql, acc.customer.id, { current_password: acc.input.password, security_question: 'melhor_amigo', security_answer: 'Beto da Silva' });
    assert.equal((await customer.recoveryQuestion(sql, { phone: acc.input.phone })).question_id, 'melhor_amigo');
  });

  console.log('\nPerfil e consentimento de WhatsApp');
  await t('setWhatsappConsent liga e desliga gravando um evento por mudança; repetir o mesmo estado não grava', async () => {
    const id = acc.customer.id;
    assert.equal((await customer.setWhatsappConsent(sql, id, false, { ip: '198.18.9.9' })).whatsapp_consent, false);
    assert.equal((await Q('select count(*)::int n from customer_consent_events where customer_id = $1', [id]))[0].n, 0);
    const on = await customer.setWhatsappConsent(sql, id, true, { ip: '198.18.9.9' });
    assert.equal(on.whatsapp_consent, true); assert.ok(on.whatsapp_consent_at);
    await customer.setWhatsappConsent(sql, id, true, { ip: '198.18.9.9' });
    const off = await customer.setWhatsappConsent(sql, id, false, { ip: '198.18.9.9', source: 'whatsapp_sair' });
    assert.equal(off.whatsapp_consent, false); assert.ok(off.whatsapp_opt_out_at);
    const ev = await Q('select action, source from customer_consent_events where customer_id = $1 order by id', [id]);
    assert.deepEqual(ev.map(e => e.action), ['opt_in', 'opt_out']); assert.equal(ev[1].source, 'whatsapp_sair');
    await rejects(customer.setWhatsappConsent(sql, id, 'sim'), 400, 'invalid_consent');
  });
  await t('updateProfile: edita nome, e-mail e nascimento; vazio -> 400; e-mail repetido -> 409', async () => {
    const id = acc.customer.id;
    const p = await customer.updateProfile(sql, id, { name: 'ZZ-TESTE Novo Nome', email: 'zz-teste-novo@example.com', birth_day: 10, birth_month: 11 });
    assert.deepEqual([p.name, p.email, p.birth_day, p.birth_month], ['ZZ-TESTE Novo Nome', 'zz-teste-novo@example.com', 10, 11]);
    await rejects(customer.updateProfile(sql, id, {}), 400);
    const other = await customer.createAccount(sql, base(), { ip: nextIp() });
    await rejects(customer.updateProfile(sql, other.customer.id, { email: 'zz-teste-novo@example.com' }), 409, 'duplicate');
  });

  console.log('\nPontos');
  await t('getPoints: saldo vem da soma do ledger; ajuste soma; reserva e devolução; bloqueio aparece', async () => {
    const id = acc.customer.id;
    const p0 = await customer.getPoints(sql, id);
    assert.deepEqual([p0.balance, p0.reserved, p0.earned_total], [0, 0, 0]);
    assert.deepEqual([p0.points_per_real, p0.block_points, p0.block_value_cents], [1, 100, 1000]);
    await loyalty.adjust(sql, { customerId: id, points: 250, note: 'ZZ-TESTE ajuste' });
    const p1 = await customer.getPoints(sql, id);
    assert.equal(p1.balance, 250); assert.equal(p1.history[0].kind, 'adjust'); assert.equal(p1.history[0].points, 250);
    assert.ok(p1.locked_until, 'bloqueio de 48 h da recuperação');
    assert.equal(await customer.listOrders(sql, id).then(r => r.length), 0);
  });
  await t('regras puras: ganho 1 por R$ 1,00 sem frete, blocos de 100, desconto nunca passa do subtotal, bloqueio recusa', () => {
    assert.equal(loyalty.earnPoints(2599, 0), 25); assert.equal(loyalty.earnPoints(2000, 1000), 10); assert.equal(loyalty.earnPoints(500, 1000), 0);
    assert.equal(loyalty.discountForPoints(300), 3000);
    assert.equal(loyalty.maxRedeemablePoints(2599, 900), 200);
    assert.deepEqual(loyalty.validateRedemption({ points: 100, subtotalCents: 2000, balance: 250 }), { points: 100, discount_cents: 1000 });
    const thrown = (args, status, code) => { try { loyalty.validateRedemption(args); } catch (e) { assert.deepEqual([e.status, e.code], [status, code]); return; } assert.fail('devia falhar'); };
    thrown({ points: 150, subtotalCents: 5000, balance: 500 }, 400, 'invalid_block');
    thrown({ points: 300, subtotalCents: 5000, balance: 200 }, 409, 'insufficient_points');
    thrown({ points: 200, subtotalCents: 1500, balance: 500 }, 400, 'discount_too_big');
    thrown({ points: 100, subtotalCents: 5000, balance: 500, lockedUntil: new Date(Date.now() + 3600e3) }, 423, 'points_locked');
    thrown({ points: -100, subtotalCents: 5000, balance: 500 }, 400, 'invalid_points');
  });

  await cleanup();
  console.log(`\n${passed} passaram, ${failed} falharam`);
})().catch(async e => { console.error(e); process.exitCode = 1; try { await cleanup(); } catch { /* ignora */ } });
