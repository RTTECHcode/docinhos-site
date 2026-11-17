'use strict';
/*
 * v4 N10: encomenda com data marcada. O servidor decide tudo: janela, horário, antecedência, limite de dias e vaga.
 *
 * Regras:
 *  - janelas de 30 min alinhadas (:00 ou :30) que cabem inteiras numa faixa de store_hours do dia (fuso de São Paulo);
 *  - pelo menos scheduling_min_lead_min minutos à frente e no máximo scheduling_max_days dias de calendário à frente;
 *  - fechamento manual sem prazo (ou pausa antiga) bloqueia todas as janelas; fechamento com prazo bloqueia as janelas
 *    que começam antes da reabertura;
 *  - vaga: scheduling_slot_capacity pedidos por janela (0 = sem limite), entrega e retirada somadas. Ocupa a vaga o pedido
 *    não cancelado que está pago, ou que ainda está esperando o pagamento há menos de 60 min (checkout abandonado não
 *    segura a vaga para sempre). Pagamento recusado, cancelado, vencido ou estornado não ocupa.
 *  - a trava contra corrida é pg_advisory_xact_lock(3, chave da janela), dentro da mesma transação do insert do pedido
 *    (depois das travas 1 = pontos e 2 = cupom, sempre nessa ordem).
 */
const hours = require('./store-hours');

const SLOT_MIN = 30;
const SLOT_MS = SLOT_MIN * 60000;
const LOCK_SLOT = 3;
const HOLD_PENDING_MIN = 60;
const DAY_MS = 24 * 3600 * 1000;
const DEFAULTS = { enabled: true, min_lead_min: 120, max_days: 7, slot_capacity: 0 };
const KEYS = { enabled: 'scheduling_enabled', min_lead_min: 'scheduling_min_lead_min', max_days: 'scheduling_max_days', slot_capacity: 'scheduling_slot_capacity' };
const LIMITS = { min_lead_min: [0, 2880], max_days: [1, 30], slot_capacity: [0, 100] };
const WEEKDAYS_SHORT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

class ScheduleError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }

// Condição SQL "este pedido ocupa a vaga" (sem parâmetros: pode ir em qualquer consulta).
const OCCUPIES_SQL = `fulfillment_status <> 'cancelled'
  and (payment_status = 'approved'
       or (payment_status in ('pending', 'in_process', 'authorized') and created_at > now() - interval '${HOLD_PENDING_MIN} minutes'))`;

const pad = n => String(n).padStart(2, '0');
const lockKey = start => Math.floor(start.getTime() / SLOT_MS);

// ---------- Ajustes ----------
function parseConfig(st) {
  const int = (k, d) => { const n = Number.parseInt(st[KEYS[k]], 10); return Number.isInteger(n) && n >= LIMITS[k][0] && n <= LIMITS[k][1] ? n : d; };
  return {
    enabled: st[KEYS.enabled] === undefined ? DEFAULTS.enabled : st[KEYS.enabled] === '1',
    min_lead_min: int('min_lead_min', DEFAULTS.min_lead_min),
    max_days: int('max_days', DEFAULTS.max_days),
    slot_capacity: int('slot_capacity', DEFAULTS.slot_capacity)
  };
}
async function getConfig(sql) {
  const rows = await sql.query('select key, value from settings where key = any($1::text[])', [Object.values(KEYS)]);
  return parseConfig(Object.fromEntries(rows.map(r => [r.key, r.value])));
}
// Valida o que veio do painel. Só os campos enviados. Lança ScheduleError 400.
function validateConfig(body) {
  const b = body && typeof body === 'object' ? body : {};
  const out = {};
  if (b.scheduling_enabled !== undefined) {
    if (typeof b.scheduling_enabled !== 'boolean') throw new ScheduleError(400, 'Agendamento: use ligado ou desligado.', 'invalid_settings');
    out.enabled = b.scheduling_enabled;
  }
  const labels = { min_lead_min: 'Antecedência mínima (minutos)', max_days: 'Máximo de dias à frente', slot_capacity: 'Pedidos por janela (0 = sem limite)' };
  for (const k of ['min_lead_min', 'max_days', 'slot_capacity']) {
    const v = b[KEYS[k]];
    if (v === undefined) continue;
    const [lo, hi] = LIMITS[k];
    if (!Number.isInteger(v) || v < lo || v > hi) throw new ScheduleError(400, `${labels[k]}: use um número inteiro de ${lo} a ${hi}.`, 'invalid_settings');
    out[k] = v;
  }
  return out;
}
// Grava os campos validados (cada um numa linha de settings).
function saveStatements(sql, partial) {
  return Object.entries(partial).map(([k, v]) => sql.query(
    'insert into settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value',
    [KEYS[k], typeof v === 'boolean' ? (v ? '1' : '0') : String(v)]));
}

