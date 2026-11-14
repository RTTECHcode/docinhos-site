'use strict';
// A-05 (v4): endereço público do site. Lê SITE_URL do ambiente; sem a variável, usa o endereço de produção de sempre
// (nada muda em produção enquanto a variável não existir). Sem barra no fim; só http(s).
const DEFAULT_SITE_URL = 'https://docinhos-site.vercel.app';

function siteUrl() {
  const v = String(process.env.SITE_URL || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(v) ? v : DEFAULT_SITE_URL;
}

module.exports = { DEFAULT_SITE_URL, siteUrl };
