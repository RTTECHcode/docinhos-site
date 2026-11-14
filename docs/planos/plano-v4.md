# Plano da rodada v4 — Docinhos da Gigi

Base: branch `v4` (criada da `main`, bff189f). Sub-branches por agente em `.claude/worktrees/v4-<agente>`.
Auditoria: `docs/planos/auditoria-v4-a1.md` (segurança, arquitetura, operação) e `docs/planos/auditoria-v4-a5.md` (UX, acessibilidade, performance, SEO). Contrato da API: `docs/planos/api-contrato.md` (seção 10, v4).

Regras que valem para todos os agentes:
- Nada de push, merge na main, deploy, escrita no banco de produção ou leitura de `.env`. Só `.env.dev` via `scripts/dev-env.js`.
- Migração nova, aditiva e idempotente em `scripts/migrate-2026-11-12-v4-*.js`, espelhada em `scripts/schema.sql`. Nada de DROP de tabela ou coluna.
- Preço, frete, pontos, cupom e total: só o servidor calcula.
- Limite de 12 funções em `api/` (hoje 9): ação nova entra como `?a=` nos arquivos que já existem; a regra de negócio vai para `api/_lib/`.
- Testes um script por vez (o banco dev é compartilhado). Dados de teste com prefixo `ZZ-`, apagados no fim.
- Portas do servidor local: A1 3401, A2 3402, A3 3403, A4 3404, A5 3405, A6 3406.

## 1. Fases

| Fase | Quem | Entrega |
|---|---|---|
| F0 | A1, A5 | `auditoria-v4.md` (só leitura) |
| F1 | A0 | este plano, com os Críticos e Altos |
| F2 | A2 | correções de backend (seção 2) e base de N1, N3, N4, N5, N6, N8 (seção 3) |
| F3 | A3, A4 | telas do admin e da loja/conta, N1 a N8 |
| F4 | A5 | visual, morango do N7, `/experimental.html`, N9 |
| F5 | A6, A1 | QA completo e revisão de segurança do que mudou |
| F6 | A0 | `relatorio-v4.md` |

## 2. Críticos e Altos da auditoria (entram na F2/F3)

Nenhum Crítico nas duas auditorias. Entram todos os Altos (10) e os Médios/Baixos que tocam o mesmo código da v4 (custam pouco agora e ficam caros depois). O resto fica de backlog nas auditorias.

### 2.1 Altos

