# Relatório da v4 — Docinhos da Gigi

Para: Renan. Escrito pelo A0 (orquestrador) em 15/11/2026.

## Resumo em 1 minuto

A v4 está pronta e testada na branch `v4`. Nada foi para a loja de verdade.
O site de teste (preview) mostra tudo funcionando com o banco de teste: https://docinhos-site-git-v4-renantmgame-7908s-projects.vercel.app (abra logado na Vercel; o preview é protegido). Painel da publicação: https://vercel.com/renantmgame-7908s-projects/docinhos-site/6HLcK89zEBdsaZuK72rgRMzvVn4L

Antes de publicar na loja de verdade, falta 1 coisa que só você pode fazer: o passo 3 abaixo (`SITE_URL` na Vercel). Sem ela, os pagamentos não confirmam. A migração do banco de produção (passo 2) você já rodou em 15/11: 28 itens "Pronto".

## O que mudou

Loja:
- Clube por itens: a cliente troca pontos por doces escolhidos (em vez de desconto em reais).
- Cupons de desconto, validados no servidor; não acumulam com prêmio do Clube.
- Encomenda com data marcada (dia + janela de horário).
- Selo "Mais pedido" nos doces que mais vendem; prazo de entrega 30 a 50 min no topo.
- "Quem somos" com o texto oficial e ilustrações de morango e chocolate.
- Rastreio do pedido pela conta, com itens e bairro; botão "Gerar novo pagamento" se o Pix vencer ou o cartão falhar.
- Ao montar um doce, o total e o botão "Adicionar" ficam fixos embaixo.
- Números (preços, totais, pontos) na fonte Fredoka, pedido da Gigi. Títulos continuam na Bagel.
- Fontes servidas pelo próprio site (mais rápido e sem depender do Google).
- Página "não encontrada" com a marca; site instalável no celular; dados da loja para o Google (endereço, área Osasco); robots.txt e sitemap.xml.

Painel:
- Kanban com etapas claras; filtro de agendados.
- Aviso de pedido novo: som, número no título da aba e notificação push (painel instalável como app).
- Relatórios de vendas e de clientes, com planilha (CSV) que abre no Excel com acentos.
- Cupons, Clube, vitrine, mimo (brinde para quem avaliou no Google).
- Enquadrar foto ao enviar: prévia quadrada com arrastar e zoom; sai 800x800 leve.
- Faixa de alerta se o Mercado Pago parar de avisar pagamentos; saúde do site em /api/health.

Segurança e bastidores:
- 0 problema Crítico ou Alto na revisão final de segurança. Os 2 Médios e os Baixos foram corrigidos (aviso falso no monitor, estorno de Pix antigo, entre outros).
- Código pronto para a Netlify (hospedagem grátis com uso comercial). A Vercel continua até você trocar.
- `npm test` roda todos os testes, um por vez; `npm run test:puro` roda os que não usam banco.
- Scripts de migração organizados em `scripts/migracoes/`.

Testes: cerca de 450 checagens de servidor e banco passando, loja e painel testados no navegador em 3 tamanhos de tela, sem erro de console. Detalhes em `docs/planos/qa-v4.md` e `docs/planos/seguranca-v4-f5.md`.

## Seu passo a passo

Faça na ordem. Onde aparece `!`, digite no Claude Code com o `!` na frente (roda aqui e eu vejo o resultado).

### Parte 1 — Publicar a v4 na loja atual (Vercel)

1. Olhe o preview (link no topo). Roteiro curto: fazer um pedido de teste, ver Quem somos, abrir o painel, testar o enquadramento de foto e a planilha de vendas.
2. FEITO em 15/11: banco de produção atualizado (`scripts/migracoes/migrate-2026-11-12-v4-schema.js`, 28 itens "Pronto").
3. Na Vercel: Settings > Environment Variables > Production, criar `SITE_URL` = `https://docinhos-site.vercel.app`.
   Por quê: a v4 já usa o domínio novo como padrão; sem essa variável, o Mercado Pago avisaria os pagamentos num endereço que ainda não existe.
