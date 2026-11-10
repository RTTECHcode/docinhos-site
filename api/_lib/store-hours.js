'use strict';
/*
 * Horários e estado da loja (O3, O4). Fuso America/Sao_Paulo calculado com Intl (sem dependências).
 * Tudo que "expira" é derivado de timestamps: nada de cron. Funções puras recebem `now` para teste.
 *
 * Sem horários cadastrados = agenda não configurada = a loja é considerada aberta pelo horário
 * (só o fechamento manual fecha). Assim o Renan pode configurar com calma sem travar os pedidos.
 */
const TZ = 'America/Sao_Paulo';
const DAY_MS = 24 * 3600 * 1000;
const WEEKDAYS_PT = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const WD_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

class StoreError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = message => { throw new StoreError(400, message); };

const fmtCache = new Map();
function formatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric'
    }));
  }
  return fmtCache.get(tz);
}

// Data/hora de parede no fuso: { year, month, day, hour, minute, second, weekday (0=domingo) }.
function zoneParts(date, tz = TZ) {
  const o = {};
  for (const p of formatter(tz).formatToParts(date)) o[p.type] = p.value;
  return {
    year: Number(o.year), month: Number(o.month), day: Number(o.day),
    hour: Number(o.hour) % 24, minute: Number(o.minute), second: Number(o.second), weekday: WD_INDEX[o.weekday]
  };
}

// Converte uma hora de parede no fuso para o instante UTC (Date).
function zonedToUtc({ year, month, day, hour = 0, minute = 0 }, tz = TZ) {
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let i = 0; i < 3; i++) { // ajusta pelo deslocamento real do fuso naquele instante
    const p = zoneParts(new Date(guess), tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const diff = asUtc - guess;
    guess = Date.UTC(year, month - 1, day, hour, minute, 0) - diff;
  }
  return new Date(guess);
}

const pad = n => String(n).padStart(2, '0');
const toHHMM = minutes => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
function parseHHMM(v, label = 'Horário') {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(typeof v === 'string' ? v.trim() : '');
  if (!m) bad(`${label}: use o formato HH:MM (00:00 a 23:59).`);
  return Number(m[1]) * 60 + Number(m[2]);
}

// rows: [{ weekday, opens, closes }] (opens/closes 'HH:MM[:SS]'). Retorna { 0: [[ini, fim], ...], ... } em minutos.
function groupHours(rows) {
  const byDay = {};
  for (let d = 0; d < 7; d++) byDay[d] = [];
  for (const r of rows || []) byDay[Number(r.weekday)].push([parseHHMM(String(r.opens)), parseHHMM(String(r.closes))]);
  for (let d = 0; d < 7; d++) byDay[d].sort((a, b) => a[0] - b[0]);
  return byDay;
}
const isConfigured = rows => Array.isArray(rows) && rows.length > 0;

// Primeiro instante >= t em que a loja está aberta pela agenda (t se já aberta). null se a agenda está vazia.
function nextOpenAfter(rows, t) {
  if (!isConfigured(rows)) return t;
  const byDay = groupHours(rows);
  const p = zoneParts(t);
  const m = p.hour * 60 + p.minute + p.second / 60;
  for (let d = 0; d <= 7; d++) {
    const base = new Date(Date.UTC(p.year, p.month - 1, p.day + d));
    const wd = (p.weekday + d) % 7;
    for (const [open, close] of byDay[wd]) {
      if (d === 0 && m >= close) continue;
      if (d === 0 && m >= open) return t;
      const at = zonedToUtc({ year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: base.getUTCDate(), hour: Math.floor(open / 60), minute: open % 60 });
      return at;
    }
  }
  return null;
}

// Estado pela agenda em `now`: { configured, open, closes_at }.
function scheduleAt(rows, now = new Date()) {
  if (!isConfigured(rows)) return { configured: false, open: true, closes_at: null };
  const byDay = groupHours(rows);
  const p = zoneParts(now);
  const m = p.hour * 60 + p.minute + p.second / 60;
  for (const [open, close] of byDay[p.weekday]) {
    if (m >= open && m < close) {
      return { configured: true, open: true, closes_at: zonedToUtc({ year: p.year, month: p.month, day: p.day, hour: Math.floor(close / 60), minute: close % 60 }) };
    }
  }
  return { configured: true, open: false, closes_at: null };
}

