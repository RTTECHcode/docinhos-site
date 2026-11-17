// Teste puro (sem banco, sem servidor): tipos MIME do servidor local (scripts/dev-server.js).
// Uso: node scripts/test-dev-server-mime.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MIME, mimeOf } = require('./dev-server');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('ok   -', name); }
  catch (e) { failed++; console.error('FAIL -', name, '\n      ', e.message); process.exitCode = 1; }
}

t('tipos pedidos pelo A3 e conferidos na F3', () => {
  assert.equal(mimeOf('public/admin/manifest.webmanifest'), 'application/manifest+json');
  assert.equal(mimeOf('public/admin/pedido.wav'), 'audio/wav');
  assert.equal(mimeOf('public/images/foto.AVIF'), 'image/avif');
  assert.equal(mimeOf('public/robots.txt'), 'text/plain; charset=utf-8');
  assert.equal(mimeOf('public/sitemap.xml'), 'application/xml; charset=utf-8');
  assert.equal(mimeOf('public/x.desconhecido'), 'application/octet-stream');
});

t('toda extensão de arquivo em public/ tem tipo no MIME', () => {
  const exts = new Set();
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (path.extname(e.name)) exts.add(path.extname(e.name).toLowerCase());
    }
  };
  walk(path.join(__dirname, '..', 'public'));
  const missing = [...exts].filter(x => !MIME[x]);
  assert.deepEqual(missing, [], 'sem tipo: ' + missing.join(', '));
});

console.log(`${passed} passaram, ${failed} falharam`);
