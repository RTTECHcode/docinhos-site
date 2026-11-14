# Segurança v4 — F5 (A1)

Revisão de segurança de tudo que mudou na v4: `git diff bff189f..HEAD` na branch `v4-a1`, já com a rodada curta do A2 (merge `20e6207`).
Feita só lendo código. Não houve teste de banco, servidor nem navegador.

Resultado: **nenhum achado Crítico ou Alto**. Os achados abaixo são Médio/Baixo e ficam para os donos do código.

## 1. Achados

| ID | Sev. | Quem | Onde |
|---|---|---|---|
| F5-S-01 | Médio | A2 | `api/_lib/monitor.js:48`, `api/mp-webhook.js:99` |
| F5-S-02 | Médio | A2 | `api/_lib/payments.js:58` (`isSuperseded`) |
| F5-S-03 | Baixo | A2 | `api/order.js:465-494`, `api/_lib/coupons.js:71` |
| F5-S-04 | Baixo | A2 | `api/_lib/push.js:200`, `api/admin.js:982` |
| F5-S-05 | Baixo | A2 | `api/admin.js:963` |
| F5-S-06 | Baixo | A2 (+A3) | `api/admin.js:1446` |
| F5-S-07 | Baixo | A2 | `api/admin.js:474-475` |
| F5-S-08 | Baixo | A2 | `api/customer.js:236` (`coupon_check`) |
| F5-S-09 | Baixo (funcional) | A4 | `public/conta/conta.js:362`, `public/pedido.js:12` |

### F5-S-01 — Qualquer pessoa deixa o `/api/health` vermelho e enche a tabela de eventos (Médio, A2)
- Causa: todo POST sem assinatura válida em `/api/mp-webhook` grava um evento `unauthorized` (`mp-webhook.js:99`), sem limite por IP.
  O health público fica falso enquanto houver um 401 nas últimas 24 h: `checks.webhook_no_401_24h = summary.unauthorized_24h === 0` (`monitor.js:48`).
- Cenário: um robô manda um POST por dia para `/api/mp-webhook`. O monitor externo (O-01) fica vermelho para sempre e o aviso perde o valor.
  Em volume, cada POST vira uma linha nova no banco.
- Correção sugerida:
  1. Limitar a gravação de `unauthorized` por IP (ex.: `hitExceeded` com 5 por 10 min; acima disso responde 401 sem gravar).
  2. Ficar vermelho só se houver 401 em 24 h **e** nenhum aviso aceito depois do último 401 (ou nenhum aceito em 24 h).
     Assim o alarme continua pegando segredo trocado, mas lixo de fora não derruba.

### F5-S-02 — Estorno de pagamento antigo aprovado é ignorado depois do `retry_payment` (Médio, A2)
- Causa: `isSuperseded` só poupa `approved`. Qualquer outro status de pagamento criado antes de `payment_attempt_at` vira `stale`, inclusive `refunded` e `charged_back`.
- Cenário:
  1. Cliente gera Pix P0 e depois pede `retry_payment` (grava `payment_attempt_at`).
  2. Cliente paga o Pix antigo P0 ainda válido. O aviso `approved` passa (approved nunca é ignorado) e o pedido fica pago com P0.
  3. Depois P0 é estornado ou contestado. O aviso `refunded`/`charged_back` de P0 é ignorado (`stale`).
  4. O pedido continua pago, os pontos ganhos e o cupom continuam valendo.
- Correção sugerida: em `isSuperseded`, devolver `false` quando `pay.status` for `refunded` ou `charged_back`, e também quando `String(pay.id) === String(order.payment_id)`.
  Só ignorar `pending/in_process/rejected/cancelled/expired` de um pagamento que não é o atual.
  Incluir no `scripts/test-v4-f3.js` o caso `refunded` com data antiga.

### F5-S-03 — Corrida entre `retry_payment` e o aviso de expiração do Pix antigo (Baixo, A2)
- Causa: `payment_attempt_at` é gravado **depois** da chamada ao Mercado Pago (`order.js:480`/`494`). O comentário em `order.js:467` diz "ANTES", mas o código grava depois.
  Durante a chamada (alguns segundos), o aviso `expired` do Pix antigo ainda não é `stale` e devolve prêmio, pontos e cupom.
  Se o novo pagamento for aprovado, `coupons.onPaymentStatus` faz commit mesmo de uso `released` (`coupons.js:71`). Pode passar do `max_uses` e o saldo de pontos pode ficar negativo.
