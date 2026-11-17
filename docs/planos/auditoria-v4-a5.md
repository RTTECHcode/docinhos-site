# Auditoria v4 - A5: UX, conversão, acessibilidade, performance e SEO

Rodada v4, Fase 0 (só leitura). Autor: agente A5. Datas dos testes: 12 e 13/11/2026.

Nada no código foi alterado e nenhum commit foi criado. Este arquivo é o único criado no repositório.

## Como ler este relatório

- **FATO** = algo que eu medi, li no código ou reproduzi na tela. Vem com arquivo e linha, ou com o passo a passo e o print.
- **OPINIÃO** = recomendação minha de UX. Está marcada assim para você poder discordar.
- **Severidade**: Crítico (impede comprar ou pagar, ou quebra a tela em celular comum), Alto (perda relevante de vendas, barreira de acessibilidade que impede concluir, ou falha que prejudica o lançamento), Médio (atrito ou inconsistência), Baixo (polimento).
- **Esforço**: P (até cerca de 1 hora), M (algumas horas), G (um dia ou mais).
- A identidade visual aprovada (marca, cores, tipografia) foi respeitada: nenhuma sugestão pede para trocá-la.

### Onde e como testei

| Item | Detalhe |
|---|---|
| Site local | `http://localhost:3405` (servidor de desenvolvimento, banco de desenvolvimento) |
| Produção | `https://docinhos-site.vercel.app`, somente leitura (GET) |
| Telas | 360x740, 390x844, 320x568 (reflow), desktop 1366x800 e 683x400 (equivale a zoom de 200%) |
| Perfis | visitante e cliente logado |
| Admin | somente leitura do código em `public/admin/*` (sem login) |
| Prints | `C:\Users\menez\AppData\Local\gigi-tools\v4-a5-*.jpg` (fora do repositório) |
| Relatórios Lighthouse | `C:\Users\menez\AppData\Local\gigi-tools\v4-a5-lh-prod-*.json` |

### Limites desta auditoria (leia antes das tabelas)

1. **Pix real não foi testado.** O Mercado Pago do ambiente de desenvolvimento é um placeholder: todo pedido de teste terminou em "Não foi possível gerar o pagamento agora". A tela do Pix foi avaliada pela leitura do código e por uma **simulação no navegador** (forcei a caixa do Pix a aparecer para medir o layout). Onde o achado depende disso, está escrito.
2. **Loja fechada foi simulada no navegador** (troquei a resposta de `/api/menu` só na minha aba). O banco não foi tocado.
3. **Lighthouse em localhost não mede a rede real**: o servidor local não comprime arquivos, força `no-store` e não tem a CDN da Vercel. Por isso as notas de desempenho deste relatório vêm da **produção**. Mesmo assim, o Lighthouse usa uma rede 4G lenta simulada e um processador 4 vezes mais lento: é uma estimativa de celular modesto, não a experiência de todo cliente.
4. **Nenhum teste em iPhone ou Android de verdade.** Tudo foi feito no Chrome com emulação de celular. Dois achados (U-01 e U-11) pedem conferência em aparelho real.
5. O admin não foi aberto (sem senha): os achados do painel vêm só do código.

### Dados de teste que eu criei (banco de desenvolvimento)

| O quê | Identificação |
|---|---|
| Conta de cliente | nome "ZZ-a5 Cliente Teste", telefone (11) 90000-5055 |
| Pedido de visitante | DG-5131, nome "ZZ-a5 Visitante Teste", entrega, R$ 32,00, sem pagamento |
| Pedido de cliente logado | DG-5862, conta "ZZ-a5 Cliente Teste", retirada, R$ 18,00, sem pagamento |

Podem ser apagados quando quiser. Nada foi criado em produção.

---

## 1. Resumo

### Contagem por severidade

| Área | Crítico | Alto | Médio | Baixo | Total |
|---|---|---|---|---|---|
| UX/UI e conversão (U) | 0 | 6 | 11 | 9 | 26 |
| Acessibilidade (X) | 0 | 0 | 6 | 6 | 12 |
| Performance e SEO (P) | 0 | 2 | 7 | 5 | 14 |
| **Total** | **0** | **8** | **24** | **20** | **52** |

Não encontrei nenhum Crítico: no fluxo testado dá para montar o pedido, preencher e enviar em 360 px sem tela quebrada. O achado U-01 (código do Pix se perde se a tela fechar) é o mais perto de Crítico; classifiquei como Alto porque não consegui reproduzir com Pix real. Se o teste em aparelho real confirmar, ele sobe para Crítico.

### Notas do Lighthouse

Produção, Lighthouse 12, celular, rede 4G lenta simulada:

| Página | Desempenho | Acessibilidade | Boas práticas | SEO | LCP | CLS | Peso | Requisições |
|---|---|---|---|---|---|---|---|---|
| `/` (home) | 48 | 100 | 100 | 100 | 11,3 s | 0,455 | 2.768 KiB | 32 |
| `/pedido.html` (sem código de pedido) | 71 | 100 | 100 | 63 | 11,0 s | 0 | 1.794 KiB | 10 |
| `/quem-somos.html` | 71 | 100 | 100 | 100 | 10,9 s | 0 | 1.792 KiB | 9 |
| `/conta/` (tela de entrar) | 91 | 100 | 100 | 63 | 2,8 s | 0 | 1.805 KiB | 11 |

Observações:

- A home foi medida duas vezes. A primeira deu Desempenho 24, com aviso do próprio Lighthouse de que o meu computador estava lento naquele momento. A segunda, sem aviso, deu 48. Uso 48 como referência; LCP e CLS ficaram iguais nas duas.
- SEO 63 em `/pedido.html` e `/conta/` é esperado e correto: essas páginas têm `noindex` de propósito.
- LCP é o tempo até o maior conteúdo aparecer (bom: até 2,5 s). CLS mede o quanto a página "pula" enquanto carrega (bom: até 0,1; ruim: acima de 0,25).
- Na minha conexão (sem simulação de rede lenta), o LCP observado na home de produção foi de 2,1 s.
- Local (ferramenta do Chrome, home, celular): Acessibilidade 100, Boas práticas 100, SEO 100; LCP 2,66 s e CLS 0,47 no rastreamento de desempenho. Valem só como conferência, pelo limite 3 acima.
- Nota 100 de acessibilidade no Lighthouse não significa "sem problemas": o teste automático cobre uma parte pequena. Os achados X-01 a X-12 vieram de teste manual.