4. Me peça "pode juntar a v4 na main e dar push". Eu faço o merge e o push; a Vercel publica sozinha.
5. Faça um pedido real pequeno com Pix e confira no painel que ficou "Pago".
6. Na conta do Instagram: no painel, Ajustes, preencha o link do Instagram da loja (aparece em Quem somos e no rodapé).
7. Confira no painel, Ajustes, as faixas de frete. Um teste apagou essa configuração no banco de teste; quero ter certeza de que a produção tem as faixas que vocês usam.
8. Link de avaliação do Google (mimo): confira no painel, Ajustes, se o link é o da loja.

### Parte 2 — Mudar para a Netlify e o domínio (quando tiver 1 hora)

Guia completo: `docs/planos/deploy-netlify.md`. Resumo:
1. Criar conta na Netlify (de preferência no e-mail da Gigi) e importar o repositório `RTTECHcode/docinhos-site`. Branch de produção: `main`.
2. Cadastrar as variáveis (seção 2 do guia). Produção: as mesmas da Vercel + `APP_ENV=production`. Preview: banco de teste + `APP_ENV=preview`.
3. Conferir o site que a Netlify gerar (roteiro na seção 4 do guia).
4. No registro.br, apontar `docinhosdagigioz.com.br` para a Netlify (ela mostra os registros).
5. No Mercado Pago (Suas integrações > Webhooks): trocar a URL para `https://docinhosdagigioz.com.br/api/mp-webhook`.
6. No UptimeRobot: trocar a URL do monitor para `https://docinhosdagigioz.com.br/api/health`.
7. Avisos push no celular/PC: `! node scripts/gerar-vapid.js` e cadastrar as 3 chaves `VAPID_*` na Netlify. Sem elas, o som e o título da aba funcionam; só o push fica desligado.
8. Cloudflare Web Analytics (grátis): criar o site e me mandar o token. Eu coloco no `public/config.js`.
9. Depois de 2 dias estável: na Vercel, apagar a variável `SITE_URL` e transformar o projeto em redirecionamento para o domínio (ou desligar). Aí eu removo o `vercel.json`.

Custo fixo depois disso: só o domínio (R$ 40/ano, vence em 14/11/2027).

## Arquivos para você ver

- Foto da travessa já cortada em quadrado: `C:\Users\menez\AppData\Local\gigi-tools\foto-travessa\travessa-quadrada.webp`. No painel: Produtos > Surpresa de Morango na Travessa > Trocar foto (ou use o novo enquadramento).
- Comparação das fontes dos números: `C:\Users\menez\AppData\Local\gigi-tools\v4-a0-numeros-comparacao.png`.

## Pendências e avisos

- Pastas antigas das v2 e v3 (22 cópias de trabalho em `.claude/worktrees/`): não consegui apagar ("Permission denied", provavelmente o OneDrive segurando arquivos). Todas estão salvas na `main`. Para limpar: pause a sincronização do OneDrive e me peça de novo.
- Cache: o cardápio pode levar até 1 minuto para mostrar uma mudança (abrir/fechar loja, preço). O pedido sempre confere no servidor, então não há risco de cobrar errado. Fotos em `/images` ficam 30 dias em cache: para trocar uma delas, use nome novo (fotos enviadas pelo painel não têm esse problema).
- Script `scripts/limpar-ip-antigo.js` (LGPD): você rodou em 15/11 na produção; 0 IP com mais de 90 dias. Rodar de novo a cada 3 meses, primeiro sem `--aplicar` (só conta).
- O script de conferir pagamento mudou de lugar: `scripts/migracoes/conferir-pagamento.js`.
- Ficam para a v5: WhatsApp CoEx; ajuste interno na leitura do saldo de pontos (A-06).
- Durante a madrugada, um teste de origem desconhecida fechou a loja de teste por alguns minutos; foi restaurada. A loja de verdade não foi afetada.
