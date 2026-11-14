# Benchmarking, domínio e landing experimental (N9, rodada v4)

Autor: agente A5. Data: 14/11/2026. Faz parte da F4 antecipada (não depende do backend).

## Como ler

- **Esforço**: P (até cerca de 1 hora), M (algumas horas), G (um dia ou mais).
- **Quem**: agente que faria a mudança, pela divisão de arquivos do plano v4 (A2 backend, A3 painel, A4 loja e conta, A5 visual).
- **Limite**: a pesquisa foi feita por busca na web, sem criar conta nem fazer pedido nos sites citados. Os números de outras lojas (pedido mínimo, preços) servem só como referência de mercado e podem ter mudado. Os dados de "boas práticas" vêm em boa parte de blogs de empresas que vendem cardápio digital: estão marcados como tal.
- A identidade visual aprovada (marca, cores, tipografia) não muda em nenhuma recomendação.

## 1. Quem foi observado

| Loja ou plataforma | Como vende | O que chama atenção |
|---|---|---|
| Sodiê Doces (rede) | App e site próprios, além de iFood, Rappi e Anota AI | Separa "Disponível agora" de "Sob encomenda". Promete prazo claro ("pedido até 12h fica pronto em 2 horas"). Mostra o pedido mínimo de cada loja no iFood (R$ 20 a R$ 35). |
| Supreme Brigaderia | Site com domínio próprio (plataforma Cliente Fiel) | Entrega, retirada e programa de fidelidade no mesmo lugar. Itens sob encomenda (bolos, tortas) aparecem só para ver, com pedido pelo WhatsApp. |
| Brigadeiro Delicia (RJ) | Site próprio com botão "Fazer pedido online" | Frete por região escrito na página (R$ 15, R$ 20, R$ 30 por bairro). |
| Confeitaria Helena (RS) | Cardápio no Delivery Direto | Pedido mínimo por produto (ex.: brigadeiro a partir de 10 unidades) e preço por kg para tortas. |
| Santo Brigadeiro, Brigadelicia | Cardápios em Anota AI e Goomer | Formato padrão de mercado: foto, nome, descrição curta, preço, carrinho e pedido que chega no WhatsApp. |
| Meslo, Dora, Rei do Delivery (plataformas) | Cardápio digital para confeitaria | Montagem por tamanho, sabor e recheio com preço automático; caixas de 4, 6 e cento como itens prontos; encomenda com sinal. |

Comparação honesta: a Docinhos da Gigi já faz o que a maioria dessas lojas faz (foto real, montagem do copo com preço calculado, Pix e cartão no site, acompanhamento do pedido, clube de pontos, WhatsApp). O que falta é principalmente **mostrar** isso logo na primeira tela e ganhar confiança de quem chega pelo Instagram.

## 2. Boas práticas de cardápio digital

| Prática | Fonte | Situação no nosso site |
|---|---|---|
| Foto real de cada item, mesmo enquadramento | Brendi e InfinitePay (blogs de fornecedores). Brendi cita dados internos do DoorDash: itens com foto vendem até 44% mais por mês | OK: todas as fotos são reais. Falta padronizar o enquadramento e gerar miniatura (P-06). |
| Nome, descrição curta com ingredientes e preço final em reais, sem asterisco | Brendi | OK. |
| Categorias que mais vendem no topo e 1 ou 2 destaques por categoria | Brendi | Parcial: a ordem vem do painel, mas não há destaque ("mais pedido"). |
| Frete por bairro ou distância e pedido mínimo visíveis antes do carrinho | Brendi, Brigadeiro Delicia, Sodiê | Falta: U-04 do plano (A4) resolve a faixa de frete no cardápio. |
| Link com carrinho e pagamento juntos, em vez de PDF ou foto no WhatsApp | Anota AI, Brendi (cita Abrasel: WhatsApp é 26% do faturamento de delivery de bares e restaurantes) | OK: é exatamente o nosso modelo. |
| Medir conversão (visitas que viram pedido) | Brendi | Falta: não há medição. Ver item 3.9. |
| Velocidade do cardápio | Brendi | Melhorou nesta rodada (P-01 e P-03). Faltam P-04, P-05 e P-07. |
| Prazo claro ("pronto em 2 horas", "entrega hoje") | Sodiê | Falta: depende do prazo médio real (pendência do Renan, U-05). |
| Encomenda com data (sob encomenda) separada do "pronta entrega" | Sodiê, Dora, Supreme | Não temos. Só vale se a Gigi aceitar encomendas. |