### Tempo até o primeiro pedido

Medido como visitante novo, no celular (360x740), produto simples, entrega, Pix:

- **5 telas**: cardápio, produto, carrinho, checkout, pagamento.
- **6 toques em botões + 4 campos digitados** (nome, WhatsApp, CEP e número; rua, bairro e cidade vêm sozinhos do CEP).
- **Esperas medidas no ambiente local**: de 4 a 10 s para o frete aparecer na primeira cotação e de 4,1 a 4,4 s entre tocar em "Enviar pedido" e ver a resposta.
- **Estimativa (OPINIÃO)**: de 1,5 a 2,5 minutos para quem digita em ritmo normal. Com o "Monte seu copo" somam-se pelo menos 2 escolhas obrigatórias e cerca de 3 telas de rolagem.
- Retirada: 2 campos (nome e WhatsApp). Cliente logado com retirada: nenhum campo.

O detalhe por etapa está na seção 4.

### Os 5 achados principais

1. **U-01**: o código do Pix não fica guardado; se a cliente fechar a tela, voltar ou a página recarregar, não há como ver o código de novo e o pedido fica sem pagar.
2. **P-01**: a logo pesa 1,7 MB (2048 px para aparecer com 110 px) e sozinha é de 63% a 97% do peso de cada página; o maior conteúdo leva cerca de 11 s para aparecer em 4G lento.
3. **P-02**: o site não tem Open Graph; o link colado no WhatsApp ou no Instagram aparece sem imagem.
4. **U-03**: com a loja fechada, a cliente só descobre no fim do checkout, depois de montar o carrinho e preencher tudo.
5. **U-04**: o frete (R$ 6, R$ 9 ou R$ 14) só aparece depois de digitar o endereço no checkout; no meu teste foi R$ 14 sobre um pedido de R$ 18.

---

## 2. Achados por área

### 2.1 UX/UI e conversão

