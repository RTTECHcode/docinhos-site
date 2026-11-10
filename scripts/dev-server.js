// Servidor local para desenvolvimento e testes no navegador (imita a Vercel: public/ + api/*.js).
// Lê variáveis SOMENTE de .env.dev via scripts/dev-env.js. Nunca lê .env (produção).
// Uso: node scripts/dev-server.js [porta]   (padrão 3000)  ->  http://localhost:3000
// Os valores das variáveis nunca são impressos.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] || process.env.PORT || 3000);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};

const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
function applyHeaders(res, urlPath) {
  for (const rule of vercel.headers || []) {
    const re = new RegExp('^' + rule.source.replace(/\(\.\*\)/g, '.*') + '$');
    if (re.test(urlPath)) for (const h of rule.headers) res.setHeader(h.key, h.value);
  }
}

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function addHelpers(res) {
  res.status = code => { res.statusCode = code; return res; };
  res.json = data => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(data));
    return res;
  };
  res.send = data => {
    if (data !== null && typeof data === 'object' && !Buffer.isBuffer(data)) return res.json(data);
    res.end(data);
    return res;
  };
  res.redirect = (a, b) => {
    const [code, loc] = typeof a === 'number' ? [a, b] : [307, a];
    res.statusCode = code; res.setHeader('Location', loc); res.end();
    return res;
  };
}

async function handleApi(req, res, url) {
  const name = url.pathname.replace(/^\/api\//, '').replace(/\/$/, '');
  if (!/^[a-z0-9-]+$/i.test(name)) { res.statusCode = 404; return res.end('Not found'); }
  const file = path.join(ROOT, 'api', name + '.js');
  if (!fs.existsSync(file)) { res.statusCode = 404; return res.end('Not found'); }
  const raw = await readBody(req);
  req.query = Object.fromEntries(url.searchParams);
  const type = String(req.headers['content-type'] || '');
  if (raw.length && /application\/json/i.test(type)) {
    try { req.body = JSON.parse(raw.toString('utf8')); } catch { req.body = raw.toString('utf8'); }
  } else if (raw.length && /application\/x-www-form-urlencoded/i.test(type)) {
    req.body = Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
  } else {
    req.body = raw.length ? raw.toString('utf8') : undefined;
  }
  addHelpers(res);
  delete require.cache[require.resolve(file)];
  try {
    await require(file)(req, res);
  } catch (err) {
    console.error('[api/' + name + ']', err && err.message);
    if (!res.headersSent) { res.statusCode = 500; res.end('Erro interno'); }
  }
}

function handleStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { res.statusCode = 400; return res.end('URL inválida'); }
  const base = path.join(ROOT, 'public');
  let file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base)) { res.statusCode = 403; return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  else if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html';
  if (!fs.existsSync(file)) { res.statusCode = 404; return res.end('Not found'); }
  res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(file).pipe(res);
}

const { loaded } = require('./dev-env');
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  applyHeaders(res, url.pathname);
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  return handleStatic(req, res, url);
}).listen(PORT, () => {
  console.log(`dev-server em http://localhost:${PORT} (variáveis de .env.dev: ${loaded.join(', ') || 'nenhuma'})`);
});
