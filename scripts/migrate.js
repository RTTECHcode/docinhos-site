// Aplica só o schema (idempotente, aditivo). Uso: set -a && . ./.env && set +a && node scripts/migrate.js
const sql = require('../api/_lib/db');
const fs = require('fs');
(async () => {
  const schema = fs.readFileSync(__dirname + '/schema.sql', 'utf8');
  for (const statement of schema.split(';').map(s => s.trim()).filter(Boolean)) await sql.query(statement);
  console.log('Migração aplicada');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