| ID | Área | Severidade | Evidência (arquivo:linha ou passo a passo, com print) | Impacto no cliente ou no negócio | Correção sugerida | Esforço |
|---|---|---|---|---|---|---|
| U-01 | Pagamento Pix | Alto | FATO (código): ao registrar o pedido, só o pagamento por cartão é guardado no aparelho (`public/app.js:1471-1472` grava `paymentUrl` apenas quando é cartão). Não existe código que reabra a tela do Pix ao carregar a página (`public/app.js:1514` só apaga pedido vencido). A página de acompanhamento não mostra o Pix (`public/pedido.js` não tem QR nem código; `api/order-status.js` não devolve esses dados). Não há confirmação ao fechar a tela (nenhum `confirm` ou `beforeunload` em `app.js`). O botão Voltar do celular fecha o modal. O carrinho é esvaziado ao registrar. Não reproduzido com Pix real (limite 1). | Quem sai para o app do banco e encontra a página recarregada (comum no navegador interno do Instagram), ou toca em Voltar sem querer, perde o código. Fica um pedido "aguardando pagamento" sem como pagar, e é preciso montar o carrinho de novo. É venda perdida na última etapa, e ainda sobra um pedido fantasma no painel. | Guardar o Pix (código, QR e validade) junto do último pedido e reabrir a tela de pagamento enquanto estiver válido; mostrar o mesmo bloco "Copiar código Pix" em `pedido.html` quando o pagamento estiver pendente; pedir confirmação ao fechar a tela com Pix em aberto. Testar no iPhone dentro do Instagram antes de lançar. | M |
| U-02 | Pagamento Pix | Alto | FATO (simulado, limite 1): em 360x740 o botão "Copiar código Pix" fica a 924 px do topo, com 740 px de tela, ou seja, fora da primeira visão. Antes dele vêm código do pedido, texto, resumo, link, instrução e um QR de 220 px (`public/index.html:140-161`). O título da tela continua "Pedido registrado" (`public/app.js:1510`). Print: `v4-a5-10-pix-simulado.jpg`. | No celular a cliente não consegue ler o QR da própria tela: o que ela precisa é copiar o código. Com o botão escondido e o título dizendo "registrado", parte das pessoas entende que acabou e não paga. | Trocar o título para algo como "Falta só pagar o Pix"; subir o botão "Copiar código Pix" para o topo, logo abaixo do valor; deixar o QR depois (ou recolhido em "Pagar por outro aparelho"); mostrar o valor a pagar em destaque. | P |
| U-03 | Loja fechada | Alto | FATO (simulado, limite 2): com a loja fechada, a home mostra só o selo "Fechada". A mensagem com o horário de reabertura está apenas no atributo `title` (`public/app.js:666`), que não aparece no toque. A cliente adiciona ao carrinho, abre o checkout e só a 1.315 px de rolagem lê "Estamos fechados no momento. Abrimos amanhã (14/11) às 10:00..." com o botão "Enviar pedido" desabilitado (`public/index.html:136-137`). Print: `v4-a5-13-loja-fechada-checkout.jpg`. | A cliente gasta 1 a 2 minutos e descobre no fim que não pode comprar. Gera frustração e a sensação de site quebrado. Quem chega pelo Instagram à noite é exatamente esse caso. | Mostrar uma faixa visível no topo do cardápio: "Estamos fechados. Abrimos amanhã às 10:00. Você pode montar o carrinho e finalizar quando abrirmos." Repetir o aviso no carrinho e no topo do checkout. OPINIÃO: avaliar aceitar pedido agendado para a abertura. | P |
| U-04 | Frete | Alto | FATO: as faixas (até 3 km R$ 6, até 6 km R$ 9, até 10 km R$ 14, limite 10 km) vêm em `/api/menu`, mas não aparecem em nenhum lugar antes do checkout. O valor só surge depois de CEP e número (`public/index.html:118-119`; texto em `public/app.js:882`). No teste: CEP 06010-067, frete de R$ 14,00 sobre pedido de R$ 18,00 (78%). Print: `v4-a5-06-checkout-fim-360.jpg`. | Frete surpresa no fim é uma das causas mais comuns de abandono de carrinho. A cliente já digitou 4 campos quando descobre o valor. Quem mora fora dos 10 km só descobre nesse ponto. | Mostrar no cardápio e no carrinho uma linha simples: "Entrega em Osasco e região (até 10 km): de R$ 6 a R$ 14. Retirada grátis." OPINIÃO: permitir calcular o frete pelo CEP já no carrinho. | M |
| U-05 | Confiança | Alto | FATO: antes do checkout o site não mostra endereço, bairro, horário de funcionamento, área de entrega, prazo médio nem formas de pagamento. `public/quem-somos.html:28-40` tem texto genérico e quatro comentários `CONFIRMAR` pedindo história da loja, região, endereço e horários. O rodapé só tem nome, slogan e 2 links (`public/index.html:38-43`). | Para quem chega pela primeira vez pelo Instagram, faltam os sinais básicos de que a loja existe e entrega: onde fica, quando abre, quanto demora. Sem isso, parte das pessoas volta para o WhatsApp para perguntar, ou desiste. | Preencher "Quem somos" com texto real (pendência para a Gigi). No rodapé e no topo do cardápio: bairro e cidade, horário de hoje, "Pix e cartão", prazo médio. Link para o Instagram. | P (depende de conteúdo do dono) |
| U-06 | Painel (admin) | Alto | FATO (código): o painel busca pedidos novos a cada 30 s e só avisa com um aviso de texto de 2,8 s ("Chegou um pedido novo."). A busca para quando a aba não está visível (`public/admin/admin-orders.js:269-272`, condição `document.hidden`). Não há som, vibração, notificação do sistema nem mudança no título da aba (nenhuma ocorrência de `Audio`, `Notification`, `vibrate` ou `document.title` em `public/admin/*.js`). O único outro aviso é o botão opcional "Enviar pedido no WhatsApp" que a cliente vê depois de pagar. | Se a Gigi estiver com o celular bloqueado, em outro app ou em outra aba, um pedido pago pode ficar sem ser visto. A cliente paga e não recebe. É risco operacional direto no lançamento. | Curto prazo: som e vibração quando chega pedido novo, e contagem no título da aba ("(1) Pedidos"). Melhor: aviso para a Gigi fora do painel (mensagem automática ou notificação push). Registrar como decisão do dono qual canal usar. | M |
| U-07 | Checkout | Médio | FATO: com endereço fora da área (CEP 01310-100, número 1000) aparece "Esse endereço fica fora da nossa área de entrega (até 10 km). Você pode escolher retirada." Ao tocar em "Enviar pedido", o botão mostra "Enviando..." por cerca de 1,2 s e volta ao normal, sem mensagem, sem rolagem e sem foco. O aviso fica uns 700 px acima do botão. Causa: `public/app.js:1415-1432` retorna em silêncio quando a cotação falha. | A cliente toca várias vezes e nada acontece. Parece defeito do site. | Quando a cotação falhar no envio: mostrar aviso curto ("Não entregamos nesse endereço. Escolha retirada ou confira o CEP.") e rolar até a caixa do frete, com foco nela. Oferecer um botão "Mudar para retirada". | P |
| U-08 | Pagamento | Médio | FATO: quando o pagamento não é gerado, a tela mostra "Pedido registrado! Não foi possível gerar o pagamento agora. Fale com a Gigi pelo WhatsApp para combinar o pagamento." (`public/app.js:1221`), sem botão para tentar de novo. O pedido já foi criado e o carrinho esvaziado. Vi isso em todos os testes por causa do placeholder do dev (limite 1); em produção só ocorreria numa falha do Mercado Pago. Print: `v4-a5-07-pedido-registrado-falha-mp.jpg`. | Numa instabilidade do Mercado Pago, todo pedido vira conversa manual no WhatsApp e fica um pedido sem pagamento no painel. | Botão "Tentar gerar o pagamento de novo" para o mesmo pedido; só depois de nova falha, oferecer o WhatsApp já com o código do pedido na mensagem. | M |
| U-09 | Acompanhamento | Médio | FATO: `pedido.html` do pedido DG-5131 mostra "Aguardando a confirmação do pagamento. Esta tela muda sozinha quando for aprovado." (`public/pedido.js:92`), embora nenhum pagamento tenha sido gerado. Mostra também "Situação atual: novo." (`public/pedido.js:81`). A página não lista itens, endereço ou retirada, nem previsão, nem como pagar. Print: `v4-a5-08-pedido-html.jpg`. | A cliente fica esperando uma confirmação que nunca virá. "Novo" é palavra do painel, não diz nada para ela. Sem itens e endereço, não dá para conferir o pedido. | Diferenciar "pagamento pendente" (com botão para pagar, ver U-01) de "pagamento não gerado". Trocar "novo" por "Recebido, aguardando a loja aceitar". Mostrar itens, entrega ou retirada, e previsão. | M |
| U-10 | Conta | Médio | FATO: em "Meus pedidos" o cartão do pedido DG-5862 mostra código, etiqueta "novo", data, itens, total e pagamento, mas sem link de acompanhamento, sem "Pedir de novo" e sem ação de pagar. O link depende de um dado que o servidor não envia (`public/conta/conta.js:346-347`, com o comentário "hoje os pedidos guardam só o hash do token"). Print: `v4-a5-11-meus-pedidos.jpg`. | Ter conta não ajuda a cliente a acompanhar nem a repetir o pedido, que seriam os dois motivos práticos para criar conta. Perde-se a recompra fácil. | Enviar o link de acompanhamento para pedidos da conta; adicionar "Pedir de novo" (recoloca os itens no carrinho). Trocar a etiqueta "novo" por texto de cliente. | M |
| U-11 | Checkout | Médio | FATO: os campos do checkout têm letra de 14,08 px (herdam `.88rem` do rótulo: `public/styles.css:461` e `:468`). Na conta, os campos têm 16 px. O Safari do iPhone dá zoom automático em campo com letra menor que 16 px. Não reproduzido em iPhone real (limite 4). | No iPhone a tela "pula" e amplia a cada campo tocado, e a cliente precisa reduzir o zoom para ver o resto. Atrito justamente no formulário. | Definir `font-size: 16px` (1rem) nos campos e seletores do checkout. Não muda a tipografia aprovada, só o tamanho dentro do campo. | P |
| U-12 | Produto | Médio | FATO: no "Copão da Felicidade - Monte seu copo", em 360x740, o conteúdo do modal tem 2.012 px para 646 px visíveis (cerca de 3 telas). O total e o botão "Adicionar ao carrinho" ficam só no fim, sem rodapé fixo. Print: `v4-a5-02-modal-monte-seu-copo-360.jpg`. | A cliente escolhe as opções sem ver o preço mudando nem o botão de concluir; precisa rolar até o fim para descobrir. | Rodapé fixo no modal com o total atualizado e o botão "Adicionar - R$ X". OPINIÃO: mostrar no rodapé o que falta ("Falta escolher 1 brigadeiro"). | M |
| U-13 | Primeira tela | Médio | FATO: o único botão do topo é "Pedir pelo WhatsApp", que tira a pessoa do site (`public/index.html:28-31`). Em 360x740 o topo ocupa até cerca de 449 px e o primeiro produto começa em 593 px: só o topo do primeiro card aparece na primeira tela. Print: `v4-a5-01-home-360.jpg`. | O site existe para receber o pedido sem conversa, mas o chamado principal manda para a conversa. Quem não rola não vê produto. | Tornar principal um botão "Ver cardápio" (rola até os produtos) e deixar o WhatsApp como secundário. OPINIÃO: reduzir a altura do topo no celular para caber um produto inteiro na primeira tela. | P |
| U-14 | Conta | Médio | FATO: o cadastro tem 16 campos visíveis, 7 obrigatórios (nome, telefone, senha, repetir senha, pergunta de segurança, resposta, e o formulário ainda mostra e-mail, aniversário, 6 de endereço e consentimento), em 2.292 px de página (3,1 telas) (`public/conta/index.html:56-136`). | O checkout convida "Entre na sua conta e ganhe 18 pontos". Quem aceita encontra um formulário longo e pode não voltar ao pedido. | Cadastro em 2 passos: primeiro só nome, telefone e senha; endereço, aniversário e e-mail depois ("complete para ganhar mais"). OPINIÃO: oferecer criar conta depois do pagamento, aproveitando os dados já digitados. | M |
| U-15 | Erro | Médio | FATO: se o cardápio não carrega, aparece só o texto "Cardápio indisponível no momento." (`public/app.js:214`), sem botão de tentar de novo nem saída pelo WhatsApp perto da mensagem. Reproduzido forçando erro 500 na minha aba. Print: `v4-a5-12-erro-cardapio.jpg`. | Numa falha rápida do servidor, a cliente vê uma página vazia e vai embora. | Botão "Tentar de novo" e, logo abaixo, "Pedir pelo WhatsApp". Uma nova tentativa automática após alguns segundos. | P |
| U-16 | Carrinho | Médio | FATO: o botão flutuante do carrinho mostra só ícone e número (`public/index.html:50-53`), sem valor. Junto com o botão "Categorias", ele cobre o preço e o botão "+" do card que está no pé da tela. Print: `v4-a5-03-home-fab-carrinho-360.jpg`. | A cliente não vê quanto já somou e, às vezes, precisa rolar para alcançar o "+" do produto. | Trocar por uma barra no pé da tela: "Ver carrinho - 2 itens - R$ 36,00", e dar espaço no fim da lista para a barra não cobrir o último card. | P |
| U-17 | Retirada | Médio | FATO: ao escolher Retirada aparece "Retire em: Manoel Hare Peralta, 101" (`public/index.html:121`; valor padrão em `api/menu.js:30`), sem "Rua", bairro, cidade, link de mapa nem horário. | Quem não conhece a loja não sabe onde é nem até que horas pode buscar. | Endereço completo, link "Abrir no mapa" e horário de retirada de hoje. | P |
| U-18 | Textos | Baixo | FATO: o botão do carrinho diz "Finalizar pedido", o título do checkout repete "Finalizar pedido" e o botão final diz "Enviar pedido" (`public/index.html:89`, `:97`, `:137`). O frete aparece como "Distância: 7,1 km · faixa até 10 km · Frete: R$ 14,00" (`public/app.js:882`). O erro de grupo diz `Escolha pelo menos 1 em "Escolha o brigadeiro" para continuar.` | "Enviar pedido" não avisa que o passo seguinte é pagar. "Faixa" é termo interno. | Carrinho: "Continuar". Botão final: "Ir para o pagamento". Frete: "Entrega: R$ 14,00 (7,1 km)". Erro: "Escolha 1 brigadeiro para continuar." | P |
| U-19 | Formulário | Baixo | FATO: nenhum campo do checkout indica o que é obrigatório ou opcional (`public/index.html:99-122`). O placeholder do complemento aparece cortado em 360 px ("Apto, bloco, referên"). O campo Número abre teclado só de números (`:111`), o que dificulta "s/n" ou "12A". O WhatsApp não tem máscara. | Pequenos tropeços no preenchimento. | Marcar "(opcional)" em Complemento e Observações; placeholder curto ("Apto, bloco"); Número com teclado de texto; máscara simples no telefone. | P |
| U-20 | Cardápio | Baixo | FATO: 33 produtos em cerca de 6.700 px (uns 9 telas em 360x740), sem busca. Há botão "Categorias" e faixa de categorias. | Achar um doce específico exige rolar bastante. Com 33 itens ainda é tolerável. | OPINIÃO: campo de busca simples no topo do cardápio quando o catálogo crescer. Padronizar nomes e completar as descrições que faltam. | M |
| U-21 | Checkout | Baixo | FATO: se o frete ainda não foi calculado para o endereço atual, o primeiro toque em "Enviar pedido" só calcula e pede um segundo toque ("Confira o frete no resumo e toque em Enviar pedido de novo.", `public/app.js:1430`). | Um toque a mais. É um cuidado compreensível, mas confunde quem esperava enviar. | Manter a conferência, mas rolar até o resumo e destacar o valor do frete quando isso acontecer. | P |
| U-22 | Carrinho | Baixo | FATO: os itens do carrinho não têm foto; o botão de remover usa o emoji 🗑 como ícone (`public/app.js:560`); não há "Continuar comprando" (só o X). Print: `v4-a5-04-carrinho-360.jpg`. | Polimento. O emoji muda de aparência em cada celular e destoa dos ícones desenhados do resto do site. | Miniatura do produto, ícone de lixeira em SVG no mesmo traço dos outros, link "Adicionar mais itens". | P |
| U-23 | Navegação | Baixo | FATO: com pedidos recentes, aparecem ao mesmo tempo o ícone "Pedidos recentes (2)" no topo e o botão flutuante "acompanhe 2". No fim da página o botão flutuante cobre o link "Privacidade" do rodapé. Print: `v4-a5-12-erro-cardapio.jpg`. | Dois caminhos para a mesma coisa e um link coberto. | Manter um só indicador; dar margem inferior ao rodapé. | P |
| U-24 | Conta | Baixo | FATO: em "Meus dados", nome, telefone, e-mail e aniversário são só leitura (as ações de `public/conta/conta.js` são `address_save`, `address_clear`, `consent` e `password`; não há ação para alterar perfil). A política diz que a cliente pode "Corrigir dados errados" (`public/privacidade.html:73`). | Para corrigir um nome ou e-mail é preciso chamar no WhatsApp. | Permitir editar nome, e-mail e aniversário; ou escrever na tela "Para corrigir, fale com a gente no WhatsApp". | M |
| U-25 | Painel (admin) | Baixo | FATO (código): todo erro do painel aparece num aviso que some em 2,8 s (`public/admin/admin.js:50-56`), inclusive mensagens longas, como a de produto sem preço, com cerca de 170 caracteres (`public/admin/admin-product.js:205-207`). O editor de grupo pede "Chave (letras minúsculas, sem espaço)" (`public/admin/admin-product.js:169`). | A Gigi pode não conseguir ler o erro a tempo. "Chave" é termo técnico. | Erros ficam na tela até fechar (ou no mínimo 6 s); gerar a chave sozinho a partir do título. | P |
| U-26 | Conta | Baixo | FATO: login com senha errada mostra "Telefone ou senha incorretos." e mantém a senha digitada no campo. | Polimento: a pessoa precisa apagar a senha para tentar outra. | Limpar e focar o campo da senha após o erro. | P |

