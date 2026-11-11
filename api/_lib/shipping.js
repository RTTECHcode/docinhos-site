'use strict';
/*
 * Frete por faixas de km (O5). A distância é sempre calculada no servidor:
 * CEP (ViaCEP) -> coordenadas (Nominatim/OpenStreetMap) -> rota por estrada (OSRM, perfil driving).
 * Falha do OSRM: distância em linha reta x 1,3 (decisão do orquestrador), registrada no log.
 * Falha do geocoding: erro claro pedindo para conferir endereço/CEP.
 * Cache em tabelas (geocode_cache, route_cache) para não repetir chamadas externas.
 * A rede é injetável (setFetch) para testes: nenhum teste precisa de internet.
 */
const { norm } = require('./text');
const { hasControlChars } = require('./validate');

const VIACEP_URL = 'https://viacep.com.br/ws/';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving/';
// Política do Nominatim: User-Agent identificando o app (sem e-mail), no máximo 1 requisição por segundo.
const USER_AGENT = 'DocinhosDaGigi/1.0 (+https://docinhos-site.vercel.app)';
const TIMEOUT_MS = 5000;
const NOMINATIM_GAP_MS = 1100;
const TOTAL_BUDGET_MS = 12000; // orçamento total de rede por cotação (função serverless curta)
const STRAIGHT_LINE_FACTOR = 1.3;
const DEFAULT_ORIGIN_ADDRESS = 'Rua Manoel Hare Peralta, 101, Ayrosa, Osasco, SP';
const DEFAULT_BANDS = [
  { max_km: 3, fee_cents: 600 },
  { max_km: 6, fee_cents: 900 },
  { max_km: 10, fee_cents: 1400 }
];
const MAX_FEE_CENTS = 100000; // R$ 1.000,00
const MAX_NEW_LOOKUPS_PER_MINUTE = 40; // endereços novos geocodificados por minuto, somando todos os IPs (/api/store e /api/order)

class ShippingError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code || null; }
}

// ---------- Rede injetável ----------
let fetchImpl = null;
const setFetch = fn => { fetchImpl = fn || null; };
let nominatimChain = Promise.resolve();
let lastNominatimAt = 0;

