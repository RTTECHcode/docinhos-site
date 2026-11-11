// Testes puros (sem banco) de horários e estado da loja, com fuso America/Sao_Paulo: node scripts/test-store-hours.js
const assert = require('node:assert/strict');
const sh = require('../api/_lib/store-hours');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   -', name); }
  catch (e) { console.error('FAIL -', name, '\n      ', e.message); process.exitCode = 1; }
}
const at = iso => new Date(iso);
// 2026-11-10 é terça-feira. São Paulo = UTC-3 (sem horário de verão).
const week = (opens, closes, days = [0, 1, 2, 3, 4, 5, 6]) => days.map(weekday => ({ weekday, opens, closes }));

test('zoneParts: instante UTC vira dia/hora de São Paulo (inclusive na virada do dia)', () => {
  let p = sh.zoneParts(at('2026-11-10T15:00:00Z'));
  assert.deepEqual([p.year, p.month, p.day, p.hour, p.minute, p.weekday], [2026, 11, 10, 12, 0, 2]);
  p = sh.zoneParts(at('2026-11-11T02:30:00Z')); // ainda terça em SP, já quarta em UTC
  assert.deepEqual([p.day, p.hour, p.minute, p.weekday], [10, 23, 30, 2]);
  p = sh.zoneParts(at('2026-11-11T03:00:00Z'));
  assert.deepEqual([p.day, p.hour, p.weekday], [11, 0, 3]); // meia-noite = hora 0, não 24
});

test('zonedToUtc é o inverso de zoneParts', () => {
  const d = sh.zonedToUtc({ year: 2026, month: 11, day: 10, hour: 9, minute: 30 });
  assert.equal(d.toISOString(), '2026-11-10T12:30:00.000Z');
  for (const iso of ['2026-01-01T02:59:00Z', '2026-06-30T23:59:00Z', '2026-12-31T20:15:00Z']) {
    const p = sh.zoneParts(at(iso));
    assert.equal(sh.zonedToUtc(p).toISOString().slice(0, 16), iso.slice(0, 16));
  }
});

test('scheduleAt: aberto dentro da faixa, fechado fora, fecha exatamente no horário de fechamento', () => {
  const rows = week('09:00', '18:00');
  assert.equal(sh.scheduleAt(rows, at('2026-11-10T12:00:00Z')).open, true); // 09:00 SP
  assert.equal(sh.scheduleAt(rows, at('2026-11-10T11:59:00Z')).open, false); // 08:59 SP
  assert.equal(sh.scheduleAt(rows, at('2026-11-10T20:59:00Z')).open, true); // 17:59 SP
  assert.equal(sh.scheduleAt(rows, at('2026-11-10T21:00:00Z')).open, false); // 18:00 SP
  assert.equal(sh.scheduleAt(rows, at('2026-11-10T15:00:00Z')).closes_at.toISOString(), '2026-11-10T21:00:00.000Z');
});

test('várias faixas no mesmo dia (almoço e noite) e dias sem atendimento', () => {
  const rows = [...week('11:00', '14:00', [2]), ...week('18:00', '22:00', [2])];
  assert.equal(sh.scheduleAt(rows, at('2026-11-10T16:00:00Z')).open, true); // 13:00 terça
  assert.equal(sh.scheduleAt(rows, at('2026-11-10T18:00:00Z')).open, false); // 15:00 terça: intervalo
  assert.equal(sh.scheduleAt(rows, at('2026-11-10T22:00:00Z')).open, true); // 19:00 terça
  assert.equal(sh.scheduleAt(rows, at('2026-11-11T16:00:00Z')).open, false); // quarta: sem faixa
});

test('o dia da semana é o de São Paulo, não o de UTC', () => {
  const rows = week('22:00', '23:59', [2]); // só terça à noite
  assert.equal(sh.scheduleAt(rows, at('2026-11-11T02:30:00Z')).open, true); // terça 23:30 SP (quarta em UTC)
  assert.equal(sh.scheduleAt(rows, at('2026-11-10T02:30:00Z')).open, false); // segunda 23:30 SP
});