// ---------- Contexto e regras (puras) ----------
async function loadContext(sql) {
  const [cfg, hoursRows, manual, legacy] = await Promise.all([
    getConfig(sql), hours.loadHours(sql), hours.loadManual(sql),
    sql.query(`select value from settings where key = 'store_paused'`)
  ]);
  return { cfg, hoursRows, manual, legacyPaused: !!(legacy[0] && legacy[0].value === '1') };
}

// Janelas (minuto de início no dia) de um dia da semana: alinhadas a 30 min e inteiras dentro de uma faixa.
function windowsForWeekday(hoursRows, weekday) {
  const out = [];
  for (const [open, close] of hours.groupHours(hoursRows)[weekday]) {
    for (let s = Math.ceil(open / SLOT_MIN) * SLOT_MIN; s + SLOT_MIN <= close; s += SLOT_MIN) out.push(s);
  }
  return out;
}

const dayNumber = p => Math.round(Date.UTC(p.year, p.month - 1, p.day) / DAY_MS);

// Motivo de a janela que começa em `start` não poder ser escolhida (sem olhar a vaga): null se pode.
// 'invalid' (desalinhada ou fora de qualquer janela do dia), 'too_soon', 'too_far', 'closed' (fechamento manual).
function blockReason(ctx, start, now = new Date()) {
  const p = hours.zoneParts(start);
  if (start.getTime() % 60000 !== 0 || p.minute % SLOT_MIN !== 0) return 'invalid';
  if (!windowsForWeekday(ctx.hoursRows, p.weekday).includes(p.hour * 60 + p.minute)) return 'invalid';
  if (ctx.manual && ctx.manual.closed_indefinitely) return 'closed';
  if (ctx.legacyPaused) return 'closed';
  if (ctx.manual && ctx.manual.closed_until && ctx.manual.closed_until.getTime() > start.getTime()) return 'closed';
  if (start.getTime() < now.getTime() + ctx.cfg.min_lead_min * 60000) return 'too_soon';
  if (dayNumber(p) - dayNumber(hours.zoneParts(now)) > ctx.cfg.max_days) return 'too_far';
  return null;
}

// "Agendado: sex 21/11, 15:00-15:30" (hora de São Paulo). null quando não há data marcada.
function scheduledLabel(value) {
  if (!value) return null;
  const s = new Date(value);
  if (Number.isNaN(s.getTime())) return null;
  const a = hours.zoneParts(s), b = hours.zoneParts(new Date(s.getTime() + SLOT_MS));
  return `Agendado: ${WEEKDAYS_SHORT[a.weekday]} ${pad(a.day)}/${pad(a.month)}, ${pad(a.hour)}:${pad(a.minute)}-${pad(b.hour)}:${pad(b.minute)}`;
}

