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

// Chave de telefone para unir pedido de visitante e conta: só dígitos, sem o 55 do país (10 ou 11 dígitos).
// Vale para "(11) 91234-5678", "11912345678" e "+5511912345678".
function phoneKey(raw) {
  const d = String(raw == null ? '' : raw).replace(/\D/g, '');
  return /^55\d{10,11}$/.test(d) ? d.slice(2) : d;
}
// Mesma regra, em SQL, para uma coluna de telefone (ex.: phoneKeySql('o.customer_phone')).
const phoneKeySql = col => {
  const digits = `regexp_replace(${col}, '[^0-9]', '', 'g')`;
  return `(case when ${digits} ~ '^55[0-9]{10,11}$' then substr(${digits}, 3) else ${digits} end)`;
};

module.exports = { norm, words, stem, phoneKey, phoneKeySql };