## 3. O que copiar (priorizado)

| # | O que copiar | De quem | Esforço | Quem | Observação |
|---|---|---|---|---|---|
| 3.1 | Faixa de confiança no topo: "Pix ou cartão", "Retirada grátis", faixa de frete, clube de pontos, horário de hoje | Sodiê, Brigadeiro Delicia | P | A4 | Já está no plano (U-04, U-05). Exemplo pronto em `/experimental.html`. |
| 3.2 | Selo "Mais pedido" em 1 ou 2 itens por categoria | Prática de mercado (Brendi) | M | A2 + A3 + A4 | Precisa de um campo no produto (marcado no painel) ou de cálculo pelos pedidos aprovados. |
| 3.3 | Prazo médio escrito ("entrega em cerca de X min") | Sodiê | P | A4 + Renan | Só depois que o Renan informar o prazo real. |
| 3.4 | Carrossel "Os queridinhos" com uma foto de cada categoria logo abaixo do topo | Apps de delivery em geral | P | A4 | Exemplo pronto em `/experimental.html`. Usa os dados que `/api/menu` já devolve. |
| 3.5 | Pedido mínimo e "a partir de" claros por produto | Confeitaria Helena, iFood | P | A4 | Já existe "a partir de" para produtos com tamanho. Pedido mínimo só se a Gigi quiser ter um. |
| 3.6 | Imagem de compartilhamento e título que dizem o que é e onde fica | Todas as lojas com domínio próprio | P | A5 (feito) + Renan | Open Graph feito nesta rodada (P-02). Título da home depende do Renan (P-13). |
| 3.7 | Domínio próprio | Supreme Brigaderia, Sodiê | P | Renan | Seção 4. |
| 3.8 | Encomendas com data (festas, caixas de cento) | Sodiê, Dora, Meslo | G | A2 + A3 + A4 | Só se for um desejo do negócio. Mexe em pedido, horário e painel. |
| 3.9 | Medir visitas e pedidos sem cookies de terceiros (ex.: Vercel Web Analytics) | Prática de mercado | P | Renan + A0 | Precisa ligar no painel da Vercel e ajustar a CSP. Avaliar a política de privacidade antes. |
| 3.10 | Caixas prontas para presente ("caixa com 6", "cento") como itens próprios | Rei do Delivery, Meslo | P | Renan (cadastro no painel) | Não precisa de código: é cadastro de produto. |

O que **não** copiar:

- Cardápio em PDF ou foto no WhatsApp: perde carrinho e pagamento (o nosso já é melhor).
- Pop-up de cadastro antes de ver o cardápio: atrapalha quem chega pelo Instagram.
- Marketplace como canal principal: a comissão do iFood e do Rappi é alta. Pode ser vitrine, mas o link do Instagram deve continuar apontando para o site próprio.

## 4. Domínio: docinhosdagigioz.com.br

Decisão do Renan (14/11/2026): o domínio será **docinhosdagigioz.com.br**. Uma consulta ao registro.br indicou que ele estava disponível, mas **ainda não foi registrado**. Enquanto não estiver registrado, qualquer pessoa pode registrá-lo antes. Nenhum agente registrou ou alterou nada.

Até o domínio estar ativo, as tags de compartilhamento (Open Graph) e o `canonical` continuam com `https://docinhos-site.vercel.app`. Para achar todos os pontos, busque pelo comentário `URL provisória: trocar quando houver domínio` em `public/`.

### 4.1 Passo a passo (Renan)

