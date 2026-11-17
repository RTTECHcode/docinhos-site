'use strict';
// F6 M2/M5: lê os blocos [[headers]] do netlify.toml (fonte única dos cabeçalhos de segurança, CSP e Cache-Control).
// Usado pelo adaptador das Functions (respostas da API) e pelo servidor local (scripts/dev-server.js).
// Só entende o que o netlify.toml da loja usa: [[headers]] com for = "..." e [headers.values] com chave = "valor"
// (aspas duplas, sem aspas internas). Comentários com # fora de aspas. Qualquer outro bloco é ignorado.
const fs = require('node:fs');
const path = require('node:path');

function stripComment(line) {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inStr = !inStr;
    else if (line[i] === '#' && !inStr) return line.slice(0, i);
  }
  return line;
}

// Devolve [{ for: '/api/order', values: { 'Cache-Control': 'no-store' } }, ...] na ordem do arquivo.
function parseHeaders(text) {
  const rules = [];
  let current = null, section = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    if (line.startsWith('[')) {
      if (line === '[[headers]]') { current = { for: null, values: {} }; rules.push(current); section = 'headers'; }
      else if (line === '[headers.values]' && current) section = 'values';
      else { section = null; current = null; }
      continue;
    }
    const m = line.match(/^("?)([A-Za-z0-9_.-]+)\1\s*=\s*"([^"]*)"$/);
    if (!m || !current) continue;
    if (section === 'headers' && m[2] === 'for') current.for = m[3];
    else if (section === 'values') current.values[m[2]] = m[3];
  }
  return rules.filter(r => r.for);
}

// Padrão do Netlify: "*" casa qualquer coisa (inclusive "/"); o resto é literal.
function matches(pattern, urlPath) {
  const re = new RegExp('^' + pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(urlPath);
}

// Cabeçalhos de um caminho: todas as regras que casam, na ordem (a última vence em chave repetida).
function headersFor(rules, urlPath) {
  const out = {};
  for (const r of rules) if (matches(r.for, urlPath)) Object.assign(out, r.values);
  return out;
}

// Procura o netlify.toml: raiz do projeto (local) ou junto da Function empacotada (included_files).
function loadRules(candidates) {
  const list = candidates || [
    path.resolve(__dirname, '..', '..', 'netlify.toml'),
    path.join(process.cwd(), 'netlify.toml')
  ];
  for (const file of list) {
    try { return parseHeaders(fs.readFileSync(file, 'utf8')); } catch { /* tenta o próximo */ }
  }
  return null;
}

module.exports = { parseHeaders, matches, headersFor, loadRules };
