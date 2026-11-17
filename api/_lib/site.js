'use strict';
// A-05 (v4): endereço público do site. Lê SITE_URL do ambiente; sem a variável, usa o endereço de produção. Sem barra no fim.
// Só https:// (http:// apenas para localhost/127.0.0.1 no dev). Valor inválido = fallback (nunca quebra o pedido).
// F6 M4: o padrão de produção passa a ser o domínio próprio (Netlify). Enquanto a Vercel estiver no ar sem o domínio,
// ela precisa de SITE_URL=https://docinhos-site.vercel.app (docs/planos/deploy-netlify.md).
const DEFAULT_SITE_URL = 'https://docinhosdagigioz.com.br';
const SITE_DOMAIN = new URL(DEFAULT_SITE_URL).hostname;

function siteUrl(env = process.env) {
  const v = String(env.SITE_URL || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/.test(v)) return DEFAULT_SITE_URL;
  let url;
  try { url = new URL(v); } catch { return DEFAULT_SITE_URL; }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return DEFAULT_SITE_URL;
  if (!local && !url.hostname.includes('.')) return DEFAULT_SITE_URL;
  return v;
}

module.exports = { DEFAULT_SITE_URL, SITE_DOMAIN, siteUrl };
