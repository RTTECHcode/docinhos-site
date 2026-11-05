# Docinhos da Gigi

Site público do cardápio, separado do painel antigo do iFood.

## Arquivos

- `public/`: página, estilos, JavaScript e imagens.
- `api/menu.js`: leitura pública do cardápio.
- `api/health.js`: teste de conexão com o banco.
- `scripts/schema.sql`: tabelas do catálogo.
- `scripts/catalog.js`: produtos identificados no relatório local.
- `scripts/seed.js`: cria tabelas e importa produtos sem inventar preços.

## Rodar

1. Crie um banco Neon.
2. Copie `.env.example` para `.env` e preencha `DATABASE_URL`.
3. Instale dependências: `npm install`.
4. Rode seed: `npm run seed`.
5. Use `vercel dev` para testar a página e as APIs.

Preços estão vazios porque o relatório fornecido contém vendas, não o preço atual do cardápio. Preencha-os no banco antes de publicar pedidos.
