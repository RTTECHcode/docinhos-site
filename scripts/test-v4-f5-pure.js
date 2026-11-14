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

  console.log(`\n${pass} ok, ${fail} falha(s)`);
  if (fail) process.exitCode = 1;
})();
