'use strict';
/*
 * F6 M1: adaptador único entre as Netlify Functions (evento estilo Lambda, `handler(event, context)`) e os handlers de
 * api/*.js, que continuam iguais (assinatura da Vercel/Node: `(req, res)`).
 *
 * req: method, url ("/api/<nome>?<query>"), headers (minúsculas), query (chave repetida vira lista, como na Vercel),
 *      body (JSON, formulário ou texto, como no servidor local), rawBody (Buffer com o corpo CRU, byte a byte) e socket.
 * res: statusCode, setHeader/getHeader/removeHeader/hasHeader, status(), json(), send(), redirect(), writeHead(),
 *      write() e end(). Set-Cookie com várias linhas sai em multiValueHeaders. Corpo binário (imagem) sai em base64.
 *
 * Segurança:
 *  - IP do cliente: x-real-ip enviado pelo cliente é descartado. Vale o x-nf-client-connection-ip, que a Netlify preenche
 *    na borda (api/_lib/auth.js clientIp lê x-real-ip primeiro). Sem ele, sobra o x-forwarded-for (só reserva).
 *  - Cabeçalhos do netlify.toml (segurança, CSP, Cache-Control) também valem na resposta da API, como na Vercel.
 *    O handler pode sobrescrever (ex.: Cache-Control: no-store que todos já mandam).
 *  - Erro não tratado no handler: 500 "Erro interno", sem detalhe para o cliente (só no log).
 */
const { headersFor, loadRules } = require('./toml-headers');

const TEXT_TYPE = /^(text\/|application\/(json|javascript|xml|x-www-form-urlencoded)|image\/svg\+xml)|[+\/]json\b|[+\/]xml\b/i;

// Corpo igual ao do servidor local (scripts/dev-server.js usa esta mesma função).
function parseBody(raw, contentType) {
  if (!raw || !raw.length) return undefined;
  const type = String(contentType || '');
  if (/application\/json/i.test(type)) {
    try { return JSON.parse(raw.toString('utf8')); } catch { return raw.toString('utf8'); }
  }
  if (/application\/x-www-form-urlencoded/i.test(type)) return Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
  return raw.toString('utf8');
}

// Query como na Vercel: valor único = texto; chave repetida = lista na ordem.
function parseQuery(search) {
  const out = {};
  for (const [k, v] of new URLSearchParams(search || '')) {
    if (!(k in out)) out[k] = v;
    else out[k] = Array.isArray(out[k]) ? [...out[k], v] : [out[k], v];
  }
  return out;
}

function rawQueryOf(event) {
  if (typeof event.rawQuery === 'string') return event.rawQuery.replace(/^\?/, '');
  if (event.rawUrl) { try { return new URL(event.rawUrl).search.replace(/^\?/, ''); } catch { /* segue */ } }
  const sp = new URLSearchParams();
  const multi = event.multiValueQueryStringParameters || {};
  const single = event.queryStringParameters || {};
  for (const k of Object.keys(multi)) for (const v of [].concat(multi[k] || [])) sp.append(k, v);
  for (const k of Object.keys(single)) if (!(k in multi)) sp.append(k, single[k]);
  return sp.toString();
}

function headersOf(event) {
  const h = {};
  for (const [k, v] of Object.entries(event.headers || {})) if (v !== undefined && v !== null) h[k.toLowerCase()] = String(v);
  for (const [k, list] of Object.entries(event.multiValueHeaders || {})) {
    const key = k.toLowerCase();
    if (Array.isArray(list) && list.length > 1) h[key] = list.join(key === 'cookie' ? '; ' : ', ');
  }
  // IP: nunca confiar no x-real-ip que veio do cliente.
  delete h['x-real-ip'];
  const edgeIp = (h['x-nf-client-connection-ip'] || '').trim();
  if (edgeIp) h['x-real-ip'] = edgeIp;
  return h;
}

function buildRequest(event, name) {
  const headers = headersOf(event);
  const query = rawQueryOf(event);
  const rawBody = event.body == null ? Buffer.alloc(0) : Buffer.from(String(event.body), event.isBase64Encoded ? 'base64' : 'utf8');
  return {
    method: String(event.httpMethod || 'GET').toUpperCase(),
    url: `/api/${name}` + (query ? '?' + query : ''),
    headers,
    query: parseQuery(query),
    body: parseBody(rawBody, headers['content-type']),
    rawBody,
    socket: { remoteAddress: headers['x-real-ip'] || undefined }
  };
}

