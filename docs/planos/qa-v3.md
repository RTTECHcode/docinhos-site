# QA v3 (A6): W, D, P, L

Base rodada 1: ajustes-v3 (b73af4d). Rodada 2: dc46511 (design A5 V1-V7 e correção do B1). Banco dev, porta 3360.
Telas: 360x740, 390x844 (toque), 844x390 (deitado) e 1366x800. Screenshots em C:\Users\menez\AppData\Local\gigi-tools\ (prefixo `<largura>-v3-a6-*.png`; scripts `v3-a6-*.js`).

## 1. Testes automáticos (scripts/test-*.js, um por vez)

| Script | Resultado | Última linha |
|---|---|---|
| test-admin.js | passou | 64 passaram, 0 falharam |
| test-admin-painel.js | passou | 35 passaram, 0 falharam |
| test-auth.js | passou | 10 testes passaram |
| test-customer.js | passou | 12 passaram, 0 falharam |
| test-customer-api.js | passou | 39 testes ok. Sobras ZZ-a10: clientes=0, pedidos=0. |
| test-mp-webhook.js | passou | mp-webhook: handler ok |
| test-order-handler.js | passou | 30 testes passaram (1ª rodada estourou meu limite de 280 s, sem falha; refeito sem limite) |
| test-order-limits.js | passou | 11 testes passaram |
| test-order-pricing.js | passou | 37 testes passaram |
| test-payments.js | passou | test-payments: 9 testes passaram |
| test-qa-points.js | passou | test-qa-points: todos os testes passaram |
| test-rate-limits.js | passou | 9 testes passaram |
| test-store-hours.js | passou | 21 testes passaram |
| test-v3-backend.js | passou | 25 testes passaram |

Total: 14 de 14 scripts passaram, 0 falhas. Confirmado: test-order-handler.js e test-admin*.js só falhavam antes por concorrência; rodando sozinhos passam. test-order-handler leva mais de 5 min com o banco remoto (não é bug).

## 2. Checklist por ID