// ---------- D8 (v3): apagar o horário NÃO pode abrir a loja ----------
test('D8: sem horários cadastrados (lista vazia, undefined ou null): FECHADA, nunca aberta', () => {
  for (const rows of [[], undefined, null]) {
    const s = sh.scheduleAt(rows, at('2026-11-10T15:00:00Z'));
    assert.deepEqual([s.configured, s.open, s.closes_at], [false, false, null]);
    const st = sh.evaluateStoreState({ hoursRows: rows, manual: null, legacy: null, now: at('2026-11-10T15:00:00Z') });
    assert.deepEqual([st.open, st.reason, st.schedule_configured, st.next_open_at], [false, 'schedule', false, null]);
    assert.equal(st.message, 'Estamos fechados no momento.');
  }
});

test('D8: reproduz o bug — loja programada para fechar, Renan apaga o horário: continua fechada', () => {
  const rows = week('09:00', '18:00');
  const night = at('2026-11-10T23:00:00Z'); // 20:00 SP, fora do expediente
  assert.equal(sh.evaluateStoreState({ hoursRows: rows, manual: null, legacy: null, now: night }).open, false);
  assert.equal(sh.evaluateStoreState({ hoursRows: [], manual: null, legacy: null, now: night }).open, false, 'apagar o horário não pode abrir');
  const day = at('2026-11-10T15:00:00Z'); // 12:00 SP, dentro do expediente
  assert.equal(sh.evaluateStoreState({ hoursRows: rows, manual: null, legacy: null, now: day }).open, true);
  assert.equal(sh.evaluateStoreState({ hoursRows: [], manual: null, legacy: null, now: day }).open, false, 'sem horário nunca abre, nem em horário comercial');
});

test('D8: dia sem horário = fechado (agenda só com quarta; terça fecha o dia todo)', () => {
  const rows = week('09:00', '18:00', [3]);
  assert.equal(sh.scheduleAt(rows, at('2026-11-10T15:00:00Z')).open, false); // terça 12:00 SP
  assert.equal(sh.scheduleAt(rows, at('2026-11-11T15:00:00Z')).open, true);  // quarta 12:00 SP
  const st = sh.evaluateStoreState({ hoursRows: rows, manual: null, legacy: null, now: at('2026-11-10T15:00:00Z') });
  assert.deepEqual([st.open, st.reason, st.schedule_configured], [false, 'schedule', true]);
  assert.equal(st.next_open_at, '2026-11-11T12:00:00.000Z');
});

test('D8: fechamento manual vence o horário aberto, em todas as formas (prazo, até reabrir, pausa antiga)', () => {
  const rows = week('00:00', '23:59');
  const now = at('2026-11-10T15:00:00Z');
  assert.equal(sh.evaluateStoreState({ hoursRows: rows, manual: null, legacy: null, now }).open, true);
  const timed = sh.evaluateStoreState({ hoursRows: rows, manual: { closed_until: at('2026-11-10T16:00:00Z'), closed_indefinitely: false, closed_message: null }, legacy: null, now });
  assert.deepEqual([timed.open, timed.reason], [false, 'manual']);
  const indef = sh.evaluateStoreState({ hoursRows: rows, manual: { closed_until: null, closed_indefinitely: true, closed_message: null }, legacy: null, now });
  assert.deepEqual([indef.open, indef.reason], [false, 'manual']);
  const legacy = sh.evaluateStoreState({ hoursRows: rows, manual: null, legacy: { paused: true, message: '' }, now });
  assert.deepEqual([legacy.open, legacy.reason], [false, 'manual']);
});

