// Testes sem banco das correções da revisão de segurança F5 (docs/planos/seguranca-v4-f5.md).
// node scripts/test-v4-f5-pure.js
'use strict';
const assert = require('node:assert');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FALHA', name, '\n       ', e && e.message); }
}

(async () => {
  console.log('F5-S-01: alerta do webhook');
  const monitor = require('../api/_lib/monitor');
  await t('health só acende com 3+ recusas depois do último aceito', () => {
    assert.equal(monitor.UNAUTHORIZED_ALERT_MIN, 3);
    assert.equal(monitor.webhookAlert(null), false);
    assert.equal(monitor.webhookAlert({ unauthorized_24h: 50, unauthorized_since_accepted_24h: 0 }), false, 'recusas antes de um aceito não acendem');
    assert.equal(monitor.webhookAlert({ unauthorized_24h: 2, unauthorized_since_accepted_24h: 2 }), false);
    assert.equal(monitor.webhookAlert({ unauthorized_24h: 3, unauthorized_since_accepted_24h: 3 }), true);
  });
  await t('limite de gravação de recusas: 5 por IP e 60 no geral, em 10 min; escopos registrados', () => {
    const w = require('../api/mp-webhook')._internal;
    assert.deepEqual([w.UNAUTH_WINDOW_MIN, w.UNAUTH_MAX_PER_IP, w.UNAUTH_MAX_GLOBAL], [10, 5, 60]);
    const { SCOPES } = require('../api/_lib/rate-limit');
    assert.ok(SCOPES.has('webhook_unauthorized') && SCOPES.has('webhook_unauthorized_global'));
  });

  console.log('F5-S-02: estorno de pagamento antigo não é ignorado');
  const payments = require('../api/_lib/payments');
  await t('isSuperseded: refunded/charged_back/approved nunca viram stale; pagamento atual sem exceção (F5-S-03)', () => {
    const at = new Date();
    const old = new Date(at.getTime() - 60000).toISOString();
    const o = { payment_attempt_at: at, payment_id: '111' };
    for (const st of ['refunded', 'charged_back', 'approved']) assert.equal(payments.isSuperseded({ id: 999, status: st, date_created: old }, o), false, st);
    assert.equal(payments.isSuperseded({ id: 111, status: 'expired', date_created: old }, o), true, 'Pix antigo ainda atual durante a chamada ao MP');
    assert.equal(payments.isSuperseded({ id: 111, status: 'refunded', date_created: old }, o), false, 'estorno do atual');
    for (const st of ['pending', 'in_process', 'rejected', 'cancelled', 'expired']) assert.equal(payments.isSuperseded({ id: 999, status: st, date_created: old }, o), true, st);
    assert.equal(payments.isSuperseded({ id: 999, status: 'cancelled', date_created: old }, { payment_attempt_at: at, payment_id: null }), true);
  });

  console.log('F5-S-05: IP fora da auditoria do staff');
  const adm = require('../api/admin')._internal;
  await t('ações com IP só para admin; IP mascarado no detalhe para staff', () => {
    for (const a of ['login_falhou', 'recuperacao_falhou', 'login_senha_curta_bloqueado', 'login_teto_diario']) assert.ok(adm.ADMIN_ONLY_AUDIT.includes(a), a);
    assert.equal(adm.maskIp('ip 203.0.113.7'), 'ip (oculto)');
    assert.equal(adm.maskIp('ip 2001:db8::1'), 'ip (oculto)');
    assert.equal(adm.maskIp('Pedido DG-0001 pago'), 'Pedido DG-0001 pago');
    assert.equal(adm.maskIp(null), null);
  });

  console.log('A6-02: instagram_url público');
  await t('publicInstagramUrl: só https://(www.)instagram.com com caminho; resto null', () => {
    const { publicInstagramUrl: ig } = require('../api/_lib/gifts');
    assert.equal(ig('https://www.instagram.com/docinhosdagigi'), 'https://www.instagram.com/docinhosdagigi');
    assert.equal(ig('  https://Instagram.com/docinhosdagigi/  '), 'https://instagram.com/docinhosdagigi/');
    for (const bad of [undefined, null, '', 42, 'https://instagram.com', 'https://instagram.com/', 'http://instagram.com/x',
      'https://instagram.com.evil.com/x', 'https://evilinstagram.com/x', 'https://m.instagram.com/x', 'https://u:p@instagram.com/x',
      'https://instagram.com:8443/x', 'javascript:alert(1)', 'https://instagram.com/x y', 'https://instagram.com/"x', 'https://instagram.com/' + 'a'.repeat(300)])
      assert.equal(ig(bad), null, String(bad));
  });

  console.log(`\n${pass} ok, ${fail} falha(s)`);
  if (fail) process.exitCode = 1;
})();
