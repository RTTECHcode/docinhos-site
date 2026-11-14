'use strict';
/*
 * Clube de pontos por itens (v4 N3). O cliente troca pontos por um item da loja (prêmio), em vez de desconto em reais.
 *  - club_rewards: produto (+ tamanho opcional), custo em pontos, máximo por pedido, vigência e ligado/desligado.
 *  - Produto com grupo de escolha obrigatória (min_choices > 0) não pode virar prêmio.
 *  - O pedido manda rewards: [{ reward_id, qty }]; o servidor valida tudo e grava o prêmio em orders.items com
 *    reward: true, reward_id, points_cost e preço 0. A reserva dos pontos é feita junto com o pedido (api/order.js).
 *  - Ciclo dos pontos: api/_lib/loyalty.js (reward_reserve -> reward_commit | reward_release; reversal no estorno).
 */
const loyalty = require('./loyalty');

class ClubError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code || null; } }
const bad = (message, code) => { throw new ClubError(400, message, code); };

const COST_MIN = 1, COST_MAX = 100000;
const PER_ORDER_MIN = 1, PER_ORDER_MAX = 10;
const MAX_REWARD_LINES = 10;

const isInt = v => Number.isInteger(v);
const iso = v => (v ? new Date(v).toISOString() : null);

// Linha base: prêmio + produto + categoria + tamanho. `available` já considera produto, categoria, tamanho e grupos obrigatórios.
const BASE_SELECT = `
  select r.id, r.product_id, r.size_complement_id, r.points_cost, r.max_per_order, r.active, r.starts_at, r.ends_at, r.sort_order,
         r.created_at, r.updated_at,
         p.name as product_name, p.image_path, p.active as product_active, p.paused as product_paused, p.price_cents as product_price_cents,
         c.name as category_name, c.active as category_active,
         sz.name as size_name,
         (r.size_complement_id is not null and not exists (
            select 1 from product_complements pc join complements cc on cc.id = pc.complement_id
             where pc.product_id = r.product_id and pc.complement_id = r.size_complement_id and cc.kind = 'size' and cc.active and not pc.paused)) as size_broken,
         exists (select 1 from product_groups g where g.product_id = r.product_id and g.min_choices > 0) as has_required_group
    from club_rewards r
    join products p on p.id = r.product_id
    join categories c on c.id = p.category_id
    left join complements sz on sz.id = r.size_complement_id`;

// Em vigor agora? (ligado e dentro da vigência)
const inWindow = (row, now = new Date()) =>
  row.active && (!row.starts_at || new Date(row.starts_at) <= now) && (!row.ends_at || new Date(row.ends_at) > now);
// Pode ser trocado agora? (em vigor + produto/categoria ativos, não pausado, tamanho válido, sem grupo obrigatório)
const isAvailable = (row, now = new Date()) =>
  inWindow(row, now) && row.product_active && row.category_active && !row.product_paused && !row.size_broken && !row.has_required_group;

const publicReward = (row, now) => ({
  id: row.id, product_id: row.product_id, name: row.product_name, size_name: row.size_name || null, image_path: row.image_path || null,
  points_cost: row.points_cost, max_per_order: row.max_per_order, available: isAvailable(row, now)
});

// Prêmios que a vitrine mostra: em vigor e com produto/categoria ativos (pausado aparece com available: false).
async function listShown(sql, now = new Date()) {
  const rows = await sql.query(`${BASE_SELECT} where r.active order by r.sort_order, r.points_cost, r.id`);
  return rows.filter(r => inWindow(r, now) && r.product_active && r.category_active).map(r => publicReward(r, now));
}

// Bloco `club` do /api/menu (público).
async function publicClub(sql, rules) {
  const r = rules || await loyalty.getRules(sql);
  return { enabled: r.enabled, points_per_real: r.points_per_real, rewards: await listShown(sql) };
}

// Bloco da conta (GET /api/customer?a=club): saldo, reservado, bloqueio e prêmios com o que falta.
async function customerClub(sql, customerId) {
  const bal = await loyalty.getBalance(sql, customerId);
  const now = new Date();
  const rewards = (await listShown(sql, now)).map(r => {
    const missing = Math.max(0, r.points_cost - Math.max(0, bal.balance));
    return { ...r, missing_points: missing, can_redeem: r.available && bal.points_enabled && !bal.locked_until && missing === 0 };
  });
  return { balance: bal.balance, reserved: bal.reserved, locked_until: bal.locked_until, enabled: bal.points_enabled, points_per_real: bal.points_per_real, rewards };
}

