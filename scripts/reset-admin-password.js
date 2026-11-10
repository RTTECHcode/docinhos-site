// Redefine a senha de um usuário do painel /admin (uso LOCAL, nunca por web). Usuário e senha vêm SÓ de
// variáveis de ambiente passadas na linha de comando (nunca grave senhas em arquivos do repositório):
//
//   set -a && . ./.env && set +a
//   ADMIN_USER=nome ADMIN_PASS='nova-senha-forte' node scripts/reset-admin-password.js
//
// Efeitos: troca a senha, apaga os bloqueios de login e de recuperação do usuário, encerra todas as sessões
// e registra a ação em admin_audit. A senha precisa ter pelo menos 8 caracteres (ADMIN_WEAK=1 aceita senha
// curta e marca o aviso fixo no painel, como em create-admin-users.js).
// RESET_SECURITY=1 também zera a pergunta de segurança e apaga os códigos de recuperação: o usuário cadastra
// uma nova pergunta no próximo login e recebe novos códigos.
const sql = require('../api/_lib/db');
const auth = require('../api/_lib/auth');

(async () => {
  const username = String(process.env.ADMIN_USER || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASS || '';
  const weak = process.env.ADMIN_WEAK === '1';
  const resetSecurity = process.env.RESET_SECURITY === '1';
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new Error('ADMIN_USER inválido (3 a 32 caracteres: a-z, 0-9, ponto, hífen, sublinhado).');
  if (!password) throw new Error('Defina ADMIN_PASS na linha de comando.');
  if (!weak) auth.validatePassword(password, 'ADMIN_PASS'); // lança com mensagem clara se for curta
  const user = (await sql.query('select id from admin_users where username = $1', [username]))[0];
  if (!user) throw new Error(`Usuário "${username}" não existe. Para criar, use scripts/create-admin-users.js.`);

  const hash = await auth.hashPassword(password);
  await sql.query('update admin_users set password_hash = $2, weak_password = $3, active = true where id = $1', [user.id, hash, weak]);
  await sql.query('delete from admin_sessions where user_id = $1', [user.id]);
  await sql.query('delete from login_attempts where username = $1', [username]);
  await sql.query('delete from admin_recovery_attempts where username = $1', [username]);
  if (resetSecurity) {
    await sql.query('update admin_users set security_question = null, security_answer_hash = null, security_set_at = null where id = $1', [user.id]);
    await sql.query('delete from admin_recovery_codes where user_id = $1', [user.id]);
  }
  await sql.query(`insert into admin_audit (username, action, detail) values ($1, 'senha_resetada_local', $2)`,
    [username, `weak=${weak} security_reset=${resetSecurity}`]);
  console.log(`Senha de "${username}" redefinida; bloqueios limpos e sessões encerradas${resetSecurity ? '; pergunta e códigos de recuperação zerados' : ''}.`);
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => process.exit());