#### Oportunidades de conversão (OPINIÃO, sem severidade)

Não são defeitos; são ideias para vender mais, em ordem de retorno esperado:

1. **Atalho depois de adicionar**: o aviso "Adicionado ao carrinho" poderia trazer um botão "Ver carrinho", cortando um toque.
2. **Prova social**: 2 ou 3 depoimentos reais ou "mais pedidos" marcados no cardápio.
3. **Quantidade no modal do produto**: hoje quem quer 3 unidades adiciona 1 e aumenta no carrinho.
4. **Sugestão no carrinho**: "Que tal um geladinho por R$ X?" aumenta o valor médio.
5. **Incentivo de frete**: "Frete grátis acima de R$ X" ou "Retirada grátis" em destaque (decisão comercial do dono).
6. **Pontos mais visíveis para o visitante**: mostrar no cardápio "Ganhe pontos em cada pedido", não só no checkout.

### 2.2 Acessibilidade (WCAG 2.1 AA)

| ID | Área | Severidade | Evidência (arquivo:linha ou passo a passo, com print) | Impacto no cliente ou no negócio | Correção sugerida | Esforço |
|---|---|---|---|---|---|---|
| X-01 | Modais | Médio | FATO: os diálogos de produto e do carrinho não têm nome acessível (`public/index.html:75` e `:83`, sem `aria-labelledby` nem `aria-label`). O do checkout e o de categorias têm (`:66`, `:95`). | Quem usa leitor de tela ouve só "diálogo", sem saber qual abriu (WCAG 4.1.2). | `aria-labelledby` apontando para o título do produto e para "Seu carrinho". | P |
| X-02 | Produto | Médio | FATO: o tamanho escolhido vira um botão desabilitado com "✓" (`public/app.js:429`); o rótulo continua "Escolher Copo 250ml" (`:352`). | O leitor de tela anuncia o tamanho selecionado como "indisponível", o oposto do que ele é (WCAG 4.1.2). | Usar botões de opção (rádio) ou `aria-pressed="true"` no escolhido, sem desabilitar. | P |
| X-03 | Botões | Médio | FATO (Lighthouse, `label-content-name-mismatch`): três botões têm nome acessível diferente do texto visível: "Pedidos recentes (2)" com "2" na tela (`public/index.html:19`, `public/app.js:609`), "Abrir carrinho" com "1" (`public/index.html:50`) e "Acompanhar meus 2 pedidos" com "acompanhe 2" (`public/app.js:782`). O do carrinho não informa a quantidade. | Quem usa comando de voz não consegue acionar pelo texto que vê (WCAG 2.5.3); quem usa leitor de tela não ouve quantos itens há no carrinho. | Incluir o texto visível no nome: "Abrir carrinho, 1 item", "Acompanhe: 2 pedidos". | P |
| X-04 | Teclado | Médio | FATO (desktop 1366x800): não há link "Pular para o cardápio". A ordem de tabulação passa por 33 produtos antes de chegar a "Categorias", "Abrir carrinho" e "Acompanhar" (os botões flutuantes estão no fim do HTML, `public/index.html:45-62`). | Quem navega por teclado precisa de dezenas de toques no Tab para abrir o carrinho (WCAG 2.4.1 e 2.4.3). | Link "Pular para o cardápio" como primeiro elemento; mover o botão do carrinho para o início do HTML (o visual continua igual). | P |
| X-05 | Formulários | Médio | FATO: no cadastro, o erro aparece só na caixa do fim do formulário (`public/conta/conta.js:74-80`). Envio vazio mostra "Informe o seu nome." com o campo cerca de 1.200 px acima; o campo não recebe foco nem `aria-invalid`. A caixa tem `role="alert"` (o leitor de tela anuncia). | Quem usa zoom ou tem baixa visão lê o erro, mas não vê qual campo corrigir (WCAG 3.3.1). | Focar o primeiro campo com problema, marcar `aria-invalid` e mostrar a mensagem junto dele. | P |
| X-06 | Loja fechada | Médio | FATO: a explicação de loja fechada e o horário de reabertura estão só no atributo `title` do selo (`public/app.js:666`; selo em `public/index.html:17`). | `title` não aparece em tela de toque nem é lido de forma confiável por leitores de tela no celular. A informação fica inacessível para todos (ver U-03). | Texto visível na página, como proposto em U-03. | P |
| X-07 | Avisos | Baixo | FATO: a área "Carregando cardápio..." e "Cardápio indisponível no momento." (`public/index.html:35`) não tem `role="status"` nem `aria-live`. | O leitor de tela não avisa que o cardápio falhou (WCAG 4.1.3). | `role="status"` no elemento. | P |
| X-08 | Avisos | Baixo | FATO: em `public/pedido.html:25` a seção inteira do pedido tem `aria-live="polite"`, e dentro dela há outra região viva (`:27`). | Em cada mudança de etapa o leitor pode reler o bloco todo ou anunciar em dobro. | Deixar `aria-live` só na mensagem de situação. | P |
| X-09 | Texto pequeno | Baixo | FATO (medido): "a partir de" com 10,2 px (`public/styles.css:273`); nome da loja no topo com 11,8 px (`:109`); etiquetas com 10,9 a 11,5 px (`:767`, `:601`); "Aguardando o pagamento..." e código Pix com 12,5 px (`:635`); abas do painel com 11 px (`public/admin/admin.css:100`). | Difícil de ler para quem tem vista cansada. Não é reprovação direta da WCAG, pois o zoom funciona. | Mínimo de 12 px em rótulos e 14 px em informações que a cliente precisa ler (preço "a partir de", situação do Pix). | P |
| X-10 | Contraste | Baixo | FATO (medido): nome e descrição de produto pausado com 3,22:1 (`public/styles.css:793`, opacidade .75) e opção indisponível com 2,38:1. Itens inativos são isentos pela WCAG 1.4.3. Todos os textos ativos medidos passam de 4,5:1. | O nome de um doce "Volto logo" ainda interessa à cliente e fica difícil de ler. | Manter o nome com contraste normal e sinalizar a pausa só pela faixa e pela foto esmaecida. | P |
| X-11 | Painel (admin) | Baixo | FATO (código): as janelas do painel (`public/admin/admin.js:124-154`) têm `role="dialog"` e nome, e fecham com o botão Voltar, mas não fecham com Esc, não prendem o foco e não levam o foco para dentro ao abrir (não há tratamento de teclado nem `focus()` nesses trechos). As etapas de pedidos usam `role="tab"` sem painel associado (`public/admin/admin-orders.js:188-191`), e a lista é redesenhada a cada 30 s, o que tira o foco. | Uso por teclado ou leitor de tela no painel fica confuso. Afeta só a equipe. | Reaproveitar a mesma lógica de foco dos modais da loja (que está correta). | M |
| X-12 | Alvos de toque | Baixo | FATO (medido): em "Meus dados", o link "Política de privacidade" tem 220x37 px e a caixa de consentimento 26x26 px (o rótulo em volta tem 44 px de altura). Todos os outros alvos medidos têm 44 px ou mais. | Pequeno risco de toque errado. | Altura mínima de 44 px no link. | P |