/**
 * Valida os prêmios do pedido. rawRewards = [{ reward_id, qty }]. Retorna { items, points_total }.
 * Lança ClubError (mensagens em português). Não confere saldo nem login (api/order.js faz).
 */
async function resolveRewards(sql, rawRewards, now = new Date()) {
  if (rawRewards === undefined || rawRewards === null) return { items: [], points_total: 0 };
  if (!Array.isArray(rawRewards)) bad('Prêmios inválidos.', 'invalid_rewards');
  if (rawRewards.length === 0) return { items: [], points_total: 0 };
  if (rawRewards.length > MAX_REWARD_LINES) bad(`Escolha no máximo ${MAX_REWARD_LINES} prêmios diferentes por pedido.`, 'invalid_rewards');
  const seen = new Set();
  for (const raw of rawRewards) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !isInt(raw.reward_id) || raw.reward_id < 1 || raw.reward_id > 2147483647) bad('Prêmio inválido.', 'invalid_rewards');
    if (!isInt(raw.qty) || raw.qty < 1 || raw.qty > PER_ORDER_MAX) bad('Quantidade de prêmio inválida.', 'invalid_rewards');
    if (seen.has(raw.reward_id)) bad('Prêmio repetido. Ajuste a quantidade.', 'invalid_rewards');
    seen.add(raw.reward_id);
  }
  const rows = await sql.query(`${BASE_SELECT} where r.id = any($1::int[])`, [[...seen]]);
  const byId = new Map(rows.map(r => [r.id, r]));
  const items = [];
  let total = 0;
  for (const raw of rawRewards) {
    const row = byId.get(raw.reward_id);
    if (!row || !inWindow(row, now) || !row.product_active || !row.category_active || row.size_broken || row.has_required_group) {
      throw new ClubError(400, 'Um dos prêmios não está mais disponível. Atualize a página.', 'reward_unavailable');
    }
    if (row.product_paused) throw new ClubError(400, `O prêmio "${row.product_name}" está pausado no momento. Remova-o para continuar.`, 'reward_unavailable');
    if (raw.qty > row.max_per_order) throw new ClubError(400, `O prêmio "${row.product_name}" permite no máximo ${row.max_per_order} por pedido.`, 'reward_max_per_order');
    items.push({
      product_id: row.product_id, name: row.product_name, size: row.size_name || null, extras: [], qty: raw.qty, unit_total_cents: 0,
      reward: true, reward_id: row.id, points_cost: row.points_cost
    });
    total += row.points_cost * raw.qty;
  }
  return { items, points_total: total };
}

// ---------- Admin ----------
const adminView = (row, now = new Date()) => ({
  id: row.id, product_id: row.product_id, product_name: row.product_name, category_name: row.category_name,
  size_complement_id: row.size_complement_id, size_name: row.size_name || null, points_cost: row.points_cost, max_per_order: row.max_per_order,
  active: row.active, starts_at: iso(row.starts_at), ends_at: iso(row.ends_at), sort_order: row.sort_order,
  state: !row.active ? 'off' : (row.starts_at && new Date(row.starts_at) > now ? 'scheduled' : (row.ends_at && new Date(row.ends_at) <= now ? 'ended' : 'on')),
  available: isAvailable(row, now), product_paused: !!row.product_paused, product_active: !!row.product_active,
  created_at: iso(row.created_at), updated_at: iso(row.updated_at)
});

async function adminList(sql) {
  const rows = await sql.query(`${BASE_SELECT} order by r.active desc, r.sort_order, r.id`);
  const now = new Date();
  return rows.map(r => adminView(r, now));
}

// Data/hora da vigência: ISO 8601 ou AAAA-MM-DD (dia de São Paulo: início 00:00, fim 23:59:59).
function parseWhen(v, label, end) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') bad(`${label}: data inválida.`, 'invalid_date');
  const t = v.trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(t) ? new Date(`${t}T${end ? '23:59:59' : '00:00:00'}-03:00`) : new Date(t);
  if (Number.isNaN(d.getTime()) || d.getFullYear() < 2020 || d.getFullYear() > 2100) bad(`${label}: data inválida.`, 'invalid_date');
  return d;
}

