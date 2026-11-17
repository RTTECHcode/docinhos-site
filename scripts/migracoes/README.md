# scripts/migracoes

Scripts de uso único. Ficam aqui como histórico; não apague. Todos são aditivos e idempotentes.
Uso no banco de desenvolvimento: `node -r ./scripts/dev-env.js scripts/migracoes/<arquivo>.js`.
Estado final do banco: `scripts/schema.sql`.

## AINDA NÃO RODOU EM PRODUÇÃO

| Script | O que faz |
|---|---|
| `migrate-2026-11-12-v4-schema.js` | Tabelas e colunas da v4 (Clube, cupons, campanhas, presentes, eventos de webhook, `payment_attempt_at`, endereço em `orders`). Rodar ANTES de publicar o código da v4. |

`migrate-2026-11-12-v4-club-seed.js` (prêmios de teste do Clube) é só para o banco de desenvolvimento e recusa rodar fora dele. Nunca rodar em produção.

## Já rodaram em produção (segundo os relatórios)

| Script | O que faz |
|---|---|
| `migrate-2026-11-10-painel-v2.js` | Painel v2 (código curto DG-####, status, etc.). Relatório final: passo 4. |
| `migrate-2026-11-10-scopes.js` | Amplia os escopos de `customer_login_attempts` (login, recover, register). |
| `migrate-2026-11-10-order-attempts.js` | Tabela `order_attempts` (limite de pedidos por IP). |
| `migrate-2026-11-10-v3-schema.js` | Endereço do cliente e `cep_cache` (v3). Confirmado no relatório v3. |
| `migrate-2026-11-10-v3-categoria-familia.js` | Renomeia a categoria para "Para família". Confirmado no relatório v3. |
| `conferir-pagamento.js` | Conferência manual de pagamento no Mercado Pago. O Renan já rodou (F1 W5). Pode ser usado de novo. |

## Sem registro de execução em produção nos documentos

Confira no banco antes de rodar; todos são idempotentes. O estado final deles já está em `scripts/schema.sql`.

| Script | O que faz |
|---|---|
| `migrate.js` | Aplica o `schema.sql` inteiro. |
| `migrate-admin.js` | Tabelas do painel /admin (usuários). |
| `migrate-2026-11-10-rate-limits.js` | Tabela `rate_hits` (limite por IP do acompanhamento e da cotação de frete). |
| `migrate-2026-11-10-public-code-backfill.js` | Preenche `public_code` dos pedidos antigos. |

`seed.js` e `catalog.js` ficaram em `scripts/` (usados por `npm run seed` e por testes).