| ID | Achado | Quem | O que fazer na v4 |
|---|---|---|---|
| S-01 | Senha fraca do admin e força bruta distribuída | A2 + Renan | A2: em produção (`VERCEL_ENV=production`) recusar login com senha < 8 caracteres (força troca) e criar teto diário por usuário que vale para qualquer IP (50 falhas em 24 h), com aviso em `admin_audit`. Renan: senha do admin já trocada (14 caracteres, maiúscula e símbolo), confirmado em 14/11. |
| O-01 | Sem monitoramento nem alerta | A2 + Renan | A2: `/api/health` (público) responde só `ok` e verificações sim/não: banco, `MERCADOPAGO_ACCESS_TOKEN` e `MERCADOPAGO_WEBHOOK_SECRET` presentes (nunca o valor) e webhook sem 401 nas últimas 24 h; 503 se alguma falhar. O webhook registra cada 401 e cada aviso aceito; o admin ganha `health_detail` (hora do último aviso aceito, quantidade de 401 em 24 h). A3: aviso no painel quando houver 401 recentes. Renan: cadastrar UptimeRobot (ou Better Stack) em `/api/health`. |
| U-01 | Código do Pix se perde ao recarregar ou voltar | A2 + A4 | A2: hoje o Pix não é guardado (`api/order.js:472` só devolve na resposta). Gravar em colunas novas de `orders` (`pix_qr_code`, `pix_qr_base64`, `pix_expires_at`) e `/api/order-status` devolve `pix: { qr_code, qr_code_base64, expires_at }` só enquanto o pagamento estiver pendente e não vencido (mesmo token do pedido). Limpar as colunas quando o pagamento sair de pendente. A4: guardar o último pedido com Pix no aparelho e reabrir a tela de pagamento; bloco "Copiar código Pix" em `pedido.html`; confirmação ao fechar o modal com Pix em aberto. |
| U-02 | Botão "Copiar código Pix" fora da tela | A4 (+A5 visual) | Título "Falta só pagar o Pix", valor em destaque, botão de copiar logo abaixo, QR recolhido em "Pagar por outro aparelho". |
| U-03 | Aviso de loja fechada escondido | A4 (+A5 visual) | Faixa visível no topo do cardápio, no carrinho e no topo do checkout com o horário de reabertura (resolve também X-06). |
| U-04 | Frete só aparece no fim | A4 | Linha no cardápio e no carrinho com as faixas que já vêm em `/api/menu` ("Entrega até 10 km: de R$ 6 a R$ 14. Retirada grátis."). Cálculo por CEP no carrinho fica de backlog. |
| U-05 | Faltam sinais de confiança | A4 + A5 + Renan | A4: rodapé e topo com bairro/cidade, horário de hoje (de `/api/menu`), "Pix e cartão" e Instagram (junto com N7). Textos reais de "Quem somos" e prazo médio dependem do Renan: deixar marcado `CONFIRMAR`. |
| U-06 | Painel não avisa pedido novo | A2 + A3 | Decisão do Renan (14/11): som no PC com a aba aberta é o mínimo, e o admin vira app instalável. A3: som (arquivo em `public/admin/`), vibração e contagem no título da aba ("(1) Pedidos") quando chegar pedido pago; botão "Ativar som" (o navegador exige um toque). A3: admin como PWA (`public/admin/manifest.webmanifest`, service worker com escopo `/admin/`, ícones, instalável no PC e no celular; sem cache de dados de pedido ou de cliente no service worker). A2: Web Push para pedido pago: tabela `admin_push_subscriptions`, ações `push_subscribe`, `push_unsubscribe` e `push_test`, envio ao confirmar o pagamento (webhook e conferência), chaves VAPID em `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` e `VAPID_SUBJECT` (sem as variáveis, o push fica desligado sem erro) e `scripts/gerar-vapid.js` para o Renan gerar as chaves. Pode adicionar a dependência `web-push` no `package.json`. A notificação não traz dado pessoal: só "Pedido DG-1234 pago" e o valor. WhatsApp automático: fica para a v5, via coexistência (CoEx) no número da loja (decisão do Renan, 14/11). |
| P-01 | Logo de 1,7 MB | A5 | Logo 330x330 em WebP (< 30 KB) com `width`/`height`; original fora de `public/`. |
| P-02 | Sem Open Graph | A5 (+A4 nas páginas dele) | `og:*`, `twitter:card` e imagem 1200x630 nas páginas públicas. A URL definitiva ainda não existe: usar `https://docinhos-site.vercel.app` por enquanto, num ponto só fácil de trocar. |

### 2.2 Médios e Baixos que entram (mesmo código da v4)

| ID | Quem | O que fazer |
|---|---|---|
| A-02 | A2 | INSERT do pedido e reservas (pontos, prêmio do Clube, cupom) na mesma transação. Pedido nunca fica gravado sem a reserva. |
| A-07 | A2 | Locks com duas chaves: `pg_advisory_xact_lock(<classe>, id)`, classe 1 = pontos/clube do cliente, 2 = cupom. |
| A-01 | A2 | `scripts/schema.sql` precisa subir em banco vazio (ALTER de `customers` depois do CREATE). |
| A-09 | A2 | Índice para relatórios: `orders(created_at)` parcial `where payment_status = 'approved'`. |
| A-10 | A2 | Cancelar no painel um pedido `approved` grava `reversal` dos pontos ganhos e devolve prêmio/cupom. |
| S-04 | A2 | Toda exportação CSV e consulta de relatório grava em `admin_audit` (usuário, filtros, quantidade de linhas). |
| S-06 | A2 | Exigir `pay.currency_id === 'BRL'`. |
| A-05 | A2 | `SITE_URL` por variável de ambiente, com fallback para `https://docinhos-site.vercel.app` (o Renan vai registrar `docinhosdagigioz.com.br`). |
| U-08, U-09 | A4 | Junto do U-01: quando o pagamento não for gerado, botão "Tentar pagar de novo"/WhatsApp com o código do pedido; `pedido.html` pendente mostra o Pix. |
| U-10 | A4 | "Meus pedidos" com link para acompanhar o pedido. |
| X-01 | A4 | Modais de produto e carrinho com nome acessível (`aria-labelledby`). |

Pendências que só o Renan resolve (não travam os agentes): cadastrar o monitor externo (O-01), concluir o registro do domínio `docinhosdagigioz.com.br` (solicitado em 14/11) e apontar na Vercel (P-02, N9), gerar as chaves VAPID e colocar na Vercel.

## 3. Desenho técnico das demandas

