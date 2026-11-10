// Cria ou atualiza (upsert) um usuário do painel /admin. Usuário e senha vêm SÓ de variáveis de ambiente,
// passadas na linha de comando da execução (nunca grave senhas em arquivos do repositório):
//
//   set -a && . ./.env && set +a
//   ADMIN_USER=nome ADMIN_PASS='senha' ADMIN_ROLE=admin node scripts/create-admin-users.js
//
// ADMIN_ROLE: 'admin' ou 'staff' (padrão 'staff'). ADMIN_WEAK=1 marca weak_password=true (aviso fixo no painel
// até a pessoa trocar a senha). Esta é a única via que aceita senha curta; pelo painel o mínimo é 8 caracteres.
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const sql = require('../api/_lib/db');

const PARAMS = { N: 32768, r: 8, p: 1, keylen: 64 };

async function hashPassword(password) {
  const { N, r, p, keylen } = PARAMS;
  const salt = crypto.randomBytes(16);
  const dk = await scrypt(String(password).normalize('NFKC'), salt, keylen, { N, r, p, maxmem: 128 * N * r * 2 + 1048576 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

(async () => {
  const username = String(process.env.ADMIN_USER || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASS || '';
  const role = process.env.ADMIN_ROLE || 'staff';
  const weak = process.env.ADMIN_WEAK === '1';
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new Error('ADMIN_USER inválido (3 a 32 caracteres: a-z, 0-9, ponto, hífen, sublinhado).');
  if (!password) throw new Error('Defina ADMIN_PASS na linha de comando.');
  if (!['admin', 'staff'].includes(role)) throw new Error("ADMIN_ROLE deve ser 'admin' ou 'staff'.");
  const hash = await hashPassword(password);
  await sql.query(
    `insert into admin_users (username, password_hash, role, weak_password, active) values ($1, $2, $3, $4, true)
     on conflict (username) do update set password_hash = excluded.password_hash, role = excluded.role,
       weak_password = excluded.weak_password, active = true`,
    [username, hash, role, weak]);
  await sql.query('delete from admin_sessions where user_id = (select id from admin_users where username = $1)', [username]);
  await sql.query(`insert into admin_audit (username, action, detail) values ($1, 'usuario_bootstrap', $2)`, [username, `role=${role} weak=${weak}`]);
  console.log(`Usuário "${username}" gravado (perfil ${role}, senha fraca: ${weak ? 'sim' : 'não'}).`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