class FunctionResponse {
  constructor() {
    this.statusCode = 200;
    this.headersSent = false;
    this.finished = false;
    this._headers = new Map(); // nome minúsculo -> [nome original, valor]
    this._chunks = [];
  }
  setHeader(name, value) { this._headers.set(String(name).toLowerCase(), [String(name), value]); return this; }
  getHeader(name) { const e = this._headers.get(String(name).toLowerCase()); return e ? e[1] : undefined; }
  hasHeader(name) { return this._headers.has(String(name).toLowerCase()); }
  removeHeader(name) { this._headers.delete(String(name).toLowerCase()); }
  getHeaders() { const o = {}; for (const [k, [, v]] of this._headers) o[k] = v; return o; }
  status(code) { this.statusCode = code; return this; }
  writeHead(code, a, b) {
    this.statusCode = code;
    const hs = typeof a === 'object' && a ? a : (typeof b === 'object' && b ? b : null);
    if (hs) for (const [k, v] of Object.entries(hs)) this.setHeader(k, v);
    return this;
  }
  write(chunk, encoding) {
    if (this.finished || chunk == null) return true;
    this._chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding || 'utf8'));
    this.headersSent = true;
    return true;
  }
  end(chunk, encoding) {
    if (this.finished) return this;
    if (typeof chunk !== 'function') this.write(chunk, encoding);
    this.finished = true;
    this.headersSent = true;
    return this;
  }
  json(data) {
    if (!this.hasHeader('Content-Type')) this.setHeader('Content-Type', 'application/json; charset=utf-8');
    return this.end(JSON.stringify(data));
  }
  send(data) {
    if (data !== null && typeof data === 'object' && !Buffer.isBuffer(data)) return this.json(data);
    return this.end(data);
  }
  redirect(a, b) {
    const [code, loc] = typeof a === 'number' ? [a, b] : [307, a];
    this.statusCode = code; this.setHeader('Location', loc);
    return this.end();
  }
}

// Monta a resposta da Function: cabeçalhos do netlify.toml + os do handler (o handler vence).
function toResult(res, baseHeaders) {
  const headers = {}, multiValueHeaders = {};
  const all = new Map();
  for (const [k, v] of Object.entries(baseHeaders || {})) all.set(k.toLowerCase(), [k, v]);
  for (const [k, e] of res._headers) all.set(k, e);
  for (const [, [name, value]] of all) {
    if (Array.isArray(value)) {
      if (value.length === 1) headers[name] = String(value[0]);
      else if (value.length > 1) multiValueHeaders[name] = value.map(String);
    } else if (value !== undefined && value !== null) headers[name] = String(value);
  }
  const body = Buffer.concat(res._chunks);
  const type = String(res.getHeader('Content-Type') || '');
  const binary = body.length > 0 && !!type && !TEXT_TYPE.test(type);
  const result = { statusCode: res.statusCode, headers, body: binary ? body.toString('base64') : body.toString('utf8'), isBase64Encoded: binary };
  if (Object.keys(multiValueHeaders).length) result.multiValueHeaders = multiValueHeaders;
  return result;
}

let cachedRules; // carregado uma vez por instância
function rulesOnce() {
  if (cachedRules === undefined) {
    cachedRules = loadRules();
    if (!cachedRules) console.warn('netlify.toml não encontrado na Function: cabeçalhos de segurança só os da CDN.');
  }
  return cachedRules || [];
}

/**
 * Cria o handler da Netlify Function para um handler de api/*.js.
 * @param {Function} apiHandler (req, res) => Promise
 * @param {string} name nome da rota (/api/<name>)
 * @param {{ rules?: Array }} [opts] regras de cabeçalho (teste); padrão: lidas do netlify.toml
 */
function createHandler(apiHandler, name, opts = {}) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Nome de rota inválido: ' + name);
  return async function handler(event) {
    const req = buildRequest(event || {}, name);
    const res = new FunctionResponse();
    try {
      await apiHandler(req, res);
      if (!res.finished) throw new Error('handler terminou sem responder');
    } catch (err) {
      console.error('[api/' + name + ']', err && err.message);
      if (!res.finished) {
        res._headers.clear(); res._chunks = [];
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end('Erro interno');
      }
    }
    return toResult(res, headersFor(opts.rules || rulesOnce(), `/api/${name}`));
  };
}

module.exports = { createHandler, buildRequest, parseBody, parseQuery, FunctionResponse, toResult };