### 2.3 Performance e SEO

| ID | Área | Severidade | Evidência (arquivo:linha ou passo a passo, com print) | Impacto no cliente ou no negócio | Correção sugerida | Esforço |
|---|---|---|---|---|---|---|
| P-01 | Imagens | Alto | FATO: `public/images/branding/logo.jpg` tem 1.734.930 bytes e 2048x2048 px, e aparece com 110x110 px em todas as páginas (`public/index.html:25`, `quem-somos.html:18`, `privacidade.html:18`). Em produção é 63% do peso da home (1.736 de 2.768 KiB) e 97% de `quem-somos.html` (1.736 de 1.792 KiB). O Lighthouse estima 1,4 a 1,6 MB de economia e LCP de cerca de 11 s em 4G lento. | Quem abre o link pelo Instagram em 4G gasta dados e espera segundos a mais na primeira visita. É o maior problema de velocidade do site e o mais barato de resolver. | Exportar a logo em 330x330 px (3x a medida exibida) em WebP ou AVIF: deve ficar abaixo de 30 KB. Declarar `width` e `height` na tag. Guardar a original fora de `public/`. | P |
| P-02 | Compartilhamento | Alto | FATO: nenhuma página tem `og:title`, `og:description`, `og:image`, `twitter:card` nem `rel="canonical"` (busca em `public/*.html` e `public/conta/index.html`: zero ocorrências). | O link colado no WhatsApp, no Instagram ou no Facebook aparece sem imagem, só com título e texto. Para uma loja que vive de link compartilhado, é a vitrine do lançamento. | Adicionar Open Graph e Twitter Card nas páginas públicas, com uma imagem de 1200x630 px (logo e um doce, dentro da identidade aprovada) e `canonical`. Precisa da URL definitiva do site (pendência). | P |
| P-03 | Estabilidade | Médio | FATO: CLS de 0,455 na home em produção e 0,47 local (o limite de "ruim" é 0,25). Causa medida: enquanto o cardápio não chega, o rodapé aparece logo abaixo de "Carregando cardápio..."; quando chega, a faixa de categorias ganha altura, o conteúdo desce 44 px e o rodapé é empurrado para fora (`public/index.html:33-43`; `public/styles.css:154` e `:190`). | A página "pula" no primeiro carregamento. É um dos três indicadores que o Google usa para avaliar páginas. | Reservar a altura da faixa de categorias e dar altura mínima de uma tela à área do cardápio (ou mostrar cartões-fantasma enquanto carrega). | P |
| P-04 | Cardápio | Médio | FATO: o cardápio inteiro vem de `/api/menu`, que em produção responde com `Cache-Control: public, max-age=0, must-revalidate` e `X-Vercel-Cache: MISS` (`api/menu.js` não define cache). Nas duas medições levou 0,65 s e 2,0 s. Até lá a página mostra "Carregando cardápio...". O HTML não traz nenhum produto. | Toda visita espera o banco responder antes de ver um doce, e cada visita consulta o banco. Num pico de acessos após um post, isso pesa. Buscadores e prévias que não rodam JavaScript veem um cardápio vazio. | Cache curto na borda para `/api/menu` (por exemplo 30 a 60 s, com `stale-while-revalidate`). Cuidado: a resposta inclui se a loja está aberta; manter o prazo curto ou separar esse dado. | P |
| P-05 | Cache | Médio | FATO: em produção, HTML, CSS, JS, logo, fotos e favicon respondem com `Cache-Control: public, max-age=0, must-revalidate`. `vercel.json:8-65` não define cache para arquivos estáticos. Só `/api/img` tem cache longo (`api/img.js:30`). | Em toda visita o celular volta ao servidor para confirmar cada um dos cerca de 30 arquivos. Não baixa de novo, mas gasta tempo, principalmente em rede ruim. | Em `vercel.json`: cache de 30 dias ou mais para `/images/*` e favicon; para CSS e JS, cache curto com `stale-while-revalidate` ou nome com versão. | P |
| P-06 | Imagens | Médio | FATO: as fotos de produto têm de 668x613 a 1300x1192 px e aparecem com 109x109 px; as maiores pesam de 78 a 103 KB. O painel gera uma única versão com lado maior de 1.000 px (`public/admin/admin-product.js:29-42`). Os atributos dizem `width="88" height="88"` (`public/app.js:299`), diferente do tamanho real. Todas têm `loading="lazy"`, inclusive as da primeira tela. Uma foto antiga (`/api/img?id=21`) é JPEG de 203 KB. | Dados e tempo gastos à toa na lista. As fotos grandes só são úteis no modal do produto. | Gerar também uma miniatura (cerca de 330 px) para o card e usar a grande só no modal; corrigir `width` e `height`; tirar o `lazy` das 3 ou 4 primeiras; reenviar a foto antiga. | M |
| P-07 | Fontes | Médio | FATO: o CSS do Google Fonts é carregado de outro domínio e bloqueia o desenho da página; o Lighthouse estima cerca de 0,9 s de atraso em 4G lento. São 5 pesos de Manrope mais a Bagel Fat One (`public/index.html:9-11`). | Texto demora mais a aparecer na primeira visita. | Hospedar as duas fontes no próprio site (mesmas fontes, nada muda no visual) e pré-carregar as duas principais. Exige incluir `'self'` em `font-src` da CSP (`vercel.json:34`). Avaliar se os 5 pesos são usados. | M |
| P-08 | SEO local | Médio | FATO: não há dados estruturados (JSON-LD) em nenhuma página. Teste feito em produção: um bloco `<script type="application/ld+json">` **não** é bloqueado pela CSP atual (nenhuma violação registrada), enquanto um script comum embutido é bloqueado, como esperado. | O Google não recebe, de forma estruturada, nome, endereço, horário e tipo de negócio. Perde-se chance de aparecer bem em buscas como "doces em Osasco". | Adicionar um bloco JSON-LD do tipo `Bakery` (ou `LocalBusiness`) na home, com nome, endereço, telefone, horários e área atendida. Não precisa mexer na CSP. Depende dos dados reais da loja (U-05). | P |
| P-09 | SEO | Médio | FATO: `/robots.txt` e `/sitemap.xml` devolvem 404 em produção. | O Google rastreia mesmo assim, mas sem orientação. `/admin/` e `/conta/` já têm `noindex` (correto). | Criar `robots.txt` (liberando o site, bloqueando `/admin/` e `/api/`) e `sitemap.xml` com home, quem-somos e privacidade. | P |
| P-10 | Página não encontrada | Baixo | FATO: endereço inexistente devolve texto puro "The page could not be found NOT_FOUND". `/quem-somos` (sem `.html`) também dá 404. | Quem digita ou recebe um link errado cai numa tela em inglês, sem marca e sem caminho de volta. | Criar `public/404.html` com a identidade do site e botão "Ver cardápio"; ligar `cleanUrls` no `vercel.json` (testar os links existentes). | P |
| P-11 | Ícones | Baixo | FATO: não há `manifest.json`, `apple-touch-icon` nem `/favicon.ico` (os três dão 404). Existe `favicon.png` de 192x192 px (26 KB). | Ao salvar o site na tela inicial do iPhone, o ícone vira um recorte da página. | Adicionar `apple-touch-icon` de 180x180 px e um `manifest.json` simples com nome, cor e ícones. | P |
| P-12 | Imagens | Baixo | FATO: a logo (`public/index.html:25`) e a foto do modal (`public/app.js:341`, 1184x1085 px exibida com 210 px) não declaram `width` e `height`. | Risco de pequenos saltos de layout enquanto a imagem carrega. | Declarar as dimensões nas duas tags. | P |
| P-13 | Título | Baixo | FATO: o título da home é "Docinhos da Gigi — Feito para adoçar seu dia" (`public/index.html:6`). A descrição já cita Osasco, produtos e formas de pagamento (`:7`). | OPINIÃO: o título não diz o que é nem onde fica, e é o texto mais forte para a busca. | "Docinhos da Gigi — Doces artesanais em Osasco, peça online". | P |
| P-14 | Arquivos | Baixo | FATO: as fotos têm nomes com espaços, vírgulas e acentos (ex.: `Brigadeiros - Bicho de Pé, Ninho e Chocolate.avif`), que viram endereços longos e codificados. | Não quebra nada hoje; dificulta manutenção e compartilhamento da imagem. | Padronizar nomes em minúsculas com hífens na próxima troca de fotos. | P |

