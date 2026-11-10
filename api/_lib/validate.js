// Validação compartilhada entre as funções da API (pasta _lib não vira função na Vercel).

// Rejeita caracteres de controle; quebras de linha só quando permitidas (texto multilinha).
function hasControlChars(s, allowNewlines) {
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c === 10 || c === 13) { if (!allowNewlines) return true; continue; }
    if (c < 32 || c === 127) return true;
  }
  return false;
}

module.exports = { hasControlChars };