- Cenário: janela pequena e exige o aviso chegar exatamente durante a chamada, por isso Baixo.
- Correção sugerida (uma das duas):
  1. Gravar `payment_attempt_at = now()` num UPDATE condicional antes de chamar o Mercado Pago (pedido ainda aberto), e só depois os dados do pagamento.
  2. No aviso `approved`, não fazer commit de reserva já `released` (cupom e pontos): registrar em `admin_audit` para a Gigi decidir.

### F5-S-04 — Push de "pedido pago" vai também para usuário desativado (Baixo, A2)
- Causa: `notifyPaid` lê todas as linhas de `admin_push_subscriptions` sem juntar com `admin_users.active` (`push.js:200`).
  `user_toggle` derruba as sessões, mas não apaga as inscrições de push (`admin.js:982-988`).
- Cenário: funcionária desligada continua recebendo no celular o código e o valor de cada pedido pago.
- Correção sugerida: `notifyPaid` com `join admin_users u on u.username = s.username and u.active`; e `user_toggle` com `active=false` apaga as inscrições do usuário.

### F5-S-05 — Auditoria nova com IP aparece para staff (Baixo, A2)
- Causa: `ADMIN_ONLY_AUDIT = ['login_falhou', 'recuperacao_falhou']` (`admin.js:963`) não tem a ação nova `login_senha_curta_bloqueado` (detalhe com IP, `admin.js:474`).
  `login_teto_diario` (`admin.js:411`) não tem IP; incluir é opcional.
- Correção sugerida: incluir `login_senha_curta_bloqueado` na lista.

### F5-S-06 — `health_detail` aberto para staff (Baixo, A2 + A3)
- Causa: `A.health_detail` não tem `role` (`admin.js:1446`). A tarefa pedia "só admin".
- Risco real baixo: devolve só booleanos, datas e contagens, nunca valor de variável.
- Correção sugerida: decidir com o A3. Ou `role: 'admin'` (e o aviso do painel só para admin), ou aceitar o risco e registrar em `decisoes.md`.

### F5-S-07 — Resposta 403 de senha curta confirma que a senha está certa (Baixo, A2)
- Causa: o bloqueio `weak_password_blocked` (`admin.js:475`) só responde depois de a senha conferir. Senha errada recebe outra mensagem.
  O teto por usuário (S-01) limita as tentativas, então o ganho do atacante é pequeno. Também depende de `VERCEL_ENV`, que muda na migração para a Netlify (M3).
- Correção sugerida: responder igual a "senha errada" e avisar a troca só por canal do admin; na M3 trocar `VERCEL_ENV` por variável própria.

### F5-S-08 — `coupon_check` mostra uso por telefone de terceiros (Baixo, A2)
- Causa: visitante sem sessão pode mandar `phone` e descobrir se aquele telefone já usou um cupom com limite por pessoa. Com outro telefone, o limite por pessoa é contornado (limite de desenho).
- O limite de 20 por IP em 10 min (`customer.js:26`) reduz a varredura.
- Correção sugerida: sem sessão, não usar `phone` na prévia (a regra por telefone vale só no pedido); mensagem genérica no pedido.

### F5-S-09 — Links `?o=` não abrem na loja (Baixo, funcional, A4)
- Não é falha de segurança, mas quebra o U-10 e a volta do cartão no retry.
- `customer?a=orders` manda `tracking_url = /pedido.html?o=<id>` (`customer.js:79`).
  `conta.js:362` só aceita `^/pedido\.html\?t=...$` e descarta o link. `pedido.js:12` só lê `t`.
  A volta do cartão do retry também usa `?o=<id>&pagamento=ok`.
- O A4 já está nisso (F3 A4 extra). Para segurança: aceitar só `^/pedido\.html\?o=\d{1,12}$` em `conta.js`; em `pedido.js` chamar `/api/order-status?o=` na mesma origem (cookie de sessão) e montar tudo com `textContent`.

## 2. Situação por ID (tabela 2.2 do plano + S-01 e O-01)

