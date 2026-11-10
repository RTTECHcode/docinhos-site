// Limite de consultas por IP guardado no banco (tabela rate_hits, scripts/migrate-2026-11-10-rate-limits.js).
// Antes ficava num Map em memória: na Vercel cada instância tem a própria memória, então o limite valia por instância
// e quem caísse em instâncias diferentes passava do teto.
// Contagem por minuto: uma linha por (escopo, IP, minuto) com o total de chamadas daquele minuto. Sob ataque a tabela
// não cresce por chamada, só por minuto. A janela soma o minuto atual e os `windowMinutes` minutos anteriores
// completos, ou seja, cobre entre 10 e 11 minutos para uma janela de 10: nunca é mais frouxa que a janela exata.
// Toda chamada conta, até as já barradas (quem insiste continua barrado), como no Map antigo.
// De vez em quando (2% das chamadas) apaga linhas com mais de 1 dia, sem cron.

const SCOPES = new Set(['order_status', 'shipping_quote']);

/**
 * Registra esta chamada e diz se o IP passou do limite (a chamada atual entra na conta).
 * @returns {Promise<boolean>} true quando o total na janela passa de `max`.
 */
async function hitExceeded(sql, scope, ip, { windowMinutes, max }) {
  if (!SCOPES.has(scope)) throw new Error('Escopo de limite desconhecido: ' + scope);
  const key = String(ip || 'unknown').slice(0, 64);
  // O select de fora não enxerga a linha gravada pelo "with" (mesmo instantâneo): soma os minutos anteriores e
  // acrescenta o total já atualizado do minuto atual.
  const [{ n }] = await sql.query(
    `with up as (
       insert into rate_hits (scope, ip, minute, n) values ($1, $2, date_trunc('minute', now()), 1)
       on conflict (scope, ip, minute) do update set n = rate_hits.n + 1
       returning n)
     select coalesce((select sum(n) from rate_hits
                       where scope = $1 and ip = $2
                         and minute >= date_trunc('minute', now()) - make_interval(mins => $3::int)
                         and minute < date_trunc('minute', now())), 0)::int + (select n from up)::int as n`,
    [scope, key, windowMinutes]);
  if (Math.random() < 0.02) await sql.query(`delete from rate_hits where minute < now() - interval '1 day'`);
  return n > max;
}

module.exports = { hitExceeded, SCOPES };