async function doFetch(url, init = {}) {
  const f = fetchImpl || globalThis.fetch;
  return f(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}
async function getJson(url, headers) {
  const res = await doFetch(url, { headers: { Accept: 'application/json', ...(headers || {}) } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
// Garante 1 req/s no Nominatim (por instância; o cache em banco evita repetição entre instâncias).
function nominatimSlot() {
  if (fetchImpl) return Promise.resolve(); // rede simulada: sem espera
  const run = nominatimChain.then(async () => {
    const wait = lastNominatimAt + NOMINATIM_GAP_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastNominatimAt = Date.now();
  });
  nominatimChain = run.catch(() => {});
  return run;
}

// ---------- Entrada ----------
function normalizeCep(input) {
  const d = String(input == null ? '' : input).replace(/\D/g, '');
  return d.length === 8 ? d : null;
}
// Número da casa: campo explícito ou primeiro número "solto" do texto do endereço (fora o CEP).
function extractNumber(address, explicit) {
  if (explicit !== undefined && explicit !== null && String(explicit).trim()) {
    const m = /^\d{1,6}/.exec(String(explicit).trim());
    return m ? m[0] : null;
  }
  const clean = String(address || '').replace(/\b\d{5}-?\d{3}\b/g, ' ');
  // 1) número logo depois de uma vírgula ("Rua 7 de Setembro, 100"); 2) qualquer número solto
  const m = /,\s*(?:n[º°o.]*\s*)?(\d{1,6})(?=[A-Za-z]?(?:[\s,.-]|$))/i.exec(clean)
    || /(?:^|[\s,.-])(?:n[º°o.]*\s*)?(\d{1,6})(?=[A-Za-z]?(?:[\s,.-]|$))/i.exec(clean);
  return m ? m[1] : null;
}

// ---------- Faixas ----------
function validateBands(list) {
  const err = message => { throw new ShippingError(400, message, 'invalid_bands'); };
  if (!Array.isArray(list) || list.length < 1 || list.length > 10) err('Informe de 1 a 10 faixas de frete.');
  const out = [];
  let prev = 0;
  for (const b of list) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) err('Faixa de frete inválida.');
    if (typeof b.max_km !== 'number' || !Number.isFinite(b.max_km) || b.max_km <= prev || b.max_km > 100) err('Cada faixa precisa de um limite em km maior que o da faixa anterior (até 100 km).');
    if (!Number.isInteger(b.fee_cents) || b.fee_cents < 0 || b.fee_cents > MAX_FEE_CENTS) err('O valor do frete deve ser de R$ 0,00 a R$ 1.000,00.');
    prev = Math.round(b.max_km * 100) / 100;
    out.push({ max_km: prev, fee_cents: b.fee_cents });
  }
  return out;
}
async function getBands(sql) {
  const [row] = await sql.query(`select value from settings where key = 'shipping_bands'`);
  try { return validateBands(JSON.parse(row ? row.value : 'null')); } catch { return DEFAULT_BANDS.map(b => ({ ...b })); }
}
async function saveBands(sql, list) {
  const bands = validateBands(list);
  await sql.query(`insert into settings (key, value) values ('shipping_bands', $1) on conflict (key) do update set value = excluded.value`, [JSON.stringify(bands)]);
  return bands;
}
// Primeira faixa em que km <= max_km. Retorna a faixa ou null (fora da área).
function bandForKm(bands, km) {
  const k = Math.round(km * 100) / 100;
  return bands.find(b => k <= b.max_km) || null;
}
const maxKmOf = bands => bands[bands.length - 1].max_km;
const kmLabel = km => String(km).replace('.', ',');

// ---------- Distância ----------
function haversineKm(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const coordKey = p => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;

async function fetchViaCep(cep) {
  const data = await getJson(`${VIACEP_URL}${cep}/json/`);
  if (!data || data.erro) return null;
  return { logradouro: String(data.logradouro || ''), bairro: String(data.bairro || ''), localidade: String(data.localidade || ''), uf: String(data.uf || '') };
}

async function nominatim(query) {
  await nominatimSlot();
  const url = `${NOMINATIM_URL}?format=jsonv2&limit=1&countrycodes=br&q=${encodeURIComponent(query)}`;
  const data = await getJson(url, { 'User-Agent': USER_AGENT, 'Accept-Language': 'pt-BR' });
  const hit = Array.isArray(data) ? data[0] : null;
  const lat = hit ? Number(hit.lat) : NaN, lon = hit ? Number(hit.lon) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon, display: String(hit.display_name || '').slice(0, 300) };
}

// Geocodifica com cache em banco. keyParts identifica o endereço normalizado; queries são tentadas em ordem.
async function geocode(sql, keyParts, queries, deadline) {
  const key = norm(keyParts.join(' ')).slice(0, 300);
  const [cached] = await sql.query('select lat, lon, display from geocode_cache where addr_key = $1', [key]);
  if (cached) return { lat: cached.lat, lon: cached.lon, display: cached.display, cached: true };
  for (const query of queries) {
    if (Date.now() > deadline) break;
    let hit = null;
    try { hit = await nominatim(query); } catch (e) { console.error('frete: Nominatim falhou:', e.message); }
    if (hit) {
      await sql.query(`insert into geocode_cache (addr_key, lat, lon, display) values ($1, $2, $3, $4) on conflict (addr_key) do nothing`, [key, hit.lat, hit.lon, hit.display]);
      return { ...hit, cached: false };
    }
  }
  return null;
}

// Coordenadas da loja: geocodifica uma vez e guarda em settings (store_origin_lat/lon).
async function getOrigin(sql, { refresh = false } = {}) {
  const rows = await sql.query(`select key, value from settings where key in ('store_origin_lat', 'store_origin_lon', 'store_origin_address')`);
  const st = {};
  for (const r of rows) st[r.key] = r.value;
  const lat = Number(st.store_origin_lat), lon = Number(st.store_origin_lon);
  if (!refresh && st.store_origin_lat && st.store_origin_lon && Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  const address = st.store_origin_address || DEFAULT_ORIGIN_ADDRESS;
  const parts = address.split(',').map(p => p.trim()).filter(Boolean);
  const noNumber = parts.filter(p => !/^\d+$/.test(p)).join(', ');
  const streetAndCity = [parts[0], ...parts.slice(-2)].filter(Boolean).join(', ');
  const hit = await geocode(sql, ['origem', address], [...new Set([address, noNumber, streetAndCity])], Date.now() + TOTAL_BUDGET_MS);
  if (!hit) {
    console.error('frete: não foi possível geocodificar o endereço da loja');
    throw new ShippingError(503, 'Não foi possível calcular o frete agora. Tente novamente em instantes.', 'origin_unavailable');
  }
  for (const [k, v] of [['store_origin_lat', hit.lat], ['store_origin_lon', hit.lon]]) {
    await sql.query(`insert into settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value`, [k, String(v)]);
  }
  return { lat: hit.lat, lon: hit.lon };
}
async function setOrigin(sql, lat, lon) {
  for (const [k, v] of [['store_origin_lat', lat], ['store_origin_lon', lon]]) {
    await sql.query(`insert into settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value`, [k, String(v)]);
  }
}

// Distância por estrada com cache; sem OSRM usa linha reta x 1,3 (e não grava no cache).
async function routeKm(sql, origin, dest) {
  const ok = coordKey(origin), dk = coordKey(dest);
  const [cached] = await sql.query('select km from route_cache where origin = $1 and dest = $2', [ok, dk]);
  if (cached) return { km: Number(cached.km), source: 'osrm', cached: true };
  try {
    const url = `${OSRM_URL}${origin.lon},${origin.lat};${dest.lon},${dest.lat}?overview=false`;
    const data = await getJson(url, { 'User-Agent': USER_AGENT });
    const meters = data && data.code === 'Ok' && data.routes && data.routes[0] ? Number(data.routes[0].distance) : NaN;
    if (!Number.isFinite(meters) || meters < 0) throw new Error('resposta sem rota');
    const km = Math.round(meters / 10) / 100;
    await sql.query(`insert into route_cache (origin, dest, km) values ($1, $2, $3) on conflict (origin, dest) do nothing`, [ok, dk, km]);
    return { km, source: 'osrm', cached: false };
  } catch (e) {
    const km = Math.round(haversineKm(origin, dest) * STRAIGHT_LINE_FACTOR * 100) / 100;
    console.warn(`frete: OSRM indisponível (${e.message}); usando linha reta x ${STRAIGHT_LINE_FACTOR}: ${km} km`);
    return { km, source: 'straight_line', cached: false };
  }
}

// ---------- CEP -> endereço (v3 D3) ----------
// Devolve rua, bairro, cidade e UF de um CEP. Reaproveita fetchViaCep (a mesma consulta do frete) e guarda o resultado
// na tabela cep_cache (scripts/migrate-2026-11-10-v3-schema.js) por CEP_CACHE_DAYS dias, para não repetir chamadas ao ViaCEP.
// Só guarda CEP encontrado (CEP inexistente não vai para o cache, e o limite por IP já segura quem insiste).
// Erros: 400 invalid_cep; 404 cep_not_found; 503 cep_unavailable (ViaCEP fora do ar: o front deixa preencher à mão).
const CEP_CACHE_DAYS = 90;
async function lookupCep(sql, input) {
  const cep = normalizeCep(input);
  if (!cep) throw new ShippingError(400, 'Informe o CEP com 8 números.', 'invalid_cep');
  const view = r => ({ cep, street: r.logradouro || '', district: r.bairro || '', city: r.localidade || '', uf: r.uf || '' });
  const [hit] = await sql.query(
    `select logradouro, bairro, localidade, uf from cep_cache where cep = $1 and created_at > now() - make_interval(days => $2::int)`, [cep, CEP_CACHE_DAYS]);
  if (hit) return view(hit);
  let via;
  try { via = await fetchViaCep(cep); } catch (e) {
    console.error('cep: ViaCEP falhou:', e.message);
    throw new ShippingError(503, 'Não foi possível consultar o CEP agora. Preencha o endereço à mão.', 'cep_unavailable');
  }
  if (!via) throw new ShippingError(404, 'CEP não encontrado. Confira o número ou preencha o endereço à mão.', 'cep_not_found');
  await sql.query(
    `insert into cep_cache (cep, logradouro, bairro, localidade, uf) values ($1, $2, $3, $4, $5)
     on conflict (cep) do update set logradouro = excluded.logradouro, bairro = excluded.bairro, localidade = excluded.localidade, uf = excluded.uf, created_at = now()`,
    [cep, via.logradouro.slice(0, 200), via.bairro.slice(0, 120), via.localidade.slice(0, 120), via.uf.slice(0, 2)]);
  return view(via);
}

// Teto global de consultas externas novas (cada endereço novo vira uma linha em geocode_cache).
async function tooManyNewLookups(sql) {
  const [{ n }] = await sql.query(`select count(*)::int n from geocode_cache where created_at > now() - interval '1 minute'`);
  return n >= MAX_NEW_LOOKUPS_PER_MINUTE;
}

/**
 * Cotação de entrega. input: { cep, address, number? }. Lança ShippingError (status 400/422/503).
 * Retorna { km, fee_cents, band: { max_km, fee_cents }, source: 'osrm'|'straight_line', max_km }.
 */
async function quoteDelivery(sql, input) {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const cep = normalizeCep(input && input.cep);
  if (!cep) throw new ShippingError(400, 'Informe o CEP com 8 números.', 'invalid_cep');
  const address = typeof (input && input.address) === 'string' ? input.address.trim() : '';
  if (address.length < 5 || address.length > 200 || hasControlChars(address, false)) throw new ShippingError(400, 'Informe o endereço de entrega (5 a 200 caracteres).', 'invalid_address');
  const number = extractNumber(address, input.number);

  const bands = await getBands(sql);
  const notFound = () => new ShippingError(422, 'Não encontramos esse endereço. Confira o endereço e o CEP.', 'address_not_found');

  let via = null;
  try {
    via = await fetchViaCep(cep);
    if (!via) throw new ShippingError(422, 'CEP não encontrado. Confira o CEP.', 'cep_not_found');
  } catch (e) {
    if (e instanceof ShippingError) throw e;
    console.error('frete: ViaCEP falhou:', e.message); // segue só com o texto do endereço
  }

  let keyParts, queries;
  if (via && via.logradouro) {
    const city = [via.bairro, via.localidade, via.uf, 'Brasil'].filter(Boolean).join(', ');
    keyParts = [via.logradouro, number || 's/n', via.localidade, via.uf];
    const noDistrict = [via.localidade, via.uf, 'Brasil'].filter(Boolean).join(', ');
    queries = [...(number ? [`${via.logradouro}, ${number}, ${city}`] : []), `${via.logradouro}, ${city}`, `${via.logradouro}, ${noDistrict}`];
  } else {
    const city = via ? [via.bairro, via.localidade, via.uf].filter(Boolean).join(', ') : '';
    keyParts = [address, cep];
    queries = [`${address}${city ? ', ' + city : ''}, ${cep}, Brasil`];
  }
  const dest = await geocode(sql, keyParts, queries, deadline);
  if (!dest) throw notFound();
  const origin = await getOrigin(sql);
  const route = await routeKm(sql, origin, dest);
  const km = Math.round(route.km * 100) / 100;
  const band = bandForKm(bands, km);
  if (!band) { const e = new ShippingError(422, `Fora da área de entrega (até ${kmLabel(maxKmOf(bands))} km).`, 'out_of_area'); e.max_km = maxKmOf(bands); throw e; }
  return { km, fee_cents: band.fee_cents, band: { max_km: band.max_km, fee_cents: band.fee_cents }, source: route.source, max_km: maxKmOf(bands) };
}

module.exports = {
  USER_AGENT, DEFAULT_BANDS, DEFAULT_ORIGIN_ADDRESS, STRAIGHT_LINE_FACTOR, ShippingError, setFetch,
  normalizeCep, extractNumber, validateBands, getBands, saveBands, bandForKm, maxKmOf, haversineKm,
  getOrigin, setOrigin, routeKm, geocode, fetchViaCep, lookupCep, CEP_CACHE_DAYS, quoteDelivery, MAX_NEW_LOOKUPS_PER_MINUTE, tooManyNewLookups
};
