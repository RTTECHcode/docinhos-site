# Docinhos da Gigi

Site público do cardápio e dos pedidos, separado do painel antigo do iFood.
Hospedagem: Netlify. Domínio oficial: https://docinhosdagigioz.com.br.
Nota: a Vercel segue publicando a loja de produção até o corte para a Netlify (por isso o `vercel.json` ainda existe).
O passo a passo do corte está em `docs/planos/deploy-netlify.md`.

## Arquivos

- `public/`: páginas, estilos, JavaScript e imagens.
- `api/`: funções da loja (cardápio, pedido, conta, painel, webhook do Mercado Pago). Máximo de 12 arquivos.
- `netlify.toml` e `netlify/`: configuração da Netlify e adaptador das Functions.
- `scripts/schema.sql`: estado final do banco.
- `scripts/catalog.js` e `scripts/seed.js`: produtos iniciais do cardápio (`npm run seed`).
- `scripts/dev-server.js`: servidor local (lê os cabeçalhos do `netlify.toml`).
- `scripts/migracoes/`: migrações e conferências de uso único, com README dizendo o que já rodou em produção.
- `scripts/test-*.js`: testes.

## Rodar localmente

1. Crie um banco Neon de desenvolvimento e coloque a `DATABASE_URL` em `.env.dev` (nunca use o banco de produção).
2. Instale dependências: `npm install`.
3. Suba o site: `npm start` (porta 3000 por padrão; `node -r ./scripts/dev-env.js scripts/dev-server.js <porta>` para outra).

## Testes

- `npm run test:puro`: testes sem banco (rápidos).
- `npm test`: todos os `scripts/test-*.js`, um por vez (usam o banco de desenvolvimento). Para no primeiro erro; use `node scripts/run-tests.js --continuar` para ir até o fim.

Preços estão vazios no seed porque o relatório inicial tinha vendas, não o preço atual do cardápio. Hoje os preços são editados pelo painel.