---

## 3. O que foi conferido e está OK

Itens testados que **não** geraram achado:

**Layout e toque**
- Sem rolagem horizontal em 320, 360 e 390 px, na home, no modal, no carrinho, no checkout, em `pedido.html` e na conta. Print: `v4-a5-15-checkout-320.jpg`.
- Zoom de 200% (janela de 683x400): sem rolagem horizontal; o modal rola por dentro e o botão de adicionar é alcançável.
- Alvos de toque com 44 px ou mais em todas as telas da loja (exceções pequenas em X-12).
- Desktop 1366x800 sem quebras. Print: `v4-a5-14-desktop-1366-home.jpg`.

**Acessibilidade**
- Contraste AA em todos os textos ativos medidos (menor valor: 4,72:1).
- Foco visível em todos os elementos (contorno de 2,4 px).
- Modais da loja: o foco fica preso dentro, Esc fecha, o botão Voltar fecha e o foco volta para onde estava.
- `prefers-reduced-motion` respeitado: com a preferência ligada, nenhuma animação roda.
- `lang="pt-BR"`, um H1 por página, H2 por categoria, regiões de cabeçalho, navegação, principal e rodapé.
- Campos do checkout com rótulo visível e `autocomplete` correto; grupos de entrega e pagamento com `fieldset` e `legend`.
- Grupos de opções do produto com `role="group"` e nome; contadores ("0/2") anunciados.
- Avisos de CEP, frete e mensagens rápidas com `role="status"`; erros da conta com `role="alert"`.
- Painel: rótulos em todos os campos lidos, interruptores com `role="switch"`, confirmações antes de ações destrutivas, alvos de 44 px declarados no CSS.