// Pedidos que ocupam cada janela entre from (incluso) e to (excluso): Map(ms -> n).
async function occupancy(sql, from, to) {
  const rows = await sql.query(
    `select scheduled_for, count(*)::int n from orders
      where scheduled_for >= $1 and scheduled_for < $2 and ${OCCUPIES_SQL}
      group by scheduled_for`, [from.toISOString(), to.toISOString()]);
  return new Map(rows.map(r => [new Date(r.scheduled_for).getTime(), r.n]));
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MODES = ['delivery', 'pickup'];

// GET /api/store?a=slots&date=AAAA-MM-DD&mode=delivery|pickup
// { enabled, date, mode, slot_minutes, min_lead_min, max_days, slots: [{ start, end, label, available, reason }] }
// reason: null | 'too_soon' | 'too_far' | 'closed' | 'full'. Vaga é a mesma para entrega e retirada (mode só é validado).
async function slotsForDate(sql, { date, mode }, now = new Date()) {
  const m = DATE_RE.exec(typeof date === 'string' ? date : '');
  const y = m ? Number(m[1]) : 0, mo = m ? Number(m[2]) : 0, d = m ? Number(m[3]) : 0;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (!m || probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    throw new ScheduleError(400, 'Data inválida: use AAAA-MM-DD.', 'invalid_date');
  }
  if (!MODES.includes(mode)) throw new ScheduleError(400, 'Escolha entrega (delivery) ou retirada (pickup).', 'invalid_mode');
  const ctx = await loadContext(sql);
  const base = { enabled: ctx.cfg.enabled, date, mode, slot_minutes: SLOT_MIN, min_lead_min: ctx.cfg.min_lead_min, max_days: ctx.cfg.max_days };
  if (!ctx.cfg.enabled) return { ...base, slots: [] };
  const todayN = dayNumber(hours.zoneParts(now));
  const diff = Math.round(probe.getTime() / DAY_MS) - todayN;
  if (diff < 0 || diff > ctx.cfg.max_days) return { ...base, slots: [] }; // fora do alcance: nada a mostrar
  const starts = windowsForWeekday(ctx.hoursRows, probe.getUTCDay())
    .map(min => hours.zonedToUtc({ year: y, month: mo, day: d, hour: Math.floor(min / 60), minute: min % 60 }));
  const occ = starts.length && ctx.cfg.slot_capacity > 0
    ? await occupancy(sql, starts[0], new Date(starts[starts.length - 1].getTime() + SLOT_MS)) : new Map();
  const slots = starts.map(s => {
    let reason = blockReason(ctx, s, now);
    if (!reason && ctx.cfg.slot_capacity > 0 && (occ.get(s.getTime()) || 0) >= ctx.cfg.slot_capacity) reason = 'full';
    const a = hours.zoneParts(s), e = hours.zoneParts(new Date(s.getTime() + SLOT_MS));
    return {
      start: s.toISOString(), end: new Date(s.getTime() + SLOT_MS).toISOString(),
      label: `${pad(a.hour)}:${pad(a.minute)}-${pad(e.hour)}:${pad(e.minute)}`,
      available: reason === null, reason
    };
  });
  return { ...base, slots };
}

const REASON_ERRORS = {
  invalid: [400, 'Horário de agendamento inválido: escolha uma das janelas de 30 minutos disponíveis.', 'invalid_schedule'],
  too_soon: [400, 'Esse horário está perto demais. Escolha uma janela mais tarde.', 'schedule_too_soon'],
  too_far: [400, 'Esse horário está longe demais. Escolha uma data mais próxima.', 'schedule_too_far'],
  closed: [400, 'A loja não atende nesse horário. Escolha outra janela.', 'schedule_closed']
};

// Valida o scheduled_for do pedido. Sem data (undefined, null ou '') = o quanto antes: devolve null.
// Senão { start: Date, iso, key, capacity }. A vaga é conferida aqui (resposta rápida) e de novo no insert, com a trava.
async function validateRequested(sql, raw, now = new Date()) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(raw)) throw new ScheduleError(...REASON_ERRORS.invalid);
  const start = new Date(raw);
  if (Number.isNaN(start.getTime())) throw new ScheduleError(...REASON_ERRORS.invalid);
  const ctx = await loadContext(sql);
  if (!ctx.cfg.enabled) throw new ScheduleError(409, 'O agendamento está desligado no momento. Faça o pedido para o quanto antes.', 'scheduling_disabled');
  const reason = blockReason(ctx, start, now);
  if (reason) throw new ScheduleError(...REASON_ERRORS[reason]);
  const capacity = ctx.cfg.slot_capacity;
  if (capacity > 0 && (await slotTaken(sql, start)) >= capacity) throw slotFull();
  return { start, iso: start.toISOString(), key: lockKey(start), capacity };
}
async function slotTaken(sql, start) {
  const [{ n }] = await sql.query(`select count(*)::int n from orders where scheduled_for = $1 and ${OCCUPIES_SQL}`, [start.toISOString()]);
  return n;
}
const slotFull = () => new ScheduleError(409, 'Essa janela acabou de lotar. Escolha outro horário.', 'slot_full');

// Bloco público do /api/menu.
const publicBlock = cfg => ({ enabled: cfg.enabled, min_lead_min: cfg.min_lead_min, max_days: cfg.max_days, slot_minutes: SLOT_MIN });

module.exports = {
  SLOT_MIN, LOCK_SLOT, HOLD_PENDING_MIN, DEFAULTS, KEYS, LIMITS, ScheduleError, OCCUPIES_SQL, lockKey,
  parseConfig, getConfig, validateConfig, saveStatements, loadContext, windowsForWeekday, blockReason, scheduledLabel,
  slotsForDate, validateRequested, slotTaken, slotFull, publicBlock
};
