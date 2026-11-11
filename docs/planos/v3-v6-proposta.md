# V6: proposta para reorganizar os botões do topo (visitante e logado)

Status: PROPOSTA. Nada disto foi aplicado no site. Aguarda aprovação do Orquestrador/Renan. Autor: A5 (design). Decisões de layout seguem a skill ui-ux-pro-max (alvo de toque mínimo de 44 px, hierarquia de ações, uma ação principal por tela, nada de linhas que quebram sozinhas). Marca (paleta, fontes, logo) não muda.

## 1. Problema hoje (medido em 360 px, com o site real)

| Situação | Altura da faixa do topo | Botões em linhas |
|---|---|---|
| Visitante (com pedido recente) | 94 px | 2 linhas: "Pedidos recentes" sozinho; "Entrar" + "Criar conta" |
| Logado (com pedido recente) | 142 px | 3 linhas: selo da loja; "Pedidos recentes"; "Olá, Maria" + "250 pontos" + "Meus pedidos" |

Causas: cinco ou seis botões do mesmo peso visual, todos com texto longo, quebrando em linhas soltas. O cliente gasta um terço da primeira tela só com a faixa do topo, e o nome da loja/logo desce. Screenshots do estado atual: `gigi-tools/v3-a5-design-v6-360-visit-atual.png` e `...-360-logado-atual.png` (também 390).

## 2. Proposta

Regra geral: a faixa do topo tem UMA linha só (56 px), nos dois casos. Esquerda: selo "Loja aberta/fechada". Direita: no máximo 3 itens, todos de 44 px de altura, em ordem de importância da direita para a esquerda. O que sobra vai para dentro da página de conta (que já tem abas Pedidos, Pontos e Meus dados).

### 2.1 Visitante

```
360 px
+--------------------------------------------------+
| ( o Loja aberta )     [ recibo (1) ]  [ Entrar ] |   faixa de 56 px
+--------------------------------------------------+
```

- "Entrar" é o único botão de texto, em rosa (ação principal).
- "Criar conta" sai do topo: aparece em destaque na tela /conta/ (aba "Entrar" já tem o link) e no convite de pontos do checkout (L6, já existe). Menos uma decisão para o cliente logo na chegada.
- "Pedidos recentes" vira um botão só de ícone (recibo, 44x44, com bolinha de contagem). Só aparece se houver pedido salvo no aparelho. Tem `aria-label="Pedidos recentes"`.

### 2.2 Logado

```
360 px
+--------------------------------------------------+
| ( o Loja aberta )  [recibo] [ * 250 ] [ (M) Maria ] |   faixa de 56 px
+--------------------------------------------------+
```

- Pontos: pílula amarela com o brigadeiro e o saldo ("250"). Toque leva a /conta/#pontos. Em 360 px o texto "pontos" cai (o brigadeiro já diz o que é); em 700 px ou mais volta "250 pontos".
- Conta: pílula com a inicial em círculo rosa + primeiro nome ("Maria"). Toque leva a /conta/#pedidos (a conta tem abas Pedidos, Pontos, Meus dados e Sair). Nome longo é cortado com reticências (máx. 9 caracteres visíveis em 360 px).
- "Meus pedidos" sai do topo (é a própria entrada "Maria") e "Olá," some (a inicial já saúda).
- Pedidos recentes: o mesmo ícone de recibo do visitante. Para logado, o ícone só aparece se houver pedido salvo no aparelho que NÃO esteja na conta (na prática, quase nunca); o histórico completo fica em /conta/#pedidos.

### 2.3 Selo da loja

Em 360 px o texto "Loja aberta" é cortado quando há 3 itens à direita (visto no protótipo). Regra: abaixo de 380 px o selo mostra só "Aberta" / "Fechada" (a bolinha verde/vermelha continua), com o texto completo em `aria-label`. Acima disso, texto completo.

## 3. Botões flutuantes (embaixo)

