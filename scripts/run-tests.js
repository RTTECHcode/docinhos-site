// Roda os scripts/test-*.js em SEQUENCIA (nunca em paralelo: varios usam o banco dev).
// Uso: node scripts/run-tests.js [--continuar] [--puro] [filtro]
// Cada teste roda com `node -r ./scripts/dev-env.js` (so le o arquivo de dev, nunca o de producao).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PUROS = ['test-netlify', 'test-v5-icones', 'test-v4-f5-pure', 'test-v4-qa-status', 'test-order-pricing', 'test-dev-server-mime', 'test-mp-webhook'];

const args = process.argv.slice(2);
const continuar = args.includes('--continuar');
const puro = args.includes('--puro');
const filtro = args.find(a => !a.startsWith('--'));

let files = fs.readdirSync(__dirname).filter(f => /^test-.*\.js$/.test(f)).map(f => f.replace(/\.js$/, '')).sort();
if (puro) files = PUROS.filter(f => files.includes(f));
if (filtro) files = files.filter(f => f.includes(filtro));

const resumo = [];
for (const name of files) {
  console.log(`\n=== ${name} ===`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['-r', './scripts/dev-env.js', path.join('scripts', name + '.js')], { cwd: ROOT, stdio: 'inherit' });
  const ok = r.status === 0;
  resumo.push({ name, ok, s: ((Date.now() - t0) / 1000).toFixed(1) });
  if (!ok && !continuar) break;
}

console.log('\n--- Resumo ---');
for (const x of resumo) console.log(`${x.ok ? 'OK   ' : 'FALHA'} ${x.name} (${x.s}s)`);
const falhas = resumo.filter(x => !x.ok).length;
const naoRodou = files.length - resumo.length;
if (naoRodou) console.log(`${naoRodou} teste(s) nao rodaram (parou no primeiro erro; use --continuar).`);
console.log(falhas ? `${falhas} falha(s).` : `${resumo.length} teste(s) passaram.`);
process.exit(falhas ? 1 : 0);
