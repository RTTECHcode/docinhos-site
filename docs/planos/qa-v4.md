# QA v4 (A6): F5

Base: branch v4 em 20e6207 (merge da rodada F3 do A2); depois merge da v4 em 36312ec (A4 extra e revisão do A1, só `public/` e docs).
Worktree v4-a6, banco dev, porta 3406.
Etapa 1: regressão de backend, sem navegador, um script por vez (14 e 15/11). Etapa 2: navegador (15/11), Edge headless, 360x740, 390x844 e 1366x800, um tamanho por execução.
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

Status: ok, falha, parcial ou não testado. A coluna Tela vem da Etapa 2 (seção 4).

| ID | Backend | Tela | Evidência |
|---|---|---|---|
| N1 status único | ok | ok | test-v4-qa-status, test-v4-pedido, test-v4-qa-gaps; tela: kanban com 4 colunas e os pedidos ZZ na coluna certa (Aguardando pagamento com Pix pendente e pagamento falhou), "Meus pedidos" e pedido.html com `status_label` |
| N2 "Volto logo" abre | ok (servidor recusa pausado) | parcial | faixa "Volto logo" aparece no produto pausado do dev (print home-1366). Abrir o produto pausado não foi testado no navegador |
| N3 Clube por itens | ok | ok | checkout logado: prêmio ZZ (60 pontos) para marcar, pedido manda só `rewards [{reward_id, qty}]`, item grátis no resumo; pedido real reservou 60 pontos (saldo 200 para 140); conta mostra saldo e prêmio; painel lista o prêmio |
| N4 fim dos sinônimos | ok | não testado | fora do roteiro da Etapa 2 (backend coberto) |
| N5 relatórios | ok | ok | painel: Vendas e Clientes abrem nos 3 tamanhos (prints filtrados para linhas ZZ) |
| N6 cupons | ok | ok | ZZV4A6 aplicado pelo servidor (R$ 0,80 de R$ 8,00); código inválido mostra erro; com prêmio do Clube o cupom é recusado ("não pode ser usado junto"); pedido real gravou desconto 80 e total 720; painel lista o cupom |
| N7 Quem somos | não se aplica | ok (ver A6-02) | texto oficial sem `CONFIRMAR`, morango e chocolate carregados; botão do Instagram fica escondido com `INSTAGRAM_URL` vazio e aparece com config.js moqueado |
| N8 avaliação e mimo | ok | ok | painel 1366: "Cliente avaliou: dar mimo" no pedido pago antigo; pedido pago novo do mesmo telefone (criado no meio do teste) chega com "Mimo: 1 brigadeirinho" no card e "Mimo para entregar" / "Cancelar mimo" no detalhe; celular mostra o selo na aba Pagos |
| N9 benchmarking | não se aplica | ok (A5) | prints "depois" do A5 (seção 4) |
| N10 encomenda com data | ok | ok | checkout: "Agendar", 8 dias, janela escolhida, pedido manda `scheduled_for`; pedido real gravado com data; painel: selo "Agendado: ..." no card, filtro Agendados, resumo e edição dos 4 ajustes (sem salvar) |
| N11 Mais pedido e prazo | ok | ok | selo "Mais pedido" no card ZZ pelo caminho real (1 pedido ZZ pago com 6 un.); número de selos na tela = `best_seller` do `/api/menu`; "chega em 30 a 50 min" no topo; ajustes de prazo e selo no painel |
| retry_payment | ok | ok | pedido.html `?t=` e `?o=` com pagamento falhou: "Gerar novo pagamento" manda `{t}` ou `{o}` + `payment_choice` (moqueado) e mostra o Pix novo com Copiar; pedido real sem pagamento (MP placeholder) mostra o bloco "Gerar novo pagamento" e WhatsApp |
| U-01 Pix reabre | ok | ok | `?o=` logada: o Pix guardado do pedido ZZ volta (real); `?o=` sem sessão pede para entrar |
| U-02 a U-05 | não se aplica | ok (U-03 parcial) | U-02: "Falta só pagar o Pix", Copiar na primeira tela nos 3 tamanhos; U-04: frete no topo e no carrinho; U-05: faixa de confiança; U-03: loja aberta esconde a faixa (loja fechada não testada: regra de não fechar a loja do dev) |
| U-06 aviso de pedido | ok (push) | ok | "Ativar som" vira "Som ligado"; título "(3) Pedidos pagos" sobe sozinho para "(4)" quando um pedido pago ZZ entra (refresh de 30 s) e o card novo fica destacado |
| S-01 senha e teto | ok | não testado | admin ZZ sem senha fraca; aviso de senha fraca fora do roteiro |
| O-01 health | ok | ok | `health_detail` moqueado com `unauthorized_24h: 3`: faixa "O Mercado Pago tentou avisar pagamentos e foi recusado..." no topo do painel |
| P-01, P-02 | não se aplica | ok (A5) | prints "depois" do A5 |
| A-02, A-07, A-10, S-04, S-06 | ok | - | test-v4-pedido, test-v4-admin, test-v4-qa-gaps |

