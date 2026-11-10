// Desbloqueia um usuário do painel /admin (apaga as tentativas de login registradas dele).
//
// Uso (a senha NÃO é necessária):
//   set -a && . ./.env && set +a && node scripts/unlock-admin.js <usuario>
//   Exemplo: node scripts/unlock-admin.js gigi
//
// Para limpar também o bloqueio por IP, passe --ip <endereco>:
//   node scripts/unlock-admin.js gigi --ip 203.0.113.7
// Para limpar TODOS os bloqueios (todos os usuários e IPs): node scripts/unlock-admin.js --all
const sql = require('../api/_lib/db');

(async () => {
  const args = process.argv.slice(2);
  const ipIdx = args.indexOf('--ip');
  const ip = ipIdx >= 0 ? args[ipIdx + 1] : null;
  if (args.includes('--all')) {
    const rows = await sql.query('delete from login_attempts returning id');
    console.log(`Tentativas apagadas: ${rows.length}`);
    return;
  }
  const username = (args.find((a, i) => !a.startsWith('--') && (ipIdx < 0 || i !== ipIdx + 1)) || '').trim().toLowerCase();
  if (!username && !ip) {
    console.error('Informe o usuário: node scripts/unlock-admin.js <usuario> [--ip <endereco>] | --all');
    process.exitCode = 1;
    return;
  }
  let total = 0;
  if (username) total += (await sql.query('delete from login_attempts where username = $1 returning id', [username])).length;
  if (ip) total += (await sql.query('delete from login_attempts where ip = $1 returning id', [ip])).length;
  await sql.query(`insert into admin_audit (username, action, detail) values ($1, 'unlock_cli', $2)`,
    [username || null, `tentativas apagadas: ${total}${ip ? ' (ip informado)' : ''}`]);
  console.log(`Tentativas apagadas: ${total}`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