### N1 — Rótulo de status derivado do pagamento
Nenhum valor gravado muda. `api/_lib/orders.js` ganha `displayStatus(row)`, que devolve `{ key, label }`:

| Situação | key | Rótulo para o cliente |
|---|---|---|
| `fulfillment_status = cancelled` | `cancelled` | Cancelado |
| `new` e pagamento `refunded`/`charged_back` | `refunded` | Pagamento estornado |
| `new` e pagamento `rejected`/`cancelled`/`expired` | `payment_failed` | Pagamento não concluído |
| `new` e pagamento não aprovado (demais casos) | `awaiting_payment` | Aguardando pagamento |
| `new` e pagamento `approved` | `received` | Pedido recebido |
| `accepted` | `accepted` | Pedido aceito |
| `preparing` | `preparing` | Em preparo |
| `ready` | `ready` | Pronto |
| `awaiting_delivery` | `awaiting_delivery` | Saiu para entrega (retirada: Pronto para retirada) |
| `completed` | `completed` | Concluído |

A API devolve `status_key` e `status_label` em: `/api/order-status`, lista de pedidos da conta e pedidos do admin. As telas param de montar rótulo por conta própria. No admin, a coluna "Novos" do Kanban vira duas: "Aguardando pagamento" (`awaiting_payment`, `payment_failed`) e "Pagos, aguardando aceite" (`received`).

### N2 — Produto "Volto logo" abre
Só tela (A4). `/api/menu` já manda o produto pausado com `paused: true` e os complementos. O servidor continua recusando o pedido.

### N3 — Clube de pontos por itens
Banco:
- `club_rewards (id, product_id, size_complement_id null, points_cost > 0, max_per_order >= 1 padrão 1, active, starts_at null, ends_at null, sort_order, created_at, updated_at)`.
- `orders.club_points integer not null default 0` (pontos gastos em prêmios neste pedido).
- `loyalty_ledger.kind` aceita três tipos novos: `reward_reserve` (negativo), `reward_release` (positivo), `reward_commit` (0, marcador).

Regras:
- O pedido manda `rewards: [{ reward_id, qty }]`. Exige login. O prêmio entra em `orders.items` com `reward: true`, `reward_id`, `points_cost`, preço 0.
- Prêmio válido: ativo, dentro da vigência, produto ativo, não pausado, categoria ativa, `qty <= max_per_order`. Produto com grupo de escolha obrigatória não pode virar prêmio (o admin recusa no cadastro).
- O subtotal dos itens pagos precisa ser de pelo menos R$ 1,00.
- Reserva atômica igual à atual: trava por cliente (`pg_advisory_xact_lock`) e insert condicionado ao saldo, na mesma transação. Dois resgates simultâneos nunca gastam o mesmo ponto.
- Pagamento aprovado: `reward_commit`. Recusado, cancelado, expirado ou 24 h sem pagar: `reward_release`. Estorno: a linha `reversal` devolve os pontos do prêmio e tira o ganho.
- Ganho: N pontos por R$ 1 pago (editável). Prêmio vale R$ 0, então não gera ponto.
- Regra antiga: `use_points` (desconto em reais) passa a ser recusado em pedido novo (400 `points_discount_ended`). Pedidos em aberto com desconto reservado seguem o fluxo antigo (`redeem_*`), que continua no código. O saldo de cada cliente não muda.
- Bloqueio de 48 h depois de recuperar a conta vale para a troca por prêmio.

API:
- `/api/menu`: `club: { enabled, points_per_real, rewards: [{ id, product_id, name, size_name, image_path, points_cost, max_per_order, available }] }` (público).
- `/api/customer?a=club` (logado): `{ balance, reserved, locked_until, rewards: [... + missing_points, can_redeem] }`.
- Admin: `club_rewards` (GET), `club_reward_save`, `club_reward_toggle` (POST). Sem apagar: desativar.

Prêmios iniciais (padrão do Renan): 2 ou 3 itens baratos, custo perto de 10% de retorno (item de R$ 10 = 100 pontos). A migração de dados cria os prêmios desativados no dev para o Renan revisar e ligar.

### N4 — Fim dos sinônimos
Saem as ações `synonyms`, `synonym_save`, `synonym_delete`, a tela e os testes. A tabela `ingredient_synonyms` fica no banco, sem uso, documentada. A busca da pausa normaliza (minúsculas, sem acento, singular) e procura o termo dentro do nome: "oreo" acha "Biscoito Oreo"; "morangos" acha "Morango". A prévia continua.

