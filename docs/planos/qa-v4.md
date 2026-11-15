# QA v4 (A6): F5

Base: branch v4 em 20e6207 (merge da rodada F3 do A2); depois merge da v4 em 36312ec (A4 extra e revisão do A1, só `public/` e docs).
Worktree v4-a6, banco dev, porta 3406.
Etapa 1: regressão de backend, sem navegador, um script por vez (14 e 15/11). Etapa 2: navegador (aguarda liberação).
Logs: `C:\Users\menez\AppData\Local\gigi-tools\v4-a6-logs\<script>.log` e `resumo.txt`.

## 1. Testes automáticos (scripts/test-*.js, um por vez)

| Script | Resultado | Última linha |
|---|---|---|
| test-order-handler.js | passou | 28 testes passaram |
| test-order-limits.js | passou | 11 testes passaram |
| test-payments.js | passou | 9 testes passaram |
| test-qa-points.js | passou | todos os testes passaram |
| test-customer.js | passou | 12 passaram, 0 falharam |
| test-v4-pedido.js | passou na 2ª rodada | 21 passaram, 0 falharam (1ª rodada: 4 falhas por colisão, ver A6-01) |
| test-v4-agenda.js | passou | 20 passaram, 0 falharam |
| test-v4-admin.js | passou | 21 passaram, 0 falharam |
| test-v3-backend.js | passou | 25 testes passaram |
| test-v4-schema.js | passou | Tudo certo |
| test-rate-limits.js | passou | 9 testes passaram |
| test-admin.js | passou | 64 passaram, 0 falharam |
| test-admin-painel.js | passou | 35 passaram, 0 falharam |
| test-auth.js | passou | 10 testes passaram |
| test-customer-api.js | passou | 39 testes ok, sobras 0 |
| test-dev-server-mime.js | passou | 2 passaram, 0 falharam |
| test-mp-webhook.js | passou | handler ok |
| test-order-pricing.js | passou | 37 testes passaram |
| test-store-hours.js | passou | 21 testes passaram |
| test-v4-f3.js | passou | 20 passaram, 0 falharam |
| **test-v4-qa-status.js** (novo, A6) | passou | 4 ok (N1: os 10 `status_key`, retirada, cancelado vence tudo) |
| **test-v4-qa-gaps.js** (novo, A6) | passou | 6 passaram, sobras ZZ-v4-a6 = 0 |

Nenhum teste precisou de correção (nenhuma expectativa velha). Nenhum bug de código achado na Etapa 1.

Testes novos (lacunas que nenhum script cobria):
- `test-v4-qa-status.js` (puro): tabela inteira de `displayStatus` (N1).
- `test-v4-qa-gaps.js` (banco): N3 bloqueio de 48 h na troca por prêmio (423 `points_locked`, `club.locked_until`, `can_redeem` false, pedido sem prêmio passa); N3 cancelar no painel pedido NÃO pago devolve o prêmio (`reward_release`); N3 `club_reward_save` com `required_group`, `size_required` e `invalid_size`; N8 `post_payment` some quando o pedido pago é cancelado.

Banco dev depois da Etapa 1: ajustes, horários (00:00-23:59 todos os dias) e `store_state` iguais ao snapshot tirado antes; `store_paused` = 0; loja aberta. `shipping_bands` e origem não foram tocados. Sobras ZZ de outro agente (não apaguei): 2 pedidos e 1 cliente `ZZ-a5` de 13/11 (A5).

## 2. Checklist por ID

Status: ok, falha ou não testado. "Etapa 2" = depende do navegador.

| ID | Backend | Tela | Evidência |
|---|---|---|---|
| N1 status único | ok | Etapa 2 | test-v4-qa-status (10 chaves), test-v4-pedido (rastreio e conta), test-v4-qa-gaps (cancelado) |
| N2 "Volto logo" abre | ok (servidor recusa pausado) | Etapa 2 | test-v3-backend (cardápio `paused`, pedido recusa) |
| N3 Clube por itens | ok | Etapa 2 | test-v4-pedido (10 pedidos em paralelo, 1 entra; reserva, commit, estorno), test-v4-admin (cadastro), test-v4-qa-gaps (48 h, cancelar, required_group/size_required) |
| N4 fim dos sinônimos | ok | Etapa 2 | test-v4-admin (`textMatches`), test-admin-painel (busca da pausa) |
| N5 relatórios | ok | Etapa 2 | test-v4-admin (report_sales, report_customers, CSV com BOM, `;`, fórmula neutralizada, auditoria) |
| N6 cupons | ok | Etapa 2 | test-v4-pedido (coupon_check, limite por cliente e max_uses em paralelo, liberação), test-v4-admin (cadastro, campanha, enviado) |
| N7 Quem somos | não se aplica | Etapa 2 | só tela |
| N8 avaliação e mimo | ok | Etapa 2 | test-v4-admin (mimo por pedido e telefone, entrega ao concluir, review_settings), test-v4-pedido e test-v4-qa-gaps (`post_payment`) |
| N9 benchmarking | não se aplica | Etapa 2 | só tela/docs (A5) |
| N10 encomenda com data | ok | Etapa 2 | test-v4-agenda (janelas, recusas, loja fechada, 6 em paralelo com vaga 1, sweep) |
| N11 Mais pedido e prazo | ok | Etapa 2 | test-v4-agenda (best_seller, ajuste desligado, delivery_eta no menu) |
| retry_payment | ok | Etapa 2 | test-v4-f3 (Pix/cartão, recusas, limites, `?o=`, aviso antigo `stale`) |
| U-01 Pix reabre | ok | Etapa 2 | test-v4-pedido (Pix volta enquanto pendente, aprovado apaga, vencido não volta) |
| U-02 a U-05 | não se aplica | Etapa 2 | só tela |
| U-06 aviso de pedido | ok (push) | Etapa 2 (som, título) | test-v4-admin (VAPID ausente, inscrição, aviso cifrado, 410) |
| S-01 senha e teto | ok | Etapa 2 | test-v4-admin (403 `weak_password_blocked` em produção, teto de 50 falhas) |
| O-01 health | ok | Etapa 2 | test-v4-admin (`/api/health` sim/não, 401 derruba, `health_detail`) |
| P-01, P-02 | não se aplica | Etapa 2 | só tela (A5) |
| A-02, A-07, A-10, S-04, S-06 | ok | - | test-v4-pedido, test-v4-admin, test-v4-qa-gaps |

## 3. Achados

| ID | Severidade | Responsável | Achado |
|---|---|---|---|
| A6-01 | Baixo (processo) | Orquestrador / A2 | Outro agente rodou testes de banco junto com os meus (`test-admin.js` de outro worktree). A loja do dev ficou fechada por alguns segundos e 4 casos do test-v4-pedido deram 503 `store_closed`. Repetido sozinho: passou. Não é bug de código. |

Sobre `retry_payment`, a corrida entre o novo pagamento e o aviso atrasado do Pix antigo já está registrada pelo A1 (F5-S-02 Médio e F5-S-03 Baixo, `docs/planos/seguranca-v4-f5.md`). Não repeti aqui.

## 4. Prints

Etapa 2 ainda não começou.