**Fluxo**
- CEP preenche rua, bairro e cidade e leva o foco para o número.
- O frete é calculado sozinho depois do número.
- Endereço fora da área recebe mensagem clara com saída ("Você pode escolher retirada").
- Produto pausado aparece como "Volto logo" e não pode ser adicionado.
- Opção obrigatória não escolhida: erro junto do grupo, aviso e rolagem até ele.
- Produto simples: 2 toques para adicionar; o modal cabe na tela.
- Cliente logado: nome e WhatsApp já vêm preenchidos; pontos explicados com clareza.
- Retirada reduz o formulário a nome, WhatsApp e observações.
- Recuperação de senha funciona e explica o bloqueio de 48 horas dos pontos.
- Após criar conta a partir do checkout, o site volta ao pedido.
- Consentimento de WhatsApp vem desmarcado e é opcional.

**Performance, SEO e segurança de entrega**
- Texto comprimido em produção (Brotli).
- `/api/img` com cache longo e imutável.
- Fotos de produto em AVIF.
- `title` e `description` próprios em cada página; `noindex` em admin, conta e acompanhamento.
- Acessibilidade, Boas práticas e SEO com nota 100 no Lighthouse das páginas indexáveis.
- CSP ativa em produção e compatível com JSON-LD (teste em P-08).