Já testados na V4/V5 (sem sobreposição em 360x740, 390x844 e 844x390):

```
+------------------------------+
|                              |
|            (página)          |
|                              |
|                  ( Acompanhe)|   72 px, só quando há pedido em andamento
| [ = Categorias ]  [ carrinho 2 ]|   categorias à esquerda, carrinho à direita
+------------------------------+
```

- Esquerda: Categorias. Direita embaixo: carrinho. Direita acima do carrinho: Acompanhe (sobe sozinho quando o carrinho aparece; regra CSS `:has()` já existe).
- Com modal aberto, os três ficam escondidos pelo próprio modal (já é assim).
- Ajuste novo proposto: o aviso "Adicionado ao carrinho" hoje cobre o Acompanhe por ~2 s em 360 px (visto no protótipo). Subir o aviso para logo abaixo do topo da tela (ou limitar a largura dele ao espaço à esquerda do Acompanhe). Não altera lógica, só posição.
- Garantia de 360 px: largura ocupada embaixo = Categorias (~145 px) + carrinho (~100 px) + folgas; o Acompanhe fica em coluna própria acima do carrinho, então nunca divide linha com as Categorias. O teste da V5 (12 itens no carrinho, 3 viewports) continua valendo e será repetido após a V6.

## 4. O que muda em arquivos (quando aprovado)

- `public/index.html`: topo passa a ter só selo + `.topbar-actions` (ícone de recibo, pontos, conta). Sem texto longo.
- `public/app.js`: `renderAccount()` monta os 3 itens novos (DOM com `createElement`/`textContent`, sem `innerHTML` de dados); `#recent-btn` vira botão de ícone; selo curto abaixo de 380 px via CSS (duas variantes do texto no DOM).
- `public/styles.css`: bloco `.topbar` de uma linha (`flex-wrap: nowrap`), `.topbar-btn.icon`, `.topbar-btn.points`, `.topbar-btn.account`. Todos com `min-height: 44px` e `:focus-visible` visível.
- `public/conta/*`: nenhum arquivo novo; só garantir que "Criar conta" aparece bem na aba Entrar e que #pedidos é a aba inicial do logado (já é).

Riscos: (a) o cliente que hoje usa "Criar conta" no topo passa a ver "Entrar" e achar o cadastro na tela seguinte (um toque a mais; mitigado pelo convite de pontos no checkout); (b) ícone sem texto exige `aria-label` e a bolinha de contagem para ficar claro; (c) pontos sem a palavra "pontos" em 360 px: o brigadeiro + número é entendido porque o mesmo ícone aparece no checkout.

## 5. Protótipo

Prototipado só no navegador (nada gravado no site) com `gigi-tools/v3-a5-design-v6proto.js`. Medidas: faixa do topo cai de 94 px para 56 px (visitante) e de 142 px para 56 px (logado) em 360 e 390 px; sem rolagem horizontal. Imagens (em `C:\Users\menez\AppData\Local\gigi-tools\`):

- `v3-a5-design-v6-360-visit-atual.png` x `v3-a5-design-v6-360-visit-proposta.png`
- `v3-a5-design-v6-360-logado-atual.png` x `v3-a5-design-v6-360-logado-proposta.png`
- as mesmas em 390 (`-390-`)
- `v3-a5-design-v6-360-logado-flutuantes.png` e `...-visit-flutuantes.png` (três flutuantes sem sobreposição; mostra o aviso "Adicionado ao carrinho" sobre o Acompanhe)

## 6. Decisões que preciso do Orquestrador/Renan

1. Aprovar tirar "Criar conta" do topo do visitante (fica só "Entrar")? Alternativa: manter os dois, "Entrar" e "Criar conta", em uma linha só, sem o botão de recibo.
2. Aprovar o ícone de recibo no lugar do texto "Pedidos recentes"?
3. Aprovar o selo curto "Aberta/Fechada" abaixo de 380 px?