Sem erro de console em nenhuma tela (loja, pedido.html, Quem somos, conta e painel), nos 3 tamanhos.

## 3. Achados

| ID | Severidade | Responsável | Achado |
|---|---|---|---|
| A6-01 | Baixo (processo) | Orquestrador / A2 | Outro agente rodou testes de banco junto com os meus (`test-admin.js` de outro worktree). A loja do dev ficou fechada por alguns segundos e 4 casos do test-v4-pedido deram 503 `store_closed`. Repetido sozinho: passou. Não é bug de código. |
| A6-02 | Baixo | A4 (+ Renan) | Instagram em dois lugares. O campo do painel (`settings.instagram_url`, Ajustes > Avaliação no Google) só alimenta o bloco depois do pagamento. Quem somos e rodapé leem `window.INSTAGRAM_URL` de `public/config.js`, vazio no repo, e o botão fica escondido. Quem preencher só o painel não vê o botão em Quem somos. Sugestão: uma fonte só, ou avisar no painel que o rodapé usa o config.js. |
| A6-03 | Baixo (UX) | A3 | No kanban, o card em "Aguardando pagamento" tem "Aceitar" como botão principal (vermelho), acima de "Conferir pagamento". Existe confirmação (`confirmUnpaid`), mas o destaque convida a aceitar pedido não pago. Sugestão: "Conferir pagamento" como principal nessa coluna. |
| A6-04 | Baixo (visual) | A3 / A5 | Painel em 360: o texto da busca dos pedidos aparece cortado ("Buscar por código ou n") ao lado do botão de som. |
| A6-05 | Info | A3 | O botão de som só troca o texto depois que `audio.play()` termina; numa execução levou mais de 800 ms sem retorno visual. |
| A6-06 | Info | - | O dev não tem venda paga nos últimos 30 dias, então o selo "Mais pedido" nunca aparece no dev. Testado com 1 pedido ZZ pago de 6 un. (apagado). Com horário 00:00-23:59, a primeira janela agendada é 00:00-00:30: efeito do ajuste do dev. A observação anterior "Hoje (14/11)" no print do A5 veio do contexto moqueado: no fluxo real de 15/11 o 2º dia é "Amanhã (16/11)". |
| A6-07 | Info | - | Depois de 3 execuções seguidas, o `coupon_check` respondeu "Muitas tentativas de cupom" (limite funcionando). Zerei só os `rate_hits` locais (127.0.0.1) antes de repetir. |

Sobre `retry_payment`, a corrida entre o novo pagamento e o aviso atrasado do Pix antigo já está registrada pelo A1 (F5-S-02 Médio e F5-S-03 Baixo, `docs/planos/seguranca-v4-f5.md`). Não repeti aqui.

## 4. Prints e execução da Etapa 2

