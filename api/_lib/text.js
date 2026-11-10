'use strict';
// Normalização de texto em português (sem acentos, minúsculas) usada pelo painel e pela busca de ingredientes.

function norm(s) {
  return String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
const words = s => { const n = norm(s); return n ? n.split(' ') : []; };
function stem(w) {
  if (w.length > 4 && (w.endsWith('oes') || w.endsWith('aes'))) return w.slice(0, -3) + 'ao';
  if (w.length > 4 && w.endsWith('ais')) return w.slice(0, -3) + 'al';
  if (w.length > 4 && w.endsWith('eis')) return w.slice(0, -3) + 'el';
  if (w.length > 3 && w.endsWith('ns')) return w.slice(0, -2) + 'm';
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

module.exports = { norm, words, stem };