1. **Registrar no registro.br** (https://registro.br). Entre com a conta do CPF ou CNPJ da loja, pesquise `docinhosdagigioz.com.br` e registre. Preço em 2026: cerca de **R$ 40 por ano** (há desconto para vários anos). Ligue a verificação em duas etapas da conta e deixe um e-mail que você lê de verdade: os avisos de renovação chegam por ele. Domínio vencido sai do ar.
2. **Adicionar na Vercel.** No projeto `docinhos-site`, abra **Settings > Domains > Add Existing** e adicione `docinhosdagigioz.com.br`. A Vercel oferece adicionar também o `www.docinhosdagigioz.com.br`: aceite.
3. **Escolher o endereço principal.** Recomendo o endereço sem `www` como principal (mais curto para falar e escrever na bio). Na mesma tela, configure o `www` para **redirecionar** (308) para `docinhosdagigioz.com.br`.
4. **Apontar o DNS no registro.br.** No painel do domínio, em DNS, use **"Editar zona"** (mantém o DNS no registro.br, sem trocar servidores) e crie os registros que a Vercel mostrar na tela do domínio:
   - para `docinhosdagigioz.com.br`: um registro **A** com o IP indicado pela Vercel;
   - para `www`: um registro **CNAME** com o valor indicado pela Vercel (cada projeto tem o seu, no formato `algo.vercel-dns-0xx.com`).
   Use exatamente os valores do painel da Vercel. Não copie valores de tutoriais, porque eles mudam.
5. **Esperar a propagação.** Leva de minutos a algumas horas. Quando a Vercel mostrar "Valid Configuration", o certificado HTTPS é criado sozinho.
6. **Testar** no celular, fora do Wi-Fi: `https://docinhosdagigioz.com.br`, `https://www.docinhosdagigioz.com.br` (tem que redirecionar) e um pedido de teste até a tela do Pix (sem pagar).

### 4.2 O que muda no código depois que o domínio estiver ativo (agentes)

| Onde | O que | Quem |
|---|---|---|
| `api/order.js` (`SITE_URL`) | Endereço de retorno do Mercado Pago (`back_urls`) e do aviso de pagamento (`notification_url`) | A2 |
| `api/_lib/shipping.js` (`USER_AGENT`) e `scripts/test-order-*.js` | Endereço de contato e testes que conferem a URL | A2 |
| `public/*.html` e `public/conta/index.html` | `canonical`, `og:url` e `og:image` (busque o comentário "URL provisória") | A5 |
| Painel do Mercado Pago | Se houver URL de webhook cadastrada lá, trocar também | Renan |
| Bio do Instagram, perfil do Google, materiais impressos | Novo endereço | Renan |
| Google Search Console | Cadastrar o domínio novo e enviar o sitemap (quando existir, P-09) | Renan |

O e-mail técnico do pagador do Pix (`pedido-<codigo>@docinhos-site.vercel.app`, em `api/order.js`) pode continuar igual: ele não precisa existir para receber e-mail.

### 4.3 Cuidados

- **Não remova o `docinhos-site.vercel.app`.** Ele continua sendo o endereço interno da Vercel e é para onde apontam os links antigos (Instagram, conversas de WhatsApp, prints).
- **Redirecione as páginas, mas não a `/api/`.** Pedidos criados antes da troca levam o endereço antigo no aviso de pagamento do Mercado Pago. Se o endereço antigo inteiro passar a redirecionar, esses avisos podem não chegar e o pedido fica "aguardando pagamento". Caminho seguro:
  1. o A2 troca o `SITE_URL` e publica;
  2. espere pelo menos 48 horas (todo Pix antigo já venceu);
  3. só então redirecione `docinhos-site.vercel.app` para o domínio novo, de preferência por uma regra em `vercel.json` que vale só para as páginas (com condição de `host` e excluindo `/api/`). Essa regra é uma decisão do A0, porque `vercel.json` não está na faixa de nenhum agente.
- **Login e carrinho são por endereço.** O navegador guarda a sessão da conta, o carrinho e o último Pix separados para cada domínio. Na troca, o cliente vai precisar entrar de novo na conta e o carrinho aberto não passa para o domínio novo. Faça a troca num horário calmo, sem pedidos abertos.
- **A CSP e a checagem de origem do painel funcionam em qualquer domínio** (usam `'self'` e o próprio `host`): não precisam de mudança.
- **Renovação:** coloque um lembrete anual. Perder o domínio custa muito mais que R$ 40.

## 5. Landing experimental

- Endereço: `/experimental.html` (arquivos `public/experimental.html`, `experimental.css`, `experimental.js`).
- `noindex, nofollow` e nenhum link em outra página: só abre quem tiver o endereço.
- Só **lê** `/api/menu`. Não cria pedido, não faz login e não grava nada. Os botões levam para o cardápio oficial (`/` e `/#cat-<id>`).
- Respeita a CSP: sem script, estilo ou evento inline. Tudo que vem do banco entra por `textContent`.
- Ideias testadas: topo com fotos reais e situação da loja (aberto até X / abre Y), faixa de confiança (Pix ou cartão, retirada, faixa de frete, clube de pontos), "Os queridinhos" (um produto de cada categoria), atalhos por categoria e "Como funciona" em 3 passos.
- Medido localmente: CLS de 0,001 a 0,007 nas três larguras e sem rolagem lateral.
- Uso sugerido: o Renan abre no celular, compara com a home e diz o que quer levar para a home oficial (itens 3.1 e 3.4 acima). O A4 faz a mudança na home.

## Fontes

- [Sodiê Doces no iFood (Shopping Plaza Sul)](https://www.ifood.com.br/delivery/sao-paulo-sp/sodie-doces---shopping-plaza-sul-bosque-da-saude/564ada87-3936-4bc9-bcff-a6686afe6f38), [Sodiê no Rappi](https://www.rappi.com.br/restaurantes/delivery/50290-sodie-doces), [Exame: Sodiê cria app de delivery](https://exame.com/pme/sodie-doces-cria-aplicativo-de-delivery-para-entregar-bolos-e-salgadinhos/), [App Sodiê](https://appsodie.com.br/franquia/2), [Sodiê Express no Anota AI](https://pedido.anota.ai/loja/sodie-doces-express)
- [Supreme Brigaderia](https://supremebrigaderia.com.br/), [Brigadeiro Delicia](https://brigadeirodelicia.com/), [Confeitaria Helena](https://deliverydireto.com.br/confeitariahelena/confeitariahelena), [Santo Brigadeiro](https://pedido.anota.ai/loja/santo-brigadeiro-confeitaria), [Brigadelicia](https://www.goomer.app/brigadeliciaconfeitaria)
- [Meslo: cardápio para confeitaria](https://meslo.com.br/cardapio-digital-confeitaria/), [Dora](https://appdora.com.br/), [Rei do Delivery: brigadeiro para vender](https://reidodelivery.com.br/blog/brigadeiro-gourmet-para-vender)
- [Brendi: cardápio com fotos](https://brendi.com.br/blog/cardapio-digital-com-fotos-pratos/), [Brendi: cardápio digital 2026](https://brendi.com.br/blog/cardapio-digital-catalogo-gratis-2026/), [Anota AI: cardápio no WhatsApp](https://anota.ai/blog/cardapio-digital-no-whatsapp/), [InfinitePay: cardápio digital](https://www.infinitepay.io/blog/cardapio-digital)
- [Preço do .com.br em 2026 (linkfl)](https://blog.linkfl.com.br/como-registrar-um-dominio-com-br/), [techub: .com.br em 2026](https://techub.digital/blog/article/dominio-combr-barato-em-2026-onde-registrar-sem-tomar-susto-na-renovacao)
- [Vercel: adicionar e configurar domínio](https://vercel.com/docs/domains/working-with-domains/add-a-domain), [Vercel: redirecionar domínios](https://vercel.com/docs/domains/working-with-domains/deploying-and-redirecting)