Pasta: `C:\Users\menez\AppData\Local\gigi-tools\`. Scripts: `v4-a6-setup.js` (dados ZZ-v4-a6 no dev e limpeza), `v4-a6-loja.js`, `v4-a6-painel.js`. Resultado de cada execução em `v4-a6-loja-result-<vw>.json` e `v4-a6-painel-result-<vw>.json`.

| Bloco | 360 | 390 | 1366 |
|---|---|---|---|
| Loja: visitante, pedido.html `?t=`/`?o=`, Quem somos, cliente logada | 38/38 | 38/38 (modo real: pedidos de verdade no dev, MP placeholder) | 38/38 |
| Painel admin | 21/21 | 21/21 | 19/19, mais 23/24 no modo "novo" (mimo e título). A falha foi no passo Ajustes, por erro do script. Corrigi o script e repeti. |

Moques com `page.route`: frete e CEP, POST `/api/order` (só nos tamanhos sem "real"), `?a=retry_payment`, `/api/order-status` no `?t=` falso, `health_detail`, `config.js` (Instagram). No painel, as respostas `orders`, `order_history`, `report_customers`, `coupon_audience`, `coupon_campaign`, `review_gifts` e `audit` são filtradas no navegador para só linhas ZZ (o dev é cópia da produção). Ações que mudam ajuste ou fecham a loja ficam bloqueadas no script.

Prints da loja (`v4-a6-loja-<passo>-<vw>.png`, 47): home, selo-mais-pedido, carrinho, checkout-cupom, checkout-quando, pix, pedido-falhou, pedido-pix-novo, pedido-o-sem-login, quem-somos, conta-pedidos, conta-pontos, pedido-o-pix, pedido-o-novo-pix, checkout-clube; no 390 também pedido-real-sem-pagamento e pedido-real-clube.

Prints do painel (`v4-a6-painel-<passo>-<vw>.png`, 41): login, kanban, kanban-a-pagar e kanban-pagos (celular), agendados, clube, cupons, relatorio-vendas, relatorio-clientes, ajustes-resumo, ajustes-editar, ajustes-vitrine, cardapio; no 1366 também pedido-detalhe, mimo-registrado, mimo-pedido-novo e mimo-detalhe.

Prints "depois" do A5 (execução separada, servidor da v4-a6 na porta 3405): `v4-a5-f4b.js depois all skip` e `depois all audit`, 62 arquivos `v4-a5-f4b-depois-*-{360,390,1366}.png`, auditoria em `v4-a5-tmp/f4b-audit-depois-all.json`. Comparado com o "antes": alvos pequenos de 4 para 0, foco sem contorno de 3 para 0, nenhum estouro horizontal. Só sobra 1 contraste baixo, o texto em curva "acompanhe" (SVG `textPath`) do checkout, 3,94:1, que já existia no "antes".

Fim da Etapa 2: `v4-a6-setup.js clean` sem sobras (pedidos, clientes, produtos, admin e cupons ZZ-v4-a6 = 0; nenhuma sessão órfã; mimos ZZ = 0). Ajustes, horários (00:00-23:59) e estado da loja iguais ao snapshot. Servidor 3406 encerrado, nenhum Edge aberto. Sobras do A5 (2 pedidos e 1 cliente `ZZ-a5` de 13/11) não são minhas e ficaram.

## Regressão final (F7)

Branch v4-a6b (de v4 d406bc7), servidor na porta 3406, dados ZZ-v4-a6 (apagados no fim, sobras 0). Execução em 16/11.

### Testes (`npm test -- --continuar`)

24 testes. 23 passaram na primeira rodada. 1 falhou: `test-admin`, caso "vínculo: vincular com max_quantity e grupo..." (linha 508). Repetido sozinho: falhou de novo (não é intermitente).

Causa: teste velho. A mudança A6-02 (Instagram vindo da API) fez `/api/menu` devolver `settings.instagram_url`, e o teste comparava a lista exata de chaves sem ela. Não é bug do código. Corrigi o teste (`instagram_url` na lista). `test-admin` sozinho: 64 passaram, 0 falharam. O `test-qa-points` marcou 137364 s no resumo porque a sessão ficou suspensa entre as rodadas, não é lentidão do teste. Nenhum teste apontava para o caminho antigo dos `migrate-*`.

### Fumaça no navegador (360x740 e 1366x800, validada pelo DOM e console; 27/27 verificações em cada tamanho)

| Item | Resultado |
|---|---|
| Preço do cardápio | Fredoka 600 |
| Títulos (h2, nome no modal) | Bagel Fat One. O nome do doce no card da lista usa Manrope 800 por desenho do CSS |
| Fontes | carregadas do próprio site; 0 requisições a fonts.googleapis/gstatic |
| CSP | 0 violações (o dev-server aplica a CSP do netlify.toml); 0 erros de console |
| Modal do produto | rodapé sticky com botão visível; total em Fredoka 600 |
| Carrinho e checkout até o Pix (MP moqueado) | ok; o pedido não envia preço, total, desconto nem frete |
| pedido.html `?t=` e `?o=` | `?t=` mostra status e itens; `?o=` sem sessão pede login |
| Quem somos | ilustrações carregam; Instagram some com settings vazio e aparece quando `/api/menu` traz a URL (moque) |
| 404.html, robots.txt, sitemap.xml | ok (`/404.html` renderiza; robots `text/plain`; sitemap `application/xml`) |
| Painel | login ZZ, kanban com 4 colunas, som liga, "Enquadrar foto" abre (zoom pelo teclado) e Cancelar fecha sem enviar, relatório de vendas |
| CSV de vendas | BOM UTF-8 (ef bb bf) e cabeçalho `"Dia";"Pedidos pagos";"Bruto (R$)";"Frete (R$)";"Descontos (R$)";"Líquido (R$)"` |

Dados de clientes reais foram filtrados no navegador (só linhas ZZ). Ações que gravam ajuste, fecham a loja ou enviam foto ficaram bloqueadas no script. Scripts: `v4-a6-f7.js`, resultados em `v4-a6-f7-result-{360,1366}.json` (pasta gigi-tools).

### Achados

| ID | Severidade | Responsável | Achado |
|---|---|---|---|
| F7-01 | Baixo (teste) | A6 | Teste velho de `/api/menu` sem `instagram_url`. Corrigido em `scripts/test-admin.js`. |
| F7-02 | Info | - | O `scripts/dev-server.js` não serve `404.html` em rota inexistente (devolve "Not found"). Em produção a Vercel/Netlify servem a página. Só afeta quem testa 404 local. |
| F7-03 | Info | - | O snapshot de settings/horários/estado foi comparado no fim: iguais, nada para restaurar. |

Nenhuma falha Crítica, Alta ou Média.

PRONTO PARA PREVIEW: sim