### N5 — Relatórios
Só perfil `admin`. Tudo agregado no servidor (`api/_lib/reports.js`).
- `report_customers` (GET `?s=&sort=&dir=&page=`): uma linha por telefone (cliente com conta ou visitante), com nome, telefone, pedidos pagos, total gasto, último pedido, saldo de pontos, consentimento de WhatsApp e situação do mimo.
- `report_sales` (GET `?from=&to=`, dia de São Paulo): bruto (produtos + frete), frete, descontos, líquido (o que foi pago), pedidos pagos, ticket médio, Pix x cartão, entrega x retirada, produtos mais vendidos, por dia da semana, por hora, taxa de não pagos. Só `payment_status = approved` conta como venda.
- `report_customers_csv` e `report_sales_csv`: CSV com BOM UTF-8, separador `;`, células que começam com `= + - @` recebem `'` na frente (contra fórmula maliciosa). Cada exportação grava `relatorio_csv` na auditoria. Nenhum dado pessoal em log.

### N6 — Cupons e disparo por WhatsApp
Banco:
- `coupons (id, code único em maiúsculas, kind percent|fixed, value, min_order_cents, starts_at, expires_at, max_uses, max_uses_per_customer, active, stacks_with_club padrão false, created_by, created_at)`.
- `coupon_redemptions (id, coupon_id, order_id único, customer_id null, phone_key, status reserved|committed|released, created_at)`.
- `orders.coupon_id`, `orders.coupon_code`, `orders.coupon_discount_cents`. `orders.discount_cents` continua sendo o desconto total do pedido.
- `coupon_campaigns (id, coupon_id, audience jsonb, created_by, created_at)` e `coupon_campaign_targets (campaign_id, customer_id, sent_at, sent_by)`.

Regras:
- O pedido manda `coupon_code`. O servidor valida: ativo, vigência, pedido mínimo (subtotal pago), limite total, limite por cliente (por telefone, vale para visitante) e a regra de não acumular com prêmio do Clube.
- Desconto incide só nos produtos, nunca no frete. Total mínimo a pagar: R$ 1,00.
- Uso reservado na criação do pedido (trava por cupom + insert condicionado), confirmado no pagamento aprovado e devolvido se o pagamento falhar ou vencer em 24 h.
- `/api/customer?a=coupon_check` (POST, visitante ou logado, com limite por IP contra adivinhação de código): devolve o desconto para o carrinho.
- Link `/?cupom=CODIGO`: a loja guarda o código e aplica no checkout.
- Disparo: `coupon_audience` monta o público (todos, comprou nos últimos X dias, não compra há X dias, gastou acima de R$ Y), só clientes com consentimento de WhatsApp ativo. `coupon_campaign_create` grava a lista; `coupon_campaign` devolve cada cliente com a mensagem pronta e o link wa.me; `coupon_target_sent` marca "enviado". Tudo auditado.

### N7 — Quem somos e Instagram
Texto oficial enviado pelo Renan em 14/11, usar sem alteração (exceto os emojis):

> **Quem somos**
>
> Nascemos da vontade de transformar pequenos momentos em algo extraordinário: seja aquele mimo no fim do dia, uma sobremesa especial compartilhada com quem a gente ama, um presente cheio de afeto ou o desejo de comer algo delicioso para coroar uma semana cansativa.
>
> Hoje, nos orgulhamos de fazer parte da rotina de tantas pessoas, levando sabor, qualidade e cuidado em cada detalhe.
>
> Estamos ansiosos para adoçar o seu dia também!
> Com carinho,
> Gigi e equipe Docinhos da Gigi [morango] [chocolate]

Os emojis 🍓🍫 do fim saem e viram ilustrações próprias (SVG, com animação leve que respeita `prefers-reduced-motion`): `morango.svg` e `chocolate.svg` (A5). O A4 aplica o texto e as ilustrações em `quem-somos.html` e tira os comentários `CONFIRMAR` que esse texto resolve; morango em `public/images/branding/morango.svg` (A5); botão do Instagram em `quem-somos.html` e no rodapé. `window.INSTAGRAM_URL` em `public/config.js`.

