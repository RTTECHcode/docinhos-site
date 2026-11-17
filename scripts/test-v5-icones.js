// Testes sem banco do ícone ilustrado das categorias (v5).
// node scripts/test-v5-icones.js
'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FALHA', name, '\n       ', e && e.message); }
}

(async () => {
  const icons = require('../api/_lib/category-icons');
  const ROOT = path.resolve(__dirname, '..');
  const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');

  await t('toda chave tem arquivo SVG em public/images/icones e animação no CSS da loja', () => {
    for (const i of icons.CATEGORY_ICONS) {
      assert.match(i.key, /^[a-z]+$/, i.key);
      const file = path.join(ROOT, 'public/images/icones', i.key + '.svg');
      assert.ok(fs.existsSync(file), 'falta ' + file);
      assert.match(fs.readFileSync(file, 'utf8'), /^<svg[\s\S]*<\/svg>\s*$/, i.key + ' não é SVG');
      assert.ok(css.includes('.cat-ico.anim-' + i.anim + ' '), 'sem animação ' + i.anim);
    }
  });
  await t('chaves únicas', () => {
    const keys = icons.CATEGORY_ICONS.map(i => i.key);
    assert.equal(new Set(keys).size, keys.length);
  });
  await t('parseIcon: vazio e null limpam; chave desconhecida é recusada', () => {
    assert.equal(icons.parseIcon(''), null);
    assert.equal(icons.parseIcon(null), null);
    assert.equal(icons.parseIcon('acai'), 'acai');
    for (const v of ['ACAI', '../x', 'acai.svg', 1, {}, 'bomba']) assert.throws(() => icons.parseIcon(v), /Ícone inválido/);
  });
  await t('iconInfo: caminho fixo em /images/icones; chave inválida vira null', () => {
    assert.deepEqual(icons.iconInfo('copo'), { key: 'copo', src: '/images/icones/copo.svg', anim: 'pula' });
    assert.equal(icons.iconInfo('nada'), null);
    assert.equal(icons.iconInfo(null), null);
  });
  await t('sugestão pelo nome (migração)', () => {
    assert.equal(icons.suggestIcon('Para família'), 'brigadeiro');
    assert.equal(icons.suggestIcon('Açaí'), 'acai');
    assert.equal(icons.suggestIcon('Copos da felicidade'), 'copo');
    assert.equal(icons.suggestIcon('Doces no pote'), 'pote');
    assert.equal(icons.suggestIcon('Geladinhos Gourmet'), 'geladinho');
    assert.equal(icons.suggestIcon('Salgados'), null);
  });

  console.log(`\n${pass} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})();
