'use strict';
// F6 M3: ambiente da loja sem depender da plataforma (antes: VERCEL_ENV). Regra fail-closed: é PRODUÇÃO, a menos que
// APP_ENV seja "development" ou "preview" (ou NODE_ENV=test). Variável ausente, vazia ou com erro de digitação = produção.
// Netlify: produção com APP_ENV=production; deploy preview com APP_ENV=preview. Local: scripts/dev-env.js e
// scripts/dev-server.js definem APP_ENV=development.
const NON_PRODUCTION = new Set(['development', 'preview']);

function appEnv(env = process.env) {
  const v = String(env.APP_ENV || '').trim().toLowerCase();
  if (NON_PRODUCTION.has(v)) return v;
  if (String(env.NODE_ENV || '').trim().toLowerCase() === 'test') return 'test';
  return 'production';
}

const isProduction = (env = process.env) => appEnv(env) === 'production';

module.exports = { appEnv, isProduction, NON_PRODUCTION };