### N8 — Avaliação no Google e mimo
- Ajuste `google_review_url`: sem chave no banco = link padrão; chave vazia = bloco de avaliação desligado. Só `https://`.
- `/api/order-status` devolve `post_payment: { review_url, instagram_url }` SOMENTE com pagamento aprovado e pedido não cancelado. A tela nunca decide sozinha.
- O bloco aparece uma vez por pedido (marcado no navegador ao fechar).
- Banco: `review_gifts (id, phone_key, customer_id null, granted_order_id null, after_order_id, label, granted_by, granted_at, delivered_order_id null, delivered_at null)`, com no máximo um mimo pendente por telefone.
- Admin: `gift_grant` (por pedido ou por telefone, no relatório de clientes) e `gift_cancel`. Pedidos do admin trazem `gift: { label }` quando o telefone tem mimo pendente e o pedido é posterior ao da avaliação. Ao concluir o pedido (manual ou automático), o mimo vira entregue.
- A visão do cliente nunca traz nada do mimo.

### N9 — Benchmarking, domínio e landing
A5: `docs/planos/benchmarking-v4.md`, `/experimental.html` (noindex, sem link, arquivos próprios `experimental.css`/`experimental.js`), recomendação de domínio e melhorias de esforço P.

### N10 — Encomenda com data marcada (pedido do Renan, 14/11)
Banco: `orders.scheduled_for timestamptz null` (null = o quanto antes). Ajustes novos: `scheduling_enabled` (padrão ligado), `scheduling_min_lead_min` (padrão 120), `scheduling_max_days` (padrão 7), `scheduling_slot_capacity` (pedidos por janela de 30 min; 0 = sem limite).

Regras (servidor decide tudo):
- O pedido pode mandar `scheduled_for`. Aceito só se: agendamento ligado, janela de 30 min alinhada, dentro do horário de funcionamento daquele dia (`store_hours`, fuso de São Paulo), pelo menos `scheduling_min_lead_min` à frente, no máximo `scheduling_max_days` à frente e com vaga na janela (conta pedidos não cancelados e não falhos daquela janela, com trava para dois pedidos simultâneos não estourarem a vaga).
- Com a loja fechada agora, o cliente pode agendar para quando ela abrir (resolve a opinião do U-03). Pedido "o quanto antes" com a loja fechada continua recusado.
- Pagamento igual ao de hoje (na hora, Pix ou cartão). Sem mudança em preço, frete, cupom e Clube.
- `/api/store?a=slots&date=AAAA-MM-DD&mode=delivery|pickup` (ou ação equivalente num arquivo existente): devolve as janelas com `available`. `/api/menu` informa `scheduling: { enabled, min_lead_min, max_days }`.
- Admin: pedido agendado traz `scheduled_for` e etiqueta "Agendado: sex 21/11, 15:00-15:30"; filtro "Agendados" e ordenação pela data marcada; o sweep automático (24 h sem pagar, conclusão automática) respeita a data marcada.
- Telas: A4 põe "Quando?" no checkout ("O quanto antes" ou "Agendar": dia e janela); A3 mostra a etiqueta, o filtro e os quatro ajustes em Ajustes.

### N11 — Selo "Mais pedido" e prazo de entrega
- Selo automático: os 3 produtos com mais unidades vendidas (pedidos `approved`, não cancelados) nos últimos 30 dias, com mínimo de 5 unidades cada. `/api/menu` manda `best_seller: true` no produto. Ajuste `best_seller_enabled` (padrão ligado). Calculado no servidor, sem dado pessoal.
- Prazo médio de entrega (Renan, 14/11): 30 a 50 minutos. Ajustes `delivery_eta_min` = 30 e `delivery_eta_max` = 50, devolvidos em `/api/menu`; A4 mostra no topo, no carrinho e no checkout (U-05); A3 permite editar.
- Título da home aprovado (P-13): "Docinhos da Gigi — Doces artesanais em Osasco, peça online". Imagem de compartilhamento aprovada.

## 4. Divisão de arquivos (evita conflito)

| Agente | Pode alterar |
|---|---|
| A2 | `api/**`, `scripts/**`, `docs/planos/api-contrato.md` |
| A3 | `public/admin/**` |
| A4 | `public/app.js`, `public/index.html`, `public/pedido.*`, `public/quem-somos.html`, `public/conta/**`, `public/config.js`, `public/whatsapp.js` |
| A5 | `public/styles.css`, `public/images/branding/**`, `public/experimental.*`, docs de N9 |
| A6 | `scripts/test-*.js` novos, `docs/planos/qa-v4.md` |

CSS novo de A3 vai em `public/admin/admin.css`. CSS novo de A4 vai num bloco marcado no fim de `public/styles.css` ou `public/conta/conta.css`; A5 revisa na F4.
