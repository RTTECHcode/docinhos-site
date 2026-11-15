// Testes sem banco da migração para a Netlify (F6): ambiente (M3), endereço do site (M4), adaptador das Functions (M1),
// netlify.toml (M2) e servidor local (M5). Não precisa de netlify-cli: o evento da Function é simulado.
// node scripts/test-netlify.js
'use strict';
const assert = require('node:assert');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FALHA', name, '\n       ', e && e.message); }
}

(async () => {
  console.log('M3: ambiente (APP_ENV, fail-closed)');
  const env = require('../api/_lib/env');
  await t('produção a menos que APP_ENV seja development/preview ou NODE_ENV=test', () => {
    assert.equal(env.isProduction({}), true, 'sem variável');
    assert.equal(env.isProduction({ APP_ENV: '' }), true);
    assert.equal(env.isProduction({ APP_ENV: 'production' }), true);
    assert.equal(env.isProduction({ APP_ENV: 'prod' }), true, 'erro de digitação = produção');
    assert.equal(env.isProduction({ APP_ENV: 'staging' }), true);
    assert.equal(env.isProduction({ VERCEL_ENV: 'preview' }), true, 'VERCEL_ENV não conta mais');
    assert.equal(env.isProduction({ APP_ENV: 'development' }), false);
    assert.equal(env.isProduction({ APP_ENV: ' Preview ' }), false);
    assert.equal(env.isProduction({ NODE_ENV: 'test' }), false);
    assert.equal(env.appEnv({ APP_ENV: 'preview', NODE_ENV: 'test' }), 'preview');
  });
  await t('nenhum VERCEL_ENV sobrou em api/', () => {
    const fs = require('node:fs'), path = require('node:path');
    const dir = path.join(__dirname, '..', 'api');
    const files = [...fs.readdirSync(dir).filter(f => f.endsWith('.js')).map(f => path.join(dir, f)),
      ...fs.readdirSync(path.join(dir, '_lib')).filter(f => f.endsWith('.js') && f !== 'env.js').map(f => path.join(dir, '_lib', f))];
    for (const f of files) assert.ok(!fs.readFileSync(f, 'utf8').includes('VERCEL_ENV'), f);
  });

  console.log('M4: endereço do site');
  await t('SITE_URL padrão = domínio próprio; variável válida vence; inválida cai no padrão', () => {
    const site = require('../api/_lib/site');
    assert.equal(site.DEFAULT_SITE_URL, 'https://docinhosdagigioz.com.br');
    assert.equal(site.siteUrl({}), 'https://docinhosdagigioz.com.br');
    assert.equal(site.siteUrl({ SITE_URL: 'https://docinhos-site.vercel.app/' }), 'https://docinhos-site.vercel.app');
    assert.equal(site.siteUrl({ SITE_URL: 'http://evil.example.com' }), 'https://docinhosdagigioz.com.br');
    assert.equal(site.siteUrl({ SITE_URL: 'http://localhost:3402' }), 'http://localhost:3402');
  });
  await t('e-mail sintético do Pix e USER_AGENT no domínio da loja', () => {
    assert.equal(require('../api/order')._internal.pixPayerEmail('DG0123'), 'pedido-dg0123@docinhosdagigioz.com.br');
    assert.equal(require('../api/_lib/shipping').USER_AGENT, 'DocinhosDaGigi/1.0 (+https://docinhosdagigioz.com.br)');
  });

  console.log(`\n${pass} ok, ${fail} falha(s)`);
  if (fail) process.exitCode = 1;
})();
