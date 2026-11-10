// Carrega variáveis SOMENTE de .env.dev (banco de desenvolvimento). Nunca lê .env (produção).
// Procura .env.dev na pasta do projeto; em worktrees, usa o .env.dev da pasta principal do repositório.
// Uso em testes: node -r ./scripts/dev-env.js scripts/test-admin.js
// Os valores nunca são impressos.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function findEnvDev() {
  const local = path.join(ROOT, '.env.dev');
  if (fs.existsSync(local)) return local;
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const main = path.join(path.dirname(common), '.env.dev');
    if (fs.existsSync(main)) return main;
  } catch { /* sem git */ }
  return null;
}

function loadEnvDev() {
  if (process.env.DATABASE_URL && process.env.GIGI_ENV_LOADED) return [];
  const file = findEnvDev();
  if (!file) {
    console.warn('AVISO: .env.dev não encontrado. APIs que usam banco vão falhar.');
    return [];
  }
  const names = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v.startsWith('<') && v.endsWith('>')) v = v.slice(1, -1); // tolera valor colado dentro de <...> do modelo
    process.env[m[1]] = v;
    names.push(m[1]);
  }
  process.env.GIGI_ENV_LOADED = '1';
  return names;
}

module.exports = { loadEnvDev, loaded: loadEnvDev() };