// Rótulo em português relativo a `now`: "hoje às 14:00", "amanhã às 09:00", "sexta-feira às 09:00", "20/11 às 09:00".
function whenLabel(instant, now = new Date()) {
  const a = zoneParts(instant), b = zoneParts(now);
  const dayDiff = Math.round((Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day)) / DAY_MS);
  const hm = `${pad(a.hour)}:${pad(a.minute)}`;
  if (dayDiff <= 0) return `hoje às ${hm}`;
  if (dayDiff === 1) return `amanhã às ${hm}`;
  if (dayDiff < 7) return `${WEEKDAYS_PT[a.weekday]} às ${hm}`;
  return `${pad(a.day)}/${pad(a.month)} às ${hm}`;
}

/**
 * Estado da loja. Função pura.
 * hoursRows: linhas de store_hours. manual: { closed_until: Date|null, closed_indefinitely, closed_message } | null
 * legacy: { paused: boolean, message } (chave settings.store_paused do painel antigo = fechamento manual sem prazo)
 * Retorna { open, reason: null|'schedule'|'manual', reopens_at, next_open_at, closes_at, message, schedule_configured } (datas em ISO).
 */
function evaluateStoreState({ hoursRows, manual, legacy, now = new Date() }) {
  const iso = d => (d ? d.toISOString() : null);
  const sched = scheduleAt(hoursRows, now);
  const timed = manual && manual.closed_until && manual.closed_until.getTime() > now.getTime() ? manual : null;
  const indefinite = manual && manual.closed_indefinitely ? manual : null;
  const legacyOn = legacy && legacy.paused;

  if (indefinite || legacyOn) {
    const custom = (indefinite && indefinite.closed_message) || (legacyOn && legacy.message) || '';
    return {
      open: false, reason: 'manual', reopens_at: null, next_open_at: null, closes_at: null, schedule_configured: sched.configured,
      message: custom || 'Estamos fechados no momento. Voltamos em breve!'
    };
  }
  if (timed) {
    const reopens = timed.closed_until;
    const next = nextOpenAfter(hoursRows, reopens);
    const base = timed.closed_message || 'Estamos fechados no momento.';
    return {
      open: false, reason: 'manual', reopens_at: iso(reopens), next_open_at: iso(next), closes_at: null, schedule_configured: sched.configured,
      message: `${base} Previsão de reabertura: ${whenLabel(next || reopens, now)}.`
    };
  }
  if (!sched.open) {
    const next = nextOpenAfter(hoursRows, now);
    return {
      open: false, reason: 'schedule', reopens_at: null, next_open_at: iso(next), closes_at: null, schedule_configured: true,
      message: next ? `Estamos fechados agora. Abrimos ${whenLabel(next, now)}.` : 'Estamos fechados no momento.'
    };
  }
  return { open: true, reason: null, reopens_at: null, next_open_at: null, closes_at: iso(sched.closes_at), message: null, schedule_configured: sched.configured };
}

// ---------- Banco ----------
async function loadHours(sql) {
  const rows = await sql.query(`select weekday, to_char(opens, 'HH24:MI') as opens, to_char(closes, 'HH24:MI') as closes
                                  from store_hours order by weekday, opens`);
  return rows.map(r => ({ weekday: Number(r.weekday), opens: r.opens, closes: r.closes }));
}

async function loadManual(sql) {
  const [row] = await sql.query('select closed_until, closed_indefinitely, closed_message, updated_by, updated_at from store_state where id = 1');
  if (!row) return null;
  return {
    closed_until: row.closed_until ? new Date(row.closed_until) : null,
    closed_indefinitely: !!row.closed_indefinitely,
    closed_message: row.closed_message || null,
    updated_by: row.updated_by || null,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null
  };
}

async function getStoreState(sql, now = new Date()) {
  const [hoursRows, manual, settingRows] = await Promise.all([
    loadHours(sql), loadManual(sql),
    sql.query(`select key, value from settings where key in ('store_paused', 'store_paused_message')`)
  ]);
  const st = {};
  for (const r of settingRows) st[r.key] = r.value;
  const state = evaluateStoreState({ hoursRows, manual, legacy: { paused: st.store_paused === '1', message: st.store_paused_message || '' }, now });
  return { ...state, hours: hoursRows };
}

