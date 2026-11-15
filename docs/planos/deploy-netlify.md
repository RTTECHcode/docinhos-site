# Deploy na Netlify (F6)

Hospedagem: Netlify. Domínio oficial: https://docinhosdagigioz.com.br. Nota: a Vercel segue publicando a loja de produção
até o corte (passo 5); o `vercel.json` fica até lá.

Guia do corte da Vercel para a Netlify. Plano: `docs/planos/plano-v4.md`, seção 5. Quem executa os passos é o Renan:
nenhum agente cria conta, faz deploy, mexe em DNS ou em produção.

## 1. Como ficou o código

| Peça | Arquivo | O que faz |
|---|---|---|
| Configuração | `netlify.toml` | `publish = "public"`, Functions em `netlify/functions` (esbuild), `/api/:name` reescrito para a Function (status 200), cabeçalhos de segurança, CSP e `Cache-Control` por rota (mesmos valores do `vercel.json`). |
| Functions | `netlify/functions/<nome>.js` | Uma por arquivo de `api/` (9 hoje). Só embrulham o handler de `api/<nome>.js`, que não muda. |
| Adaptador | `netlify/lib/adapter.js` | Evento da Function vira o mesmo `req`/`res` da Vercel. Corpo cru em `req.rawBody`. IP do cliente pelo `x-nf-client-connection-ip` (o `x-real-ip` enviado pelo cliente é descartado). Aplica os cabeçalhos do `netlify.toml` também nas respostas da API. |
| Ambiente | `api/_lib/env.js` | `isProduction()` fail-closed: é produção, a menos que `APP_ENV` seja `development` ou `preview` (ou `NODE_ENV=test`). Valor ausente ou com erro de digitação = produção. |
| Endereço | `api/_lib/site.js` | `SITE_URL` (padrão `https://docinhosdagigioz.com.br`). Dele saem `notification_url` e `back_urls` do Mercado Pago. |
| Servidor local | `scripts/dev-server.js` | Lê os cabeçalhos do `netlify.toml`; `APP_ENV=development` vem de `scripts/dev-env.js`. |
| Testes sem banco | `scripts/test-netlify.js` | Evento da Function simulado (sem `netlify-cli`): corpo cru, base64, query, IP, cookies, cabeçalhos, imagem, webhook 401/200. Confere que `netlify.toml` e `vercel.json` têm os mesmos cabeçalhos. |

O `vercel.json` fica até o corte. Enquanto os dois existirem, qualquer mudança de cabeçalho ou CSP vai nos dois
(o `scripts/test-netlify.js` falha se divergirem).

## 2. Variáveis de ambiente (só os nomes)

Cadastrar em Site configuration > Environment variables, com escopo "Functions" (e "Builds", se o painel pedir).
Marcar como secreta onde o painel oferecer. Nunca colar valor em arquivo do repositório.

| Variável | Produção (`main`) | Deploy preview / branch `v4` | Observação |
|---|---|---|---|
| `DATABASE_URL` | banco de produção | banco **dev** | Obrigatória. |
| `MERCADOPAGO_ACCESS_TOKEN` | token de produção | token de **teste** | Obrigatória para pagar. |
| `MERCADOPAGO_WEBHOOK_SECRET` | assinatura secreta do app de produção | assinatura do app de teste (ou vazio) | Em produção, sem ela o webhook responde 500 (fail-closed). |
| `APP_ENV` | `production` | `preview` | Ausente = produção (mais restrito). Só `development`/`preview` liberam as regras de teste. |
| `SITE_URL` | não precisa (padrão é o domínio) | URL fixa da branch, ex.: `https://v4--<nome-do-site>.netlify.app` | Sem ela no preview, o Mercado Pago avisaria a produção e voltaria para o domínio. |
| `VAPID_PUBLIC_KEY` | chave dos avisos push | pode repetir ou ficar vazio | Opcional: sem as três, o push fica desligado. |
| `VAPID_PRIVATE_KEY` | idem | idem | Opcional. |
| `VAPID_SUBJECT` | idem | idem | Opcional. |

`WHATSAPP_NUMBER` aparece no `.env.example`, mas a API não lê essa variável.

### Cuidado com a Vercel durante a transição