// Cadastra ou edita (id presente). Retorna a visão do admin. Sem apagar: desative.
async function save(sql, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) bad('Dados inválidos.');
  const id = body.id === undefined || body.id === null ? null : body.id;
  if (id !== null && (!isInt(id) || id < 1)) bad('Prêmio inválido.');
  if (!isInt(body.product_id) || body.product_id < 1) bad('Escolha o produto do prêmio.', 'invalid_product');
  if (!isInt(body.points_cost) || body.points_cost < COST_MIN || body.points_cost > COST_MAX) bad(`Custo em pontos: informe um número inteiro de ${COST_MIN} a ${COST_MAX}.`, 'invalid_cost');
  const maxPer = body.max_per_order === undefined || body.max_per_order === null ? 1 : body.max_per_order;
  if (!isInt(maxPer) || maxPer < PER_ORDER_MIN || maxPer > PER_ORDER_MAX) bad(`Máximo por pedido: informe um número inteiro de ${PER_ORDER_MIN} a ${PER_ORDER_MAX}.`, 'invalid_max');
  const sort = body.sort_order === undefined || body.sort_order === null ? 0 : body.sort_order;
  if (!isInt(sort) || sort < 0 || sort > 9999) bad('Ordem: informe um número inteiro de 0 a 9999.');
  const starts = parseWhen(body.starts_at, 'Início da vigência', false), ends = parseWhen(body.ends_at, 'Fim da vigência', true);
  if (starts && ends && ends <= starts) bad('O fim da vigência precisa ser depois do início.', 'invalid_window');
  const active = body.active === undefined ? true : body.active;
  if (typeof active !== 'boolean') bad('Informe se o prêmio está ligado ou desligado.');

  const [p] = await sql.query('select id, name, price_cents from products where id = $1', [body.product_id]);
  if (!p) throw new ClubError(404, 'Produto não encontrado.', 'invalid_product');
  const [req] = await sql.query('select count(*)::int n from product_groups where product_id = $1 and min_choices > 0', [p.id]);
  if (req.n > 0) bad(`"${p.name}" tem escolha obrigatória (ex.: sabores) e não pode ser prêmio. Escolha um produto sem opções obrigatórias.`, 'required_group');
  const sizes = await sql.query(
    `select c.id, c.name from product_complements pc join complements c on c.id = pc.complement_id where pc.product_id = $1 and c.kind = 'size' and c.active`, [p.id]);
  let sizeId = body.size_complement_id === undefined || body.size_complement_id === '' ? null : body.size_complement_id;
  if (sizeId !== null && (!isInt(sizeId) || sizeId < 1)) bad('Tamanho inválido.', 'invalid_size');
  if (sizes.length) {
    if (sizeId === null) bad(`"${p.name}" tem tamanhos: escolha o tamanho do prêmio.`, 'size_required');
    if (!sizes.some(s => s.id === sizeId)) bad('Tamanho inválido para este produto.', 'invalid_size');
  } else {
    if (sizeId !== null) bad('Este produto não tem tamanhos.', 'invalid_size');
    if (p.price_cents === null) bad(`"${p.name}" não tem preço definido e não pode ser prêmio.`, 'invalid_product');
  }

  let row;
  if (id === null) {
    [row] = await sql.query(
      `insert into club_rewards (product_id, size_complement_id, points_cost, max_per_order, active, starts_at, ends_at, sort_order)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [p.id, sizeId, body.points_cost, maxPer, active, starts, ends, sort]);
  } else {
    [row] = await sql.query(
      `update club_rewards set product_id = $2, size_complement_id = $3, points_cost = $4, max_per_order = $5, active = $6,
              starts_at = $7, ends_at = $8, sort_order = $9, updated_at = now()
        where id = $1 returning id`,
      [id, p.id, sizeId, body.points_cost, maxPer, active, starts, ends, sort]);
    if (!row) throw new ClubError(404, 'Prêmio não encontrado.', 'not_found');
  }
  const [full] = await sql.query(`${BASE_SELECT} where r.id = $1`, [row.id]);
  return adminView(full);
}

// Liga ou desliga. active omitido = inverte.
async function toggle(sql, body) {
  if (!body || !isInt(body.id) || body.id < 1) bad('Prêmio inválido.');
  if (body.active !== undefined && typeof body.active !== 'boolean') bad('Informe ligado ou desligado.');
  const rows = await sql.query(
    `update club_rewards set active = coalesce($2::boolean, not active), updated_at = now() where id = $1 returning id`,
    [body.id, body.active === undefined ? null : body.active]);
  if (!rows.length) throw new ClubError(404, 'Prêmio não encontrado.', 'not_found');
  const [full] = await sql.query(`${BASE_SELECT} where r.id = $1`, [rows[0].id]);
  return adminView(full);
}

module.exports = {
  ClubError, COST_MIN, COST_MAX, PER_ORDER_MAX, BASE_SELECT, inWindow, isAvailable,
  listShown, publicClub, customerClub, resolveRewards, adminList, save, toggle
};
