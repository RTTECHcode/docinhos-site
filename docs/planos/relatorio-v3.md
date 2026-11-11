# Relatório da rodada v3 — Painel Gigi

Status: RASCUNHO (F4 design e F5 QA em andamento). Nada foi publicado. Branch: `ajustes-v3`. Produção: `main` (643aa03).

## 1. Por que os pagamentos não confirmavam (DG-7747 e DG-5401)

Causa: a "assinatura secreta" do webhook cadastrada na Vercel (`MERCADOPAGO_WEBHOOK_SECRET`) é diferente da que o Mercado Pago usa. Todo aviso de pagamento chegava, mas o site respondia 401 ("assinatura inválida") e descartava. O dinheiro entrou, mas nenhum pedido de produção virou "pago".

O que mudou para não acontecer de novo:
- O log do webhook agora diz o motivo do 401, e o segredo é lido sem espaços extras.
- **Conferência de reserva**: se o pedido está pendente, o site pergunta ao Mercado Pago se ele foi pago. Ele aplica as mesmas checagens do webhook: moeda, valor, sem duplicar e pontos. Isso roda sozinho na tela do Pix e na página do pedido, com limite de frequência. No admin, o card do pedido ganhou o botão **Conferir pagamento**.
- A tela do Pix e a volta do cartão mudam sozinhas para "Pagamento confirmado".

## 2. O que mudou

Backend (A2):
- Endereço na conta, com cadastro e edição.
- Checkout preenchido para quem está logado.
- O CEP preenche rua, bairro e cidade, com cache e limite de consultas.
- Prévia de pontos do carrinho.
- Complemento pausado aparece como indisponível.
- A etiqueta da pausa é fixa.
- A categoria virou "Para família".
- Horários: dia sem horário fica fechado. Sem nenhum horário cadastrado, a loja fica fechada e o admin mostra um aviso. Fechamento manual sempre vence.

Admin (A3):
- O botão de fechar a loja ficou junto dos horários.
- A atividade recente começa recolhida.
- Saiu o botão de voltar status do pedido.
- Saiu o campo de etiqueta da pausa.
- Apagar o último horário de um dia pede confirmação.
- Novo botão Conferir pagamento.

Loja e conta (A4):
- Botão − no carrinho.
- Aviso de retirada.
- CEP automático.
- Checkout preenchido.
- Endereço na conta.
- Pontos no checkout.
- Complementos pausados escurecidos.
- Pix e cartão confirmam sozinhos.

Design (A5): _em andamento_. Inclui o brigadeiro, a faixa "Volto logo", o botão "Acompanhe", a correção dos botões flutuantes e a reorganização do topo.

Revisão de segurança (A1) dos endpoints novos: aprovada. As ressalvas foram corrigidas: cadastro gravado de uma vez, teto global de consultas ao ViaCEP e limite na prévia de pontos.

QA (A6): _em andamento_. O resultado vai para `docs/planos/qa-v3.md`.

## 3. Passos de produção

Já feitos em 11/11, com sua autorização:
- Segredo do webhook trocado por você na Vercel (Production e Preview) e no `.env`.
- Migrações `migrate-2026-11-10-v3-schema.js` e `migrate-2026-11-10-v3-categoria-familia.js` rodadas no banco de produção. As duas são só aditivas, e o código atual continua funcionando.
- Horários de produção temporários: 00:00 às 23:59 todos os dias. Assim a loja não fecha sozinha com a regra nova. Cadastre os horários reais quando quiser.
- Senha do usuário `admin` redefinida para a que você pediu. Ela foi marcada como fraca, e o painel avisa até você trocar. **Troque logo:** 4 números é pouco para um painel na internet.

Faltam (você faz, nesta ordem):
1. **Publicar**: juntar `ajustes-v3` na `main` e enviar (push). A Vercel publica sozinha. O segredo novo do webhook só passa a valer nesse deploy, porque variável da Vercel exige deploy novo. Tentei fazer um redeploy antes, mas o Claude Code bloqueia deploy de produção.
2. **Corrigir DG-7747 e DG-5401**: no admin, abra cada pedido e clique em **Conferir pagamento**. O site consulta o Mercado Pago e marca como pago, com pontos, se o valor bater.
3. **Teste rápido depois de publicar**: faça um Pix de valor baixo, veja a tela mudar sozinha e o pedido virar pago no admin. No Mercado Pago, abra Suas integrações e depois Webhooks: o histórico deve mostrar 200.
4. Cadastrar os horários reais e trocar a senha do admin.

## 4. Como testar antes de publicar

_A completar depois da F5._