Desde a F6 M4, o padrão de `SITE_URL` é `https://docinhosdagigioz.com.br`. A Vercel continua publicando a `main` até o corte.
**Antes do merge da `v4` na `main`** (passo 4), cadastrar na Vercel (produção) `SITE_URL=https://docinhos-site.vercel.app`.
Sem isso, os pedidos feitos na Vercel mandariam o Mercado Pago avisar e voltar para o domínio, que ainda não aponta para lugar nenhum.
Também na Vercel, `APP_ENV` pode ficar sem valor: sem a variável, a regra é a de produção (o mais restrito).
Depois do passo 5 (domínio na Netlify), a variável da Vercel pode sair.

## 3. Passo a passo do Renan (plano, seção 5.3)

1. Criar conta na Netlify (de preferência no e-mail da Gigi) e importar o repositório do GitHub. Branch de produção: `main`.
   O build não tem comando; a Netlify lê tudo do `netlify.toml`.
2. Cadastrar as variáveis da seção 2: produção com os valores de produção e `APP_ENV=production`; deploy preview e branch `v4`
   com o banco dev, o token de teste e `APP_ENV=preview`.
3. Abrir o deploy da branch `v4` e conferir o roteiro curto (seção 4).
4. Rodar no banco de produção `scripts/migracoes/migrate-2026-11-12-v4-schema.js` (AINDA NÃO RODOU em produção; só acrescenta,
   e vai ANTES do código da v4). Cadastrar `SITE_URL` na Vercel (seção 2). Depois, aprovar o merge da `v4` na `main` e o push (Vercel e Netlify publicam juntas).
5. No registro.br, apontar o domínio para a Netlify (Netlify DNS ou os registros que ela indicar). `www` redireciona para o
   domínio sem `www`. O HTTPS é automático.
6. No Mercado Pago, trocar a URL do webhook para `https://docinhosdagigioz.com.br/api/mp-webhook` e conferir que a assinatura
   secreta é a mesma de `MERCADOPAGO_WEBHOOK_SECRET` da Netlify.
7. UptimeRobot: trocar a URL para `https://docinhosdagigioz.com.br/api/health`.
8. Cloudflare Web Analytics: criar o site (grátis) e mandar o token para o A0 colocar.
9. Depois de 48 h estável: o projeto da Vercel vira só redirecionamento para o domínio (ou é desligado).
   Nessa hora sai o `vercel.json` (o `"start": "vercel dev"` já saiu na F7).

## 4. Roteiro curto de teste no deploy da `v4`

- `GET /api/health` responde 200 com todas as verificações `true` (o webhook só acende com 3 ou mais recusas depois do último aviso aceito).
- `curl -I` na página inicial e em `/api/menu`: `Content-Security-Policy`, `X-Frame-Options: DENY` e `Strict-Transport-Security` presentes.
- Cardápio carrega com fotos (`/api/img?id=...` com `Cache-Control: public, max-age=31536000, immutable`).
- `/pedido` abre sem `.html` (URLs bonitas são padrão na Netlify).
- Pedido de teste com Pix e com cartão de teste: o total vem do servidor; a volta do Mercado Pago cai no endereço do `SITE_URL` da branch.
- Pagamento aprovado chega pelo webhook e aparece no painel (só com `SITE_URL` da branch cadastrado).
- Login no painel e na conta do cliente: o cookie de sessão volta com `HttpOnly` e `Secure`, e o logout limpa.

## 5. Observações

- Cabeçalhos: a CDN da Netlify aplica os `[[headers]]` nos arquivos estáticos; nas respostas da API quem aplica é o adaptador
  (por isso o `netlify.toml` vai em `included_files`). O `Cache-Control` que o handler define vence o do `netlify.toml`.
- Tempo máximo das Functions: conferir no painel o limite do plano. A rota mais lenta é o pedido com Pix, que chama o Mercado Pago.
- Memória: a Vercel usava 1024 MB (`vercel.json`); as Functions da Netlify já rodam com 1024 MB.
- Node: `NODE_VERSION = "22"` no `netlify.toml` (as Functions seguem a versão do build).
- Para A4/A5 (seção 5.2 do plano): quando entrar o Cloudflare Web Analytics, a CSP precisa de
  `script-src https://static.cloudflareinsights.com` e `connect-src https://cloudflareinsights.com`, no `netlify.toml` e no
  `vercel.json` (até o corte). O `scripts/test-netlify.js` compara os dois.
- Limite de 12 funções: continua valendo (uma Function por arquivo de `api/`, conferido no teste).
