# Relatório final — Painel Gigi v2

Branch: `painel-v2` (só commits locais; nada no GitHub nem na produção). Diff contra `main`: 69 arquivos, cerca de 9.700 linhas novas.
Preview: https://docinhos-site-2da5ohigw-renantmgame-7908s-projects.vercel.app (usa o banco dev e o token de teste do Mercado Pago).

## O que mudou
- Loja:
  - produto pausado e loja fechada com aviso;
  - frete por faixas de km com CEP;
  - retirada R$ 0;
  - WhatsApp só depois do pagamento aprovado;
  - código DG-#### e página de acompanhamento;
  - política de privacidade;
  - correção do carrinho que não respondia ao toque.
- Conta do cliente: cadastro com consentimento de WhatsApp, login, recuperação por pergunta de segurança, meus pedidos e pontos (1 ponto por R$ 1; 100 pontos = R$ 10).
- Painel, pedidos: quadro com 3 colunas, atividade recente e confirmação antes de aceitar pedido não pago.
- Painel, pausa: fechar a loja por tempo; comando "acabou morango" com prévia, desfazer e reativar.
- Painel, outras abas: histórico com filtros; ajustes de horários, frete, etiqueta, sinônimos e segurança; editor de produto corrigido.
- Segurança:
  - recuperação de senha do admin com pergunta + código de uso único;
  - troca obrigatória de senha fraca;
  - limites de tentativas por usuário+IP;
  - pedidos só do próprio site;
  - webhook do Mercado Pago assinado;
  - pontos só com pagamento aprovado.
- Visual: identidade preservada, painel com o topo de chocolate da loja, contraste AA, botões de 44px.

## Como testar
- Testes: `node -r ./scripts/dev-env.js scripts/test-<nome>.js` (11 arquivos em scripts/). Última rodada completa (A2, mesmo backend): todos passaram. Rodada final do orquestrador interrompida por falta de memória do PC; repetir antes do merge na main.
- Navegador: abrir o Preview no celular e no computador.

## Antes de publicar em produção (ordem importa)
1. Rotacionar a senha do Neon de produção e o token do Mercado Pago (apareceram na conversa) e atualizar o `.env` e a Vercel (Production).
2. Confirmar `MERCADOPAGO_WEBHOOK_SECRET` em Production. Sem ele nenhum pagamento é confirmado.
3. Backup do banco de produção (branch no Neon).
4. Rodar no banco de produção, nesta ordem: `migrate-2026-11-10-painel-v2.js`, `migrate-2026-11-10-scopes.js`, `migrate-2026-11-10-order-attempts.js`. Todas só acrescentam.
5. Conferir no painel produtos ativos sem preço e sem tamanhos: passam a aparecer como "Consulte pelo WhatsApp", indisponíveis.
6. Primeiro login no painel: cadastrar a pergunta de segurança e guardar os 10 códigos fora do computador.
7. Ajustar faixas de frete e horários na aba Ajustes.
8. Merge na `main`, push e deploy. Promover o deploy manualmente: o rollback desligou a atribuição automática do domínio.

## Riscos e pendências
- Pagamento real e frete real não foram testados de ponta a ponta (MP dev responde 401; origem falsa no banco dev).
- Banco dev com frete, origem e etiqueta alterados por um teste interrompido; corrigir na aba Ajustes do Preview.
- Limite de consultas em acompanhamento e cotação fica na memória da função (fraco na Vercel; risco baixo).
- OWASP ZAP não rodou: sem Docker/Java.
- GitHub: ligar secret scanning com push protection e Dependabot.
- Página "Quem somos" aguarda textos da Gigi.
- Regra de pontos fixa no código; editar pelo painel exige trabalho novo.
- Apagar o branch dev do Neon quando não precisar mais.