---

## 4. Mapa do fluxo (toques e campos por etapa)

Visitante novo, celular 360x740, produto simples, entrega, Pix.

| # | Etapa | O que a cliente faz | Toques | Campos digitados | Observação |
|---|---|---|---|---|---|
| 1 | Cardápio | rola e toca no produto | 1 | 0 | só o topo do 1º produto aparece na primeira tela (U-13) |
| 2 | Produto | toca em "Adicionar ao carrinho" | 1 | 0 | "Monte seu copo": +2 escolhas obrigatórias e cerca de 3 telas (U-12) |
| 3 | Cardápio | toca no botão flutuante do carrinho | 1 | 0 | o botão não mostra o valor (U-16) |
| 4 | Carrinho | toca em "Finalizar pedido" | 1 | 0 | sem estimativa de frete (U-04) |
| 5 | Checkout | nome, WhatsApp, CEP, número; toca em "Enviar pedido" | 1 | 4 | Entrega e Pix já vêm marcados; rua, bairro e cidade vêm do CEP; painel com 2,5 telas |
| 6 | Pagamento | rola e toca em "Copiar código Pix" | 1 | 0 | botão fora da primeira visão (U-02); depois vai ao app do banco |
| | **Total** | | **6** | **4** | **5 telas** |

Variações medidas:

| Cenário | Toques | Campos |
|---|---|---|
| Visitante, retirada, Pix | 7 (um a mais para marcar "Retirada") | 2 (nome, WhatsApp) |
| Cliente logado, retirada | 7 | 0 |
| Cliente logado, entrega, sem endereço salvo | 6 | 2 (CEP, número) |
| Visitante, "Monte seu copo", entrega | 8 ou mais | 4 |
| Frete ainda não calculado ao enviar | +1 (segundo "Enviar pedido", U-21) | |

Onde dá para cortar (OPINIÃO):

1. **Etapas 3 e 4**: botão "Ver carrinho" no aviso de item adicionado, ou barra fixa com o total (corta 1 toque e mostra o valor).
2. **Etapa 6**: botão de copiar o Pix no topo (corta a rolagem e reduz o risco de a cliente não pagar).
3. **Etapa 1**: botão "Ver cardápio" no topo e topo mais baixo no celular.
4. **Etapa 5**: campos com letra de 16 px (U-11) e frete estimado antes (U-04).

---

## 5. Pendências e dúvidas para o dono

Não fiz perguntas durante a auditoria; ficam registradas aqui:

1. **Conteúdo da loja**: endereço completo de retirada, horários, área atendida, prazo médio de entrega e o texto real de "Quem somos" (U-05, U-17, P-08).
2. **Endereço definitivo do site**: vai continuar em `docinhos-site.vercel.app` ou terá domínio próprio? Open Graph, `canonical` e `sitemap` precisam da URL final (P-02, P-09).
3. **Aviso de pedido novo para a Gigi**: qual canal ela prefere (som no painel, notificação no celular, mensagem automática)? (U-06)
4. **Teste em aparelho real antes do lançamento**: (a) iPhone, dentro do navegador do Instagram: fazer um pedido com Pix de verdade, ir ao app do banco e voltar, para confirmar U-01; (b) iPhone: tocar nos campos do checkout para confirmar o zoom de U-11.
5. **Pix real**: a tela de pagamento não pôde ser vista funcionando (limite 1). Recomendo um pedido real de valor baixo em produção, feito pelo dono, antes de divulgar.
6. **Imagem de compartilhamento** (1200x630 px): precisa ser produzida dentro da identidade aprovada (P-02).
7. **Decisões comerciais** citadas como oportunidade: frete grátis acima de um valor, pedido agendado com a loja fechada, sugestões no carrinho.
8. **Dados de teste** "ZZ-a5" no banco de desenvolvimento (lista no início): apagar quando convier.