test('D8: fechamento manual com prazo e SEM horários não promete reabertura (a loja não abre sozinha)', () => {
  const now = at('2026-11-10T15:00:00Z');
  const manual = { closed_until: at('2026-11-10T16:00:00Z'), closed_indefinitely: false, closed_message: 'Acabou o doce' };
  const st = sh.evaluateStoreState({ hoursRows: [], manual, legacy: null, now });
  assert.deepEqual([st.open, st.reason, st.reopens_at, st.next_open_at, st.message], [false, 'manual', null, null, 'Acabou o doce']);
  const later = sh.evaluateStoreState({ hoursRows: [], manual, legacy: null, now: at('2026-11-10T16:00:01Z') });
  assert.deepEqual([later.open, later.reason], [false, 'schedule'], 'depois que o prazo vence, sem horários continua fechada');
});

test('D8: hoursWarning avisa o painel só quando não há nenhum horário', () => {
  assert.equal(sh.hoursWarning([]), 'no_hours');
  assert.equal(sh.hoursWarning(undefined), 'no_hours');
  assert.equal(sh.hoursWarning(week('09:00', '18:00', [1])), null);
});

test('D8: nextOpenAfter sem horários = null (nunca abre sozinha)', () => {
  assert.equal(sh.nextOpenAfter([], at('2026-11-10T15:00:00Z')), null);
});

test('nextOpenAfter: hoje mais tarde, amanhã, e pula dias sem atendimento', () => {
  const rows = week('09:00', '18:00', [1, 2, 3, 4, 5]); // segunda a sexta
  assert.equal(sh.nextOpenAfter(rows, at('2026-11-10T11:00:00Z')).toISOString(), '2026-11-10T12:00:00.000Z'); // antes de abrir: hoje 09:00
  assert.equal(sh.nextOpenAfter(rows, at('2026-11-10T15:00:00Z')).toISOString(), '2026-11-10T15:00:00.000Z'); // já aberto
  assert.equal(sh.nextOpenAfter(rows, at('2026-11-10T22:00:00Z')).toISOString(), '2026-11-11T12:00:00.000Z'); // depois de fechar: amanhã 09:00
  assert.equal(sh.nextOpenAfter(rows, at('2026-11-14T15:00:00Z')).toISOString(), '2026-11-16T12:00:00.000Z'); // sábado -> segunda
});

test('whenLabel: hoje, amanhã, dia da semana e data', () => {
  const now = at('2026-11-10T15:00:00Z');
  assert.equal(sh.whenLabel(at('2026-11-10T20:00:00Z'), now), 'hoje às 17:00');
  assert.equal(sh.whenLabel(at('2026-11-11T12:00:00Z'), now), 'amanhã às 09:00');
  assert.equal(sh.whenLabel(at('2026-11-13T12:00:00Z'), now), 'sexta-feira às 09:00');
  assert.equal(sh.whenLabel(at('2026-11-20T12:00:00Z'), now), '20/11 às 09:00');
});

test('estado: aberto pela agenda informa quando fecha', () => {
  const st = sh.evaluateStoreState({ hoursRows: week('09:00', '18:00'), manual: null, legacy: null, now: at('2026-11-10T15:00:00Z') });
  assert.deepEqual([st.open, st.reason, st.message], [true, null, null]);
  assert.equal(st.closes_at, '2026-11-10T21:00:00.000Z');
});

test('estado: fechado pela agenda -> reason schedule com a próxima abertura', () => {
  const st = sh.evaluateStoreState({ hoursRows: week('09:00', '18:00'), manual: null, legacy: null, now: at('2026-11-10T23:00:00Z') }); // 20:00 SP
  assert.equal(st.open, false);
  assert.equal(st.reason, 'schedule');
  assert.equal(st.next_open_at, '2026-11-11T12:00:00.000Z');
  assert.match(st.message, /Abrimos amanhã às 09:00/);
});