// Valida e normaliza a grade semanal enviada pelo admin.
function validateHours(list) {
  if (!Array.isArray(list) || list.length > 42) bad('Horários inválidos (no máximo 6 faixas por dia).');
  const out = [];
  const byDay = {};
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) bad('Horário inválido.');
    if (!Number.isInteger(item.weekday) || item.weekday < 0 || item.weekday > 6) bad('Dia da semana inválido (0 = domingo a 6 = sábado).');
    const opens = parseHHMM(item.opens, 'Abertura'), closes = parseHHMM(item.closes, 'Fechamento');
    if (closes <= opens) bad(`${WEEKDAYS_PT[item.weekday]}: o fechamento precisa ser depois da abertura.`);
    (byDay[item.weekday] ||= []).push([opens, closes]);
    out.push({ weekday: item.weekday, opens, closes });
  }
  for (const [d, ranges] of Object.entries(byDay)) {
    if (ranges.length > 6) bad(`${WEEKDAYS_PT[d]}: no máximo 6 faixas.`);
    ranges.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) bad(`${WEEKDAYS_PT[d]}: as faixas se sobrepõem.`);
  }
  out.sort((a, b) => a.weekday - b.weekday || a.opens - b.opens);
  return out.map(r => ({ weekday: r.weekday, opens: toHHMM(r.opens), closes: toHHMM(r.closes) }));
}

// Substitui a grade inteira numa transação (só a tabela store_hours).
async function saveHours(sql, list) {
  const rows = validateHours(list);
  const queries = [sql.query('delete from store_hours')];
  if (rows.length) {
    queries.push(sql.query(
      'insert into store_hours (weekday, opens, closes) select * from unnest($1::int[], $2::time[], $3::time[])',
      [rows.map(r => r.weekday), rows.map(r => r.opens), rows.map(r => r.closes)]));
  }
  await sql.transaction(queries);
  return rows;
}

const MAX_CLOSE_MINUTES = 7 * 24 * 60;
// Fecha manualmente. minutes (1..10080) ou indefinite:true (até reabrir).
async function closeStore(sql, { minutes, indefinite, message, user }, now = new Date()) {
  let msg = null;
  if (message !== undefined && message !== null && message !== '') {
    if (typeof message !== 'string' || message.length > 200) bad('Mensagem: use até 200 caracteres.');
    msg = message.trim() || null;
  }
  let until = null;
  if (indefinite === true) {
    until = null;
  } else {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_CLOSE_MINUTES) bad('Informe o prazo em minutos (1 a 10080) ou escolha "até reabrir".');
    until = new Date(now.getTime() + minutes * 60000);
  }
  await sql.query(
    `insert into store_state (id, closed_until, closed_indefinitely, closed_message, updated_by, updated_at)
     values (1, $1, $2, $3, $4, now())
     on conflict (id) do update set closed_until = excluded.closed_until, closed_indefinitely = excluded.closed_indefinitely,
       closed_message = excluded.closed_message, updated_by = excluded.updated_by, updated_at = now()`,
    [until ? until.toISOString() : null, indefinite === true, msg, user ? String(user).slice(0, 64) : null]);
}

// Reabre: limpa o fechamento manual (e o pause legado do painel antigo).
async function reopenStore(sql, user) {
  await sql.transaction([
    sql.query(`insert into store_state (id, closed_until, closed_indefinitely, closed_message, updated_by, updated_at)
               values (1, null, false, null, $1, now())
               on conflict (id) do update set closed_until = null, closed_indefinitely = false, closed_message = null,
                 updated_by = excluded.updated_by, updated_at = now()`, [user ? String(user).slice(0, 64) : null]),
    sql.query(`insert into settings (key, value) values ('store_paused', '0') on conflict (key) do update set value = '0'`)
  ]);
}

module.exports = {
  TZ, WEEKDAYS_PT, StoreError, zoneParts, zonedToUtc, parseHHMM, toHHMM, groupHours, scheduleAt, nextOpenAfter, whenLabel,
  evaluateStoreState, loadHours, loadManual, getStoreState, validateHours, saveHours, closeStore, reopenStore
};
