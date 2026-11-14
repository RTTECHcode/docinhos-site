'use strict';
/*
 * v4 N11: selo "Mais pedido" e prazo médio de entrega (vitrine do /api/menu). Sem dado pessoal: só ids de produto e números.
 *  - best_seller: os 3 produtos com mais unidades vendidas nos últimos 30 dias, em pedidos pagos (approved) e não
 *    cancelados, com no mínimo 5 unidades cada. Prêmios do Clube (reward: true) não contam. Só produto ativo concorre. Empate: menor id primeiro.
 *  - delivery_eta_min / delivery_eta_max: minutos, só informativos (padrão 30 a 50).
 */
class ShowcaseError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }

const BEST_SELLER_TOP = 3;
const BEST_SELLER_MIN_QTY = 5;
const BEST_SELLER_DAYS = 30;
const KEYS = { best_seller_enabled: 'best_seller_enabled', delivery_eta_min: 'delivery_eta_min', delivery_eta_max: 'delivery_eta_max' };
const DEFAULTS = { best_seller_enabled: true, delivery_eta_min: 30, delivery_eta_max: 50 };
const ETA_RANGE = [0, 600];

function parseConfig(st) {
  const int = (k) => { const n = Number.parseInt(st[k], 10); return Number.isInteger(n) && n >= ETA_RANGE[0] && n <= ETA_RANGE[1] ? n : DEFAULTS[k]; };
  let min = int('delivery_eta_min'), max = int('delivery_eta_max');
  if (max < min) { min = DEFAULTS.delivery_eta_min; max = DEFAULTS.delivery_eta_max; } // valor estragado no banco: volta ao padrão
  return { best_seller_enabled: st.best_seller_enabled === undefined ? DEFAULTS.best_seller_enabled : st.best_seller_enabled === '1', delivery_eta_min: min, delivery_eta_max: max };
}
async function getConfig(sql) {
  const rows = await sql.query('select key, value from settings where key = any($1::text[])', [Object.values(KEYS)]);
  return parseConfig(Object.fromEntries(rows.map(r => [r.key, r.value])));
}
// Valida o que veio do painel (só os campos enviados) contra o que está em vigor. Lança ShowcaseError 400.
function validateConfig(body, current) {
  const b = body && typeof body === 'object' ? body : {};
  const out = {};
  if (b.best_seller_enabled !== undefined) {
    if (typeof b.best_seller_enabled !== 'boolean') throw new ShowcaseError(400, 'Selo "Mais pedido": use ligado ou desligado.', 'invalid_settings');
    out.best_seller_enabled = b.best_seller_enabled;
  }
  for (const k of ['delivery_eta_min', 'delivery_eta_max']) {
    if (b[k] === undefined) continue;
    if (!Number.isInteger(b[k]) || b[k] < ETA_RANGE[0] || b[k] > ETA_RANGE[1]) {
      throw new ShowcaseError(400, `Prazo de entrega: use minutos inteiros de ${ETA_RANGE[0]} a ${ETA_RANGE[1]}.`, 'invalid_settings');
    }
    out[k] = b[k];
  }
  const min = out.delivery_eta_min ?? current.delivery_eta_min, max = out.delivery_eta_max ?? current.delivery_eta_max;
  if (max < min) throw new ShowcaseError(400, 'Prazo de entrega: o máximo precisa ser maior ou igual ao mínimo.', 'invalid_settings');
  return out;
}
function saveStatements(sql, partial) {
  return Object.entries(partial).map(([k, v]) => sql.query(
    'insert into settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value',
    [KEYS[k], typeof v === 'boolean' ? (v ? '1' : '0') : String(v)]));
}

// Ids dos produtos com selo (Set). Vazio quando o selo está desligado.
async function bestSellers(sql, cfg) {
  if (!cfg.best_seller_enabled) return new Set();
  // CASE antes do cast: item antigo ou estranho no jsonb nunca derruba a consulta. Só produto ativo do catálogo concorre.
  const rows = await sql.query(
    `with it as (
       select case when (i->>'product_id') ~ '^[0-9]{1,9}$' then (i->>'product_id')::int end as product_id,
              case when (i->>'qty') ~ '^[0-9]{1,4}$' then (i->>'qty')::int else 0 end as qty
         from orders o cross join lateral jsonb_array_elements(case when jsonb_typeof(o.items) = 'array' then o.items else '[]'::jsonb end) as i
        where o.payment_status = 'approved' and o.fulfillment_status <> 'cancelled'
          and o.created_at > now() - interval '${BEST_SELLER_DAYS} days'
          and coalesce(i->>'reward', 'false') <> 'true')
     select it.product_id, sum(it.qty)::int as qty
       from it join products p on p.id = it.product_id and p.active
      group by it.product_id
     having sum(it.qty) >= $1
      order by qty desc, it.product_id asc
      limit $2`, [BEST_SELLER_MIN_QTY, BEST_SELLER_TOP]);
  return new Set(rows.map(r => r.product_id));
}

module.exports = { ShowcaseError, BEST_SELLER_TOP, BEST_SELLER_MIN_QTY, BEST_SELLER_DAYS, KEYS, DEFAULTS, ETA_RANGE, parseConfig, getConfig, validateConfig, saveStatements, bestSellers };
