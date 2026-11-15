'use strict';
/*
 * Monitoramento (v4 O-01).
 *  - webhook_events: cada aviso do Mercado Pago aceito (assinatura válida) ou recusado (401). Sem segredo, sem v1 e sem dado
 *    pessoal: só o resultado, o tipo e o motivo curto. Linhas com mais de 30 dias são apagadas de vez em quando (2%).
 *    F5-S-01: recusas com limite de gravação (por IP e geral) e o health só acende com recusas depois do último aceito.
 *  - healthChecks: verificações sim/não do /api/health (público) e do painel (health_detail). Nunca devolve valor de variável.
 */
const OUTCOMES = new Set(['accepted', 'unauthorized']);

// Grava um evento do webhook. Nunca lança: falha só vai para o log (o webhook não pode cair por causa disso).
// sqlOrGetter: a conexão ou uma função que a devolve (carregada só aqui dentro, protegida pelo try).
async function recordWebhookEvent(sqlOrGetter, outcome, detail) {
  if (!OUTCOMES.has(outcome)) return;
  try {
    const sql = typeof sqlOrGetter === 'function' && !sqlOrGetter.query ? sqlOrGetter() : sqlOrGetter;
    await sql.query('insert into webhook_events (outcome, detail) values ($1, $2)', [outcome, detail ? String(detail).slice(0, 200) : null]);
    if (Math.random() < 0.02) await sql.query(`delete from webhook_events where at < now() - interval '30 days'`);
  } catch (error) { console.error('Falha ao gravar evento do webhook:', error.message); }
}

// Resumo das últimas 24 h (e o último aviso aceito, de qualquer data).
async function webhookSummary(sql) {
  const [r] = await sql.query(
    `select (select max(at) from webhook_events where outcome = 'accepted') as last_accepted_at,
            (select max(at) from webhook_events where outcome = 'unauthorized') as last_unauthorized_at,
            (select count(*) from webhook_events where outcome = 'unauthorized' and at > now() - interval '24 hours')::int as unauthorized_24h,
            (select count(*) from webhook_events where outcome = 'accepted' and at > now() - interval '24 hours')::int as accepted_24h,
            (select count(*) from webhook_events e where e.outcome = 'unauthorized' and e.at > now() - interval '24 hours'
                and e.at > coalesce((select max(at) from webhook_events where outcome = 'accepted'), '-infinity'::timestamptz))::int as unauthorized_since_accepted_24h`);
  const iso = v => (v ? new Date(v).toISOString() : null);
  return { last_accepted_at: iso(r.last_accepted_at), last_unauthorized_at: iso(r.last_unauthorized_at), unauthorized_24h: r.unauthorized_24h, accepted_24h: r.accepted_24h,
    unauthorized_since_accepted_24h: r.unauthorized_since_accepted_24h };
}

// F5-S-01: um POST qualquer sem assinatura não pode deixar o health vermelho. Só fica vermelho com pelo menos
// UNAUTHORIZED_ALERT_MIN recusas nas últimas 24 h DEPOIS do último aviso aceito (assinatura válida). Segredo trocado faz
// todo aviso do Mercado Pago (e as retentativas dele) falhar e acende; um aviso aceito apaga. A gravação das recusas
// também tem limite por IP e geral no webhook (api/mp-webhook.js).
const UNAUTHORIZED_ALERT_MIN = 3;
const webhookAlert = summary => !!summary && summary.unauthorized_since_accepted_24h >= UNAUTHORIZED_ALERT_MIN;

const present = name => typeof process.env[name] === 'string' && process.env[name].trim() !== '';

// Verificações do /api/health. getSql é chamado aqui dentro (sem DATABASE_URL o require do banco falharia na carga).
async function healthChecks(getSql) {
  const checks = {
    database: false,
    mercadopago_token: present('MERCADOPAGO_ACCESS_TOKEN'),
    mercadopago_webhook_secret: present('MERCADOPAGO_WEBHOOK_SECRET'),
    webhook_no_401_24h: false
  };
  let summary = null;
  try {
    const sql = getSql();
    await sql.query('select 1');
    checks.database = true;
    summary = await webhookSummary(sql);
    checks.webhook_no_401_24h = !webhookAlert(summary); // nome mantido por compatibilidade (F5-S-01: ver webhookAlert)
  } catch (error) { console.error('Health: banco indisponível:', error.message); }
  return { ok: Object.values(checks).every(Boolean), checks, summary };
}

module.exports = { recordWebhookEvent, webhookSummary, healthChecks, webhookAlert, UNAUTHORIZED_ALERT_MIN };