test('estado: fechamento manual com prazo -> reason manual, reopens_at e mensagem; vence sozinho', () => {
  const now = at('2026-11-10T15:00:00Z');
  const manual = { closed_until: at('2026-11-10T15:30:00Z'), closed_indefinitely: false, closed_message: 'Acabou o brigadeiro' };
  const st = sh.evaluateStoreState({ hoursRows: week('09:00', '18:00'), manual, legacy: null, now });
  assert.equal(st.open, false);
  assert.equal(st.reason, 'manual');
  assert.equal(st.reopens_at, '2026-11-10T15:30:00.000Z');
  assert.match(st.message, /^Acabou o brigadeiro/);
  const later = sh.evaluateStoreState({ hoursRows: week('09:00', '18:00'), manual, legacy: null, now: at('2026-11-10T15:30:01Z') });
  assert.equal(later.open, true, 'o fechamento expira sozinho, sem ninguém reabrir');
});

test('estado: fechamento manual que termina depois do expediente informa a próxima abertura da agenda', () => {
  const manual = { closed_until: at('2026-11-10T21:30:00Z'), closed_indefinitely: false, closed_message: null }; // 18:30 SP
  const st = sh.evaluateStoreState({ hoursRows: week('09:00', '18:00'), manual, legacy: null, now: at('2026-11-10T20:00:00Z') });
  assert.equal(st.reopens_at, '2026-11-10T21:30:00.000Z');
  assert.equal(st.next_open_at, '2026-11-11T12:00:00.000Z');
});

test('estado: fechado até reabrir não tem prazo; pausa antiga (settings.store_paused) também fecha', () => {
  const now = at('2026-11-10T15:00:00Z');
  const a = sh.evaluateStoreState({ hoursRows: [], manual: { closed_until: null, closed_indefinitely: true, closed_message: null }, legacy: null, now });
  assert.deepEqual([a.open, a.reason, a.reopens_at], [false, 'manual', null]);
  const b = sh.evaluateStoreState({ hoursRows: week('09:00', '18:00'), manual: null, legacy: { paused: true, message: 'Pausado!' }, now });
  assert.deepEqual([b.open, b.reason, b.message], [false, 'manual', 'Pausado!']);
});

test('fechamento manual vence mesmo com a agenda aberta; agenda fechada continua fechada depois que o manual vence', () => {
  const rows = week('09:00', '12:00');
  const manual = { closed_until: at('2026-11-10T14:00:00Z'), closed_indefinitely: false, closed_message: null };
  const st = sh.evaluateStoreState({ hoursRows: rows, manual, legacy: null, now: at('2026-11-10T16:00:00Z') }); // 13:00 SP, manual já venceu
  assert.deepEqual([st.open, st.reason], [false, 'schedule']);
});

test('validateHours: formato, ordem e sobreposição', () => {
  assert.deepEqual(sh.validateHours([{ weekday: 1, opens: '9:00', closes: '18:00' }, { weekday: 1, opens: '19:00', closes: '22:30' }]),
    [{ weekday: 1, opens: '09:00', closes: '18:00' }, { weekday: 1, opens: '19:00', closes: '22:30' }]);
  assert.deepEqual(sh.validateHours([]), []);
  const bad = list => assert.throws(() => sh.validateHours(list), sh.StoreError);
  bad([{ weekday: 7, opens: '09:00', closes: '18:00' }]);
  bad([{ weekday: -1, opens: '09:00', closes: '18:00' }]);
  bad([{ weekday: 1.5, opens: '09:00', closes: '18:00' }]);
  bad([{ weekday: 1, opens: '18:00', closes: '09:00' }]);
  bad([{ weekday: 1, opens: '09:00', closes: '09:00' }]);
  bad([{ weekday: 1, opens: '9h', closes: '18:00' }]);
  bad([{ weekday: 1, opens: '09:00', closes: '24:00' }]);
  bad([{ weekday: 1, opens: '09:00', closes: '13:00' }, { weekday: 1, opens: '12:00', closes: '18:00' }]);
  bad('x'); bad([null]); bad([{}]);
});

console.log(`\n${passed} testes passaram${process.exitCode ? ' (com falhas)' : ''}`);
