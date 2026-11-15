// O-03: anula o IP guardado há mais de 90 dias (retenção mínima, LGPD). Não apaga linha nenhuma: só põe NULL na coluna do IP.
// Idempotente: rodar de novo não muda mais nada (só olha IP ainda preenchido).
// Padrão é --dry-run (só conta, não altera). Para executar de verdade: --aplicar.
//
// Tabelas: orders.client_ip, login_attempts.ip, admin_recovery_attempts.ip, customer_login_attempts.ip,
//          admin_sessions.ip, customer_sessions.ip.
// NÃO mexe em customers.whatsapp_consent_ip nem customer_consent_events.ip: são a prova do consentimento do cliente.
// order_attempts e rate_hits (ip NOT NULL) já são limpas pelas próprias funções da loja (linhas com mais de 1 dia).
//
// Uso (banco de desenvolvimento): node -r ./scripts/dev-env.js scripts/limpar-ip-antigo.js [--aplicar]
// Uso (produção, só com ordem do Renan): carregar a DATABASE_URL de produção e rodar com --aplicar depois de ver o --dry-run.
const sql = require('../api/_lib/db');

const DIAS = 90;
const ALVOS = [
  { tabela: 'orders', coluna: 'client_ip', tempo: 'created_at' },
  { tabela: 'login_attempts', coluna: 'ip', tempo: 'at' },
  { tabela: 'admin_recovery_attempts', coluna: 'ip', tempo: 'at' },
  { tabela: 'customer_login_attempts', coluna: 'ip', tempo: 'at' },
  { tabela: 'admin_sessions', coluna: 'ip', tempo: 'created_at' },
  { tabela: 'customer_sessions', coluna: 'ip', tempo: 'created_at' }
];

(async () => {
  const aplicar = process.argv.includes('--aplicar');
  console.log(aplicar ? `MODO APLICAR: anulando IP com mais de ${DIAS} dias.` : `DRY-RUN: só contando IP com mais de ${DIAS} dias (use --aplicar para executar).`);
  let total = 0;
  for (const { tabela, coluna, tempo } of ALVOS) {
    const onde = `${coluna} is not null and ${tempo} < now() - interval '${DIAS} days'`;
    let n;
    if (aplicar) {
      const r = await sql.query(`update ${tabela} set ${coluna} = null where ${onde} returning 1`);
      n = (r.rows || r).length;
    } else {
      const r = await sql.query(`select count(*)::int as n from ${tabela} where ${onde}`);
      n = (r.rows || r)[0].n;
    }
    total += n;
    console.log(`${tabela}.${coluna}: ${n} ${aplicar ? 'anulado(s)' : 'a anular'}`);
  }
  console.log(`Total: ${total}`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