| ID | Situação | Evidência |
|---|---|---|
| S-01 | Resolvido | Teto diário por usuário `USER_DAY_MAX=50`, `evaluateLock` com `daily`, auditoria `login_teto_diario`. Ver F5-S-05 e F5-S-07. |
| O-01 | Resolvido, com ressalva | `/api/health` público só com `{ok, checks}` booleanos e 503 na falha; detalhe só logado. Ressalva: F5-S-01. |
| A-02 | Resolvido | INSERT do pedido condicional e reservas (`reward_reserve`, cupom) no mesmo `sql.transaction`, ligadas por `tracking_token_hash`. |
| A-07 | Resolvido | `pg_advisory_xact_lock(1, cliente)`, `(2, cupom)`, `(3, vaga)`, sempre nessa ordem. |
| A-01 | Resolvido | `scripts/schema.sql`: `create table customers` na linha 137, `alter table customers` a partir da 162. |
| A-09 | Resolvido | `orders_paid_created_idx on orders (created_at) where payment_status = 'approved'` (`schema.sql:409`). |
| A-10 | Resolvido | Cancelar pedido pago: `reverseOrder` + `coupons.releaseForOrder` + `payments.clearPix`. |
| S-04 | Resolvido | Todo `report_*` e `report_*_csv` é admin e grava `admin_audit` com filtros e linhas. CSV com prefixo `'` em `=+-@\t\r`. |
| S-06 | Resolvido | `if (pay.currency_id !== 'BRL')` em `payments.js`. |
| A-05 | Resolvido | `SITE_URL` por variável com padrão `https://docinhos-site.vercel.app`. |
| U-08, U-09 | Feito na loja | "Tentar pagar de novo" + WhatsApp com código (`app.js:1614-1628`); Pix pendente só aparece pelo token ou pela sessão da dona. |
| U-10 | Parcial | Servidor pronto; link `?o=` descartado na loja (F5-S-09, com o A4). |
| X-01 | Feito | Modais com `aria-labelledby` em `index.html` (linhas 94, 103, 111, 125). |

## 3. Rodada curta do A2 (merge 20e6207)

- `retry_payment`: limites 10 por IP e 3 por pedido conferidos. Acesso por `{t}` (hash do token) ou `{o}` com sessão e `customer_id` igual, sem IDOR.
  `retryBlock` cobre pago, cancelado, vencido, em análise, horário passado, reserva devolvida (409 `reservation_released`) e vaga lotada.
  Preço não vem do cliente: refaz os itens do pedido gravado e confere a soma com `total_cents`. Chave de idempotência nova por tentativa.
  Ressalvas: F5-S-02 e F5-S-03.
- Outcome `stale` em `syncPayment`: certo para pendente/recusado antigo; errado para estorno (F5-S-02).
- `tracking_url`: só para pedidos do próprio cliente; o link `?o=` não abre nada sem a sessão da dona. Ver F5-S-09.
- `order-status?o=`: exige sessão e `where id = $1 and customer_id = $2`. Devolve itens só com nome, tamanho, quantidade e prêmio.
  `address_summary` só com bairro e cidade (ou endereço da loja na retirada). Sem telefone, rua ou número.
- `points_save`: usa `loyalty.saveEarnRules`, que ignora `block_*`. Só admin.

## 4. Conferido e sem problema

- SQL: todos os módulos novos de `api/_lib` (club, coupons, gifts, site, scheduling, showcase, push, reports) usam parâmetros. Ordenação de relatório por lista fechada; direção só `asc/desc`.
- Papéis: cupons, prêmios do Clube (gravar), relatórios, configurações de pedido e avaliações (gravar) são só admin. Mimo por pedido é staff; por telefone é admin.
- Preço, desconto, cupom, pontos, mimo e frete calculados só no servidor; `use_points` antigo responde 400 `points_discount_ended`.
- Webhook MP: HMAC mantido, eventos idempotentes, moeda BRL, aprovado não é sobrescrito por outro `payment_id`. S-05 (aceitar sem assinatura fora da produção) segue adiado para a M3.
- Colunas Pix (`pix_qr_*`): lidas só por quem tem o token ou pela sessão da dona, e só enquanto pendente e não vencido.
- Push: inscrição só logado, máximo 10 por usuário; endpoint validado (https, porta 443, sem usuário/senha, só hosts dos serviços de push); `redirect: 'error'` e tempo limite de 5 s, sem SSRF. Teste só para os aparelhos do próprio usuário.
- Front: nenhum `innerHTML` novo com dado; links externos checados com `https://`; base64 do Pix checado por regex; sem código inline.
- `public/admin/sw.js`: sem `fetch` e sem cache; clique do push só abre caminho `/admin/`. Manifest com `scope: /admin/`.
- `experimental.html`: `noindex`, sem código inline, só lê `/api/menu`. Ícones e manifest não expõem nada.
- CSP do `vercel.json` sem mudança e cobrindo manifest, worker e mídia.

## 5. Testes

- Nenhum teste de banco (proibido nesta etapa; a regressão de banco é do A6).
- Nenhum código alterado por este documento.