| ID | Resultado | Evidência | Nota |
|---|---|---|---|
| W1 | fora do escopo de QA dev | diagnóstico em produção | segredo da Vercel difere do MP (relato A1) |
| W2 | passou | test-mp-webhook.js (segredo com espaço/quebra, motivo do 401 sem segredo, IPN) | correção de código ok; variável da Vercel é passo do Renan |
| W3 | passou | test-payments.js: checkOrderPayment, order-status pendente vira approved, limite, painel payment_check (9 testes) | mesma validação do webhook; moeda, valor e pontos cobertos |
| W4 | passou | navegador 360/390/1366: Pix "Pague com Pix" vira "Pagamento confirmado" sozinho; cartão volta com ?pagamento=ok e confirma | order-status moqueado |
| W5 | fora do escopo de QA dev | correção de DG-7747 e DG-5401 em produção | só com aprovação do Renan |
| W6 | passou | test-mp-webhook.js e test-payments.js | cobrem W2 e W3 |
| D1 | passou | test-v3-backend (D1) e API ao vivo: 401 sem login; customer_id no corpo ignorado; inválido 400 | só o dono lê e edita |
| D2 | passou | API ao vivo: visitante `{logged_in:false}`; logado traz nome, telefone, endereço | no-store coberto no teste |
| D3 | passou | API ao vivo: CEP real 200 e repetido do cache; "123" dá 400; test-v3 cobre 404, 503, limite 30/10 min | 1 consulta real ao ViaCEP |
| D4 | passou | API ao vivo: preço do cliente ignorado (2 x R$ 20 = 40 pontos); 31 itens "itens demais"; vazio "vazio" | funciona para visitante |
| D5 | passou | cardápio devolve unavailable:true (3 complementos no Copão); test-v3: pedido recusa pausado | |
| D6 | passou | cardápio sem pauseLabel; test-v3 D6 | colunas mantidas |
| D7 | passou | cardápio do dev tem "Para família"; migração idempotente no test-v3 | produção ainda precisa rodar a migração |
| D8 | passou | test-store-hours (21) e test-v3; ao vivo: lista vazia dá no_hours e loja fechada; dia sem horário fechado | hoje é quarta, só segunda cadastrada: fechada |
| P1 | passou | 3 larguras: seção "Horários e fechamento da loja" tem Fechar loja e Editar horários; fechar 30 min e reabrir pela tela | opções 30 min, 1 h, Personalizado, Até eu reabrir |
| P2 | passou | 3 larguras: começa com 5 linhas e "Ver mais (45)"; expande para 50 e vira "Recolher" | fica na aba Conta, não em Ajustes |
| P3 | passou | 3 larguras: cards de pedido só com Aceitar, Conferir pagamento, WhatsApp, Cancelar; nenhum botão de voltar | |
| P4 | passou | sem a palavra "etiqueta" nos Ajustes (3 larguras) | grep: nenhuma etiqueta em public/admin/*.js (editor incluso) |
| P5 | passou | 3 larguras: apagar 7 faixas dá 6 avisos "Sem horário, a loja fica fechada nesse dia" e 1 "Sem nenhum horário..." | cancelar sem salvar não muda o servidor |
| P6 | passou | 5 cards pendentes com "Conferir pagamento" (3 larguras); API payment_check coberta em test-payments | clique real não testado: MP é placeholder |
| L1 | passou | 3 larguras: 2, 3, 2, 1; no 1 vira lixeira com "Remover do carrinho?"; Manter mantém; Remover esvazia | |
| L2 | passou | 3 larguras: frase em negrito na retirada | |
| L3 | passou | 3 larguras (moque): CEP preenche rua, bairro, cidade, editáveis; 404 avisa sem travar; 503 manda preencher à mão | também na conta |
| L4 | passou | 3 larguras, logado: nome, telefone, CEP, rua, número, bairro, cidade vêm preenchidos e editáveis | |
| L5 | passou | 3 larguras: cadastro pela tela grava endereço; editar número em Meus dados salva | |
| L6 | passou | visitante "Entre na sua conta e ganhe 20 pontos..." com botão; volta ao checkout com carrinho e dados; logado "Este pedido vai gerar..." | |
| L7 | passou | 3 larguras: complementos pausados com selo "Indisponível", input desabilitado, clique forçado não marca | screenshot 360-v3-a6-L7-pausado.png |
| L8 | passou | mesmos testes do W4 nas 3 larguras | |
| V1 | passou | carrinho vazio com arte do brigadeiro, svg 200 (4 telas); veja V2/V3/V5 | |
| V2 | passou | faixa "Volto logo" cruza o card, card desabilitado, clique não abre modal (4 telas, moque de /api/menu) | |
| V3 | passou | "Para família" com brigadeiro no chip, no título e na lista de categorias (4 telas) | |
| V4 | passou | 20 adições, 3 botões flutuantes nos 4 tamanhos, visitante e logado; ver cenário 3 | |
| V5 | passou | botão "Acompanhe" (arco "acompanhe", contagem 2), lista com 2 pedidos, 1 pedido abre direto, some quando concluído | |
| V6 | passou | topo de 56 px em uma linha, sem rolagem lateral, alvos de 44 px; selo "Aberta" abaixo de 380 px; "Criar conta" na aba Entrar; aviso no topo | |
| V7 | passou | L1, L2, L6, L7 e conta com endereço sem regressão (360, 390, 1366); prints `*-v3-a6-V*.png` | |

## 3. Cenários do plano

| Cenário | Resultado | Evidência |
|---|---|---|
| Pix aprovado, tela muda sozinha | passou | W4 (moque de /api/order-status, 3 larguras) |
| Cartão aprovado, volta do cartão | passou | W4/L8 |
| Webhook ausente, conferência de reserva salva status | passou | test-payments.js (order-status e payment_check gravam approved) |
| Visitante e logado no checkout | passou | L4, L6 |
| CEP válido e inválido | passou | L3 (moque) e D3 (1 consulta real) |
| Apagar todos os horários: loja fecha, aviso no admin | passou | D8 e P5; aviso "Nenhum horário cadastrado: a loja fica fechada o tempo todo..." nas Ajustes (360 e 1366); horários RESTAURADOS (7 faixas) |
| Fechar loja com prazo e reabrir | passou | P1 pela tela e pela API (30 min, até reabrir, manual vence o horário) |
| Complemento pausado | passou | L7 |
| Carrinho com − e remover | passou | L1 |
| 20 adições com os 3 botões flutuantes | passou | 8 combinações (4 telas x visitante e logado): 20 adições seguidas, 3 ciclos de abrir/fechar carrinho, categorias, Acompanhe e produto (botão X, Esc, fundo), rolagem 0 a fim e de volta, giro 390x844 <-> 844x390 e 360x740 <-> 740x360; botões visíveis, clicáveis, dentro da tela e sem sobreposição; contador 20; aviso no topo não cobre os botões; sem erro de JS |

### Rodada 2: reexecução e regressão

| Item | Resultado | Evidência |
|---|---|---|
| test-order-pricing | passou | 37 testes |
| test-order-limits | passou | 11 testes |
| test-customer-api | passou | 39 testes ok, sem sobras ZZ |
| test-v3-backend | passou | 25 testes |
| L1, L2, L6, L7, L3, L4, L8, W4 | passou | 360, 390, 1366; L2 agora é testado pela classe `.pickup-notice` em negrito (o texto saiu do `<strong>`) |
| Conta com endereço (L3, L5, L6 voltar ao checkout) | passou | 360, 390, 1366 |

## 4. Ressalvas da revisão A1 (commit 1cdb19b)

| Ressalva | Resultado | Evidência |
|---|---|---|
| Cadastro com endereço em um só INSERT | resolvida | código (colunas de endereço no INSERT, sem saveAddress depois); test-v3 D1 "mesmo insert"; endereço inválido não cria conta |
| Teto global do ViaCEP | resolvida | cep_lookup_global 60/min só em chamada externa; test-v3 D3 (503, cache passa); CEP inexistente em cache por 1 dia |
| Limite por IP no points_preview | resolvida | 120 em 10 min, 429; test-v3 D4 |
| Mensagem acima de 30 itens | resolvida | ao vivo: "O carrinho tem itens demais (máximo 30)." |
| Dados pessoais só do próprio cliente | resolvida | conta vem da sessão; corpo com customer_id ignorado; prefill e address 401/visitante |
| Nada de PII em log | resolvida, com 1 ressalva | api/customer.js loga só código; log do servidor vazio na rodada; ver bug B1 |

## 5. Bugs

| # | Severidade | Descrição | Causa provável e passos |
|---|---|---|---|
| B1 | Baixo | CORRIGIDO na rodada 2: api/order.js:506-517 loga só código e mensagem com e-mail e 4+ dígitos mascarados (confirmado lendo o código) | Resolvido. |

Sem bugs Críticos, Altos ou Médios na rodada 2. Nenhum bug novo.

## 6. Limites e pendências

- Giro testado por troca de viewport no Edge, não em aparelho real. Faixa "Volto logo" testada com moque de /api/menu (produto pausado fictício).
- Pagamento sempre moqueado (Mercado Pago do dev é placeholder). Clique real em "Conferir pagamento" não testado.
- Atividade recente fica na aba Conta; o plano dizia "em Ajustes". Só uma divergência de texto.
- D7 e a migração dos horários/categoria ainda precisam rodar em produção (lista do A0).
- Dados ZZ apagados (clientes, admin). Horários do dev conferidos: 7 faixas, loja aberta. Servidor da porta 3360 encerrado.
