// Serve imagens guardadas no banco (tabela images). GET público, cache imutável (cada upload gera um id novo).
module.exports = async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.statusCode = 405;
    return res.end('Método não permitido');
  }
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const raw = url.searchParams.get('id') || '';
    const id = /^\d{1,10}$/.test(raw) ? Number(raw) : 0;
    if (!Number.isInteger(id) || id < 1 || id > 2147483647) {
      res.setHeader('Cache-Control', 'no-store');
      res.statusCode = 404;
      return res.end('Não encontrada');
    }
    const sql = require('./db');
    const rows = await sql.query('select mime, data from images where id = $1', [id]);
    if (!rows[0]) {
      res.setHeader('Cache-Control', 'no-store');
      res.statusCode = 404;
      return res.end('Não encontrada');
    }
    const data = Buffer.from(rows[0].data);
    res.statusCode = 200;
    res.setHeader('Content-Type', rows[0].mime);
    res.setHeader('Content-Length', String(data.length));
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.end(req.method === 'HEAD' ? undefined : data);
  } catch (error) {
    console.error('Erro ao servir imagem:', error && error.message);
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = 500;
    return res.end('Erro');
  }
};
