# Auditoria v4 (A1): segurança, arquitetura e operação

Fase 0, somente leitura. Branch `v4` (base `bff189f`). Auditor: A1. Data: 13/11/2026.
Nenhum código, commit ou banco de produção foi tocado. Testes ativos rodaram só em `http://localhost:3401` com o banco de desenvolvimento (`.env.dev`, via `scripts/dev-env.js`). Nenhum segredo foi aberto ou impresso.

## 1. Resumo

| Severidade | Quantidade |
|---|---|
| Crítico | 0 |
| Alto | 2 |
| Médio | 10 |
| Baixo | 13 |
| **Total** | **25** |

Os 5 principais achados:

1. **S-01 (Alto, condicional):** a senha do admin com 4 dígitos pode ser descoberta por força bruta distribuída em cerca de 1 a 2 semanas. Depois disso, o atacante toma a conta.
2. **O-01 (Alto):** não há monitoramento de erros nem alerta quando o webhook do Mercado Pago falha. Já aconteceu: houve 401 durante semanas sem ninguém perceber.
3. **S-02 (Médio):** a recuperação de conta do cliente depende só da resposta da pergunta de segurança. Não existe segundo fator.
4. **O-02 (Médio):** a política de privacidade promete excluir os dados a pedido. O sistema não tem rotina para isso (nem endpoint nem ação no painel).
5. **A-01 (Médio):** `scripts/schema.sql` não sobe em um banco vazio, porque faz ALTER em `customers` antes do CREATE. Isso afeta a recuperação de desastre.

## 2. Achados

### 2.1 Segurança

| ID | Área | Severidade | Evidência | Impacto | Correção sugerida | Esforço |
|---|---|---|---|---|---|---|
| S-01 | Autenticação admin | Alto (condicional: vale se a senha atual do admin ainda tiver 4 dígitos, como registrado na v3) | `api/admin.js:54` (`USER_SPREAD_MAX = 30`), `:55-61` (`evaluateLock`: 5 falhas em 15 min e 10 em 24 h por par usuário+IP; 20 por IP; o limite "spread" por usuário vale só para IP desconhecido); `:1015` (com senha fraca, o painel ainda libera `password_change`, `security_setup` e `recovery_codes_new`); `scripts/reset-admin-password.js:8,22` (`ADMIN_WEAK=1` pula o mínimo de 8 caracteres) | Uma senha de 4 dígitos tem 10.000 combinações. Com 30 tentativas por hora vindas de muitos IPs, são cerca de 720 por dia: em média 7 dias, no pior caso 14. Com a senha certa, o atacante troca a senha, cadastra a pergunta de segurança e gera códigos de recuperação. O resultado é tomada total do painel: PII de todos os clientes, cancelamento de pedidos e mudança de preços. | (1) Trocar já a senha do admin por uma de 12 ou mais caracteres. (2) Em produção, recusar login com `weak_password` quando a senha tiver menos de 8 caracteres, ou não aceitar `ADMIN_WEAK`. (3) Criar um teto diário por usuário que valha para qualquer IP (ex.: 50 falhas em 24 h), com aviso na auditoria. (4) Depois, adotar TOTP. | P |
| S-02 | Recuperação de conta do cliente | Médio | `api/customer.js:159-162` e `api/_lib/customer.js` (`recover`): telefone + resposta + nova senha. Limites: 5 falhas em 30 min por par, 10 em 24 h, e spread de 10 por hora por telefone para IP desconhecido. | Respostas como "professor favorito" ou "primeiro celular" são adivinháveis por conhecidos ou por pesquisa em fontes abertas. Quem acerta toma a conta, vê o endereço e os pedidos e troca a senha. Atenuantes: os pontos ficam travados por 48 h e as sessões são derrubadas. | Enviar um código por WhatsApp ou e-mail antes de aceitar a nova senha (já está na fila da v4?). Enquanto isso não existir, avisar o cliente pelo WhatsApp quando houver uma recuperação. | M |
| S-03 | Enumeração de contas | Médio | Confirmado ativamente: o segundo `POST /api/customer?a=register` com o mesmo telefone respondeu `409 {"code":"duplicate"}` e a mensagem "Já existe uma conta com esse telefone ou e-mail" (`api/_lib/customer.js:33,288,302`). O limite é de 15 tentativas por IP por hora. | Qualquer pessoa descobre se um telefone é cliente da loja. Isso facilita o ataque S-02. O login e o `recover_question` não vazam essa informação (pergunta falsa estável e tempo de resposta igualado, conferidos). | Sem código por WhatsApp não há como esconder totalmente. Aceitar o risco e documentar, ou adotar a verificação por código (S-02) e responder sempre "enviamos um código". Um teto global de cadastros por hora reduz a varredura em massa. | M |
| S-04 | Autorização e auditoria de PII | Médio | `api/admin.js:766` (`A.orders`) e `:787` (`A.order_history`): os papéis staff e admin veem nome, telefone e endereço de todos os pedidos. Nenhuma leitura grava em `admin_audit`. | Um vazamento por funcionário não deixa rastro. Isso pesa para a LGPD (princípio de responsabilização) e cresce com os relatórios e o CSV da v4. | Registrar em `admin_audit` as consultas de histórico e toda exportação (usuário, filtros, quantidade de linhas). Avaliar mascarar o telefone para staff fora dos pedidos do dia. | P |
| S-05 | Webhook | Baixo | `api/mp-webhook.js:84`: só falha fechado quando `VERCEL_ENV === 'production'`. Em preview ou dev sem o segredo, aceita avisos sem assinatura. | Baixo, porque o pagamento é sempre buscado de novo na API do Mercado Pago com o nosso token: um aviso falso não muda o status. Ainda assim gera chamadas à API por conta de terceiros. No teste local, o segredo estava definido e o webhook respondeu 401 com assinatura falsa ou ausente. | Falhar fechado sempre que o segredo faltar, exceto com `NODE_ENV=test`. | P |
| S-06 | Pagamento | Baixo | `api/_lib/payments.js:82`: `if (pay.currency_id && pay.currency_id !== 'BRL')`. Um pagamento sem `currency_id` passa. | Teórico: o Mercado Pago sempre envia a moeda. É defesa em profundidade. | Exigir `pay.currency_id === 'BRL'`. | P |
| S-07 | Recuperação do admin | Baixo | `api/admin.js:946-947`: 3 falhas por hora bloqueiam a recuperação por usuário OU por IP. | Qualquer pessoa que saiba o nome de usuário bloqueia a recuperação do admin por 1 h, repetidamente. Não bloqueia o login. | Contar o bloqueio por par usuário+IP e manter um teto global maior por usuário. | P |
| S-08 | Integridade de recurso externo | Baixo | ZAP: "Sub Resource Integrity Attribute Missing" em `/` e `/pedido.html` (Google Fonts). | O CSS vem de terceiro sem SRI, mas a CSP limita `style-src` e `font-src` aos domínios do Google. Já foi aceito na v3. | Hospedar as fontes em `public/` e remover `fonts.googleapis.com` da CSP. | P |

### 2.2 Arquitetura

| ID | Área | Severidade | Evidência | Impacto | Correção sugerida | Esforço |
|---|---|---|---|---|---|---|
| A-01 | Schema e migração | Médio | `scripts/schema.sql:75-80` faz `alter table customers add column ...` antes de `create table if not exists customers` (`:143`). `scripts/migrate.js:6` roda os comandos em sequência e para no primeiro erro. Não executei em banco vazio; a conclusão vem da leitura (o Postgres recusa ALTER em tabela inexistente). | Um ambiente novo ou uma restauração a partir do schema falha. Isso piora a recuperação de desastre (O-05). | Mover os ALTERs de `customers` para depois do CREATE. Criar um teste que aplique o schema em um branch Neon vazio. | P |
| A-02 | Pedido com pontos | Baixo | `api/order.js:437-464`: o INSERT do pedido e o `loyalty.reserve` são chamadas separadas. Se `reserve` lançar uma exceção (falha de rede ou do banco), o pedido fica gravado com `discount_cents`/`points_redeemed` e sem a linha `redeem_reserve`, e a resposta é 500. | Baixo hoje: o pagamento ainda não foi criado nesse ponto, então o pedido fica pendente e órfão. Ele vira um risco na v4 se itens resgatados ou cupons seguirem o mesmo padrão. | Juntar INSERT e reserva em uma única instrução (CTE com `pg_advisory_xact_lock` no mesmo `sql.transaction`), ou apagar o pedido no `catch`. | P |
| A-03 | Tamanho de arquivos | Médio | `api/admin.js`: 1.485 linhas. `public/app.js`: 1.532 linhas. | A v4 (relatórios, cupons, resgate de itens) aumenta os dois arquivos. Isso dificulta a revisão e aumenta o risco de regressão. | Manter uma função Vercel só para o admin (o roteador `?a=`) e mover os handlers para `api/_lib/admin/{sessao,pedidos,catalogo,config,usuarios,relatorios}.js`. No front, separar `app.js` em módulos ES (`cart`, `checkout`, `conta`, `menu`) servidos por `script type=module`, compatível com a CSP `script-src 'self'`. | M |
| A-04 | Duplicação | Baixo | `parseCookies`, `sameOrigin` e `isJsonType` existem em `api/admin.js:349,362,369` e em `api/_lib/auth.js:144,154,161`. | Uma correção de CSRF feita em um lugar não chega ao outro. | `admin.js` deve importar de `_lib/auth.js`. | P |
| A-05 | Configuração fixa no código | Baixo | `api/order.js:10` (`SITE_URL = 'https://docinhos-site.vercel.app'`), `:15` (URL de notificação), `:27` (`STORE_ADDRESS`). | Deploys de preview mandam o `notification_url` e o retorno do Mercado Pago para produção. Uma troca de domínio exige deploy. | Ler de variável de ambiente (`SITE_URL`) com fallback. O endereço da loja já tem `settings.store_address`; manter só como reserva. | P |
| A-06 | Escrita em leitura | Baixo | `api/_lib/loyalty.js:144-145`: `getBalance` chama `releaseStaleReserves` (escrita) em toda leitura, inclusive em `GET /api/customer?a=me` a cada página. | Escritas desnecessárias no Neon. Contenção no ledger se a v4 consultar saldo em mais telas. | Liberar reservas vencidas no `sweepOrders` ou em um cron. Na leitura, apenas calcular o saldo ignorando reservas vencidas. | P |
| A-07 | Concorrência | Baixo | `api/_lib/loyalty.js:176`: `pg_advisory_xact_lock($1::bigint)` com o id do cliente puro, sem namespace. | Se a v4 criar outro lock por id (cupom, item, pedido), ids iguais de entidades diferentes passam a se bloquear entre si. | Usar a forma de duas chaves `pg_advisory_xact_lock(<classe>, id)`, com uma classe por domínio (1 = pontos, 2 = cupom...). | P |
| A-08 | Testes | Médio | Não existe `.github/`. `package.json:6` não tem script `test`. Há 17 `scripts/test-*.js` rodados à mão contra o banco dev. | Nada impede um merge que quebre preço, pontos ou webhook. A v4 mexe em dinheiro (cupom, item grátis). | Criar `npm test` que rode os scripts em sequência e um GitHub Actions com um branch Neon efêmero. Acrescentar testes de concorrência do resgate (N pedidos paralelos com saldo para 1). | M |
| A-09 | Índices | Baixo | `scripts/schema.sql`: não há índice em `orders(payment_status)` (usado por `sweepOrders` e pela conferência de pendentes). `payments.js:66` faz `detail like` em `admin_audit` sem índice. As buscas do admin usam `strpos(lower(...))` sem índice. | Irrelevante no volume atual (centenas de pedidos). Vira custo com os relatórios da v4 por período e status. | Para os relatórios: índice `orders(created_at, payment_status)` ou parcial `where payment_status='approved'`. Em `noteCancelledPaid`, trocar o `like` por uma coluna `order_id` em `admin_audit`. | P |
| A-10 | Regra de pontos | Baixo | `api/admin.js:826`: cancelar no painel só chama `releaseReserve`. Os pontos ganhos por um pedido já pago só são revertidos por estorno via webhook do Mercado Pago (`refunded`/`charged_back`). | Se a loja cancelar um pedido pago e devolver o dinheiro fora do Mercado Pago (Pix manual), o cliente fica com os pontos. | Ao cancelar um pedido `approved`, registrar `reversal` dos pontos ganhos (ou exigir confirmação explícita). | P |

### 2.3 Operação

| ID | Área | Severidade | Evidência | Impacto | Correção sugerida | Esforço |
|---|---|---|---|---|---|---|
| O-01 | Monitoramento e alertas | Alto | Não há Sentry, log drain nem alerta. `api/health.js` só faz `select 1`. Histórico (`docs/planos/relatorio-v3.md`): o webhook respondeu 401 por semanas, por segredo errado, sem ninguém notar. | Pagamentos aprovados podem ficar como pendentes. Há atenuantes: a conferência de reserva em `order-status` (pedidos pendentes com menos de 2 h) e o botão do painel. Mesmo assim, erros 500 no checkout passam despercebidos no lançamento. | (1) Monitor externo gratuito (UptimeRobot ou Better Stack) em `/api/health` a cada 5 min, com alerta por WhatsApp ou e-mail. (2) Health checando presença (não valor) de `MERCADOPAGO_ACCESS_TOKEN` e `MERCADOPAGO_WEBHOOK_SECRET` e a hora do último webhook aceito. (3) Contar 401 no webhook e avisar no painel. (4) Sentry ou log drain da Vercel. | P |
| O-02 | LGPD: direitos do titular | Médio | `public/privacidade.html:66,74` promete a exclusão a pedido. Não existe nenhum `delete from customers` nem anonimização fora dos `scripts/test-*.js`. Também não há exportação dos dados. | Hoje o pedido de exclusão só pode ser atendido por SQL manual em produção. Isso é arriscado e não deixa registro. | Criar a ação admin-only `customer_anonymize` (anonimiza nome, telefone e endereço dos pedidos, apaga a conta, as sessões e o endereço salvo, preserva os totais e a auditoria) e a ação do cliente `a=export` (JSON com os próprios dados). Registrar em `admin_audit`. | M |
| O-03 | LGPD: retenção | Baixo | `orders.client_ip` não é apagado nunca. Os eventos de consentimento guardam o IP (é prova de consentimento, retenção justificável). Já são purgados: `login_attempts` e `customer_login_attempts` em 7 dias (`api/admin.js:444`, `api/_lib/customer.js:329`), `rate_hits` em 1 dia, sessões vencidas. | A política diz "pelo tempo necessário", sem prazo. Guarda IP de pedidos indefinidamente. | Anular `client_ip` dos pedidos com mais de 90 dias (o limite antiabuso usa só 10 min). Escrever os prazos na política. | P |
| O-04 | Termos, trocas e SAC | Médio | Páginas públicas: `index`, `pedido`, `privacidade`, `quem-somos`, `conta`. Não há termos de uso nem política de trocas, cancelamento e reembolso. Não há CNPJ/CPF nem endereço identificado (`public/quem-somos.html:40` tem o comentário "CONFIRMAR ... endereço ... não incluídos de propósito"). O SAC é só o WhatsApp. | O Decreto 7.962/2013 (comércio eletrônico) exige a identificação do fornecedor e um canal de atendimento, e o CDC exige regras claras de cancelamento e reembolso. Sem isso, há risco de reclamação ou Procon e conflito em estornos. | Página `/termos` com cancelamento, reembolso, alergênicos, prazos e o programa de pontos (incluindo resgate de itens e cupons da v4). Rodapé com razão social ou CPF/MEI, endereço ou cidade, e o canal de SAC. O texto final depende do dono e, se possível, de revisão jurídica. | P |
| O-05 | Backup e PITR do Neon | Médio (hipótese) | Não há nada no repositório sobre plano, janela de restauração ou teste de restauração. Não acessei o console do Neon. | Se o plano for gratuito, a janela de restauração é curta (horas) e não há backup lógico fora do Neon. Somado a A-01, a recuperação de desastre não está testada. | Dono confirmar o plano e a janela de restauração no console. Fazer `pg_dump` semanal cifrado fora do Neon e um teste de restauração em um branch. | P |
| O-06 | Credenciais e higiene do repositório | Médio (hipótese) | A varredura do histórico do git não achou segredo real (ver seção 4). Pendentes desde a v3 e não confirmados: rotação da senha do Neon de produção e do token do Mercado Pago, GitHub secret scanning e Dependabot. A senha do banco dev apareceu em um log local na v3. | Se alguma credencial antiga circulou (log, conversa, máquina), ela continua válida até ser rotacionada. | Dono rotacionar a senha do Neon de produção, a do dev e o token do Mercado Pago. Ativar secret scanning e Dependabot no GitHub. | P |
| O-07 | Health check | Baixo | `api/health.js` responde `{ok:true}` se o banco responder, sem checar a configuração. | Um deploy sem a variável do Mercado Pago passa no health. | Ver O-01 item (2). Responder só `ok` e um booleano por verificação, sem nomes nem valores. | P |

## 3. O que foi conferido e está OK

**OWASP Top 10 (2021), item por item:**

- **A01 Controle de acesso:**
  - Todas as ações de `api/customer.js` usam o id da sessão. Testei `customer_id` e `id` na query e no corpo: foram ignorados, e a ação inexistente deu 404.
  - O admin exige sessão (401 sem cookie). Um cookie de cliente não abre o admin.
  - As ações `users`, `user_*`, `shipping_save` e `points_save` são só do papel admin.
  - `order-status` exige um token de 128 bits (só o SHA-256 fica gravado). O código legado de 40 bits devolve apenas `payment_status`.
  - A exceção é a amplitude do papel staff (S-04).
- **A02 Criptografia:**
  - Senhas, respostas e códigos usam scrypt (N=32768). Os tokens de sessão e de acompanhamento ficam gravados só como SHA-256.
  - Os cookies `__Host-` são HttpOnly e Secure. O admin usa SameSite=Strict, 12 h deslizantes e teto de 7 dias. O cliente usa SameSite=Lax e 30 dias fixos (sem renovação).
  - HSTS com preload.
- **A03 Injeção:**
  - Todas as queries são parametrizadas. `buildUpdate` e `buildInsert` usam colunas de listas fixas, e as interpolações são de constantes.
  - No ZAP ativo, 3.485 requisições não acharam SQLi, XSS, path traversal ou RFI.
  - XSS no front: todos os `innerHTML` de `public/app.js` (linhas 225, 227, 294, 340, 550, 566) passam o texto por `esc()` (`& < > ' "`) e usam ids numéricos. Admin e conta usam só `textContent` e `createElement` (`DG.el`, `public/admin/admin.js:9-25`).
  - O QR do Pix é validado como base64 antes do `data:` (`app.js:1176-1178`). A URL do cartão exige `https://`. O link do WhatsApp do admin usa `encodeURIComponent`.
  - Teste de XSS armazenado: os payloads `<script>` e `<img onerror>` ficaram gravados em nome e observações como texto, e não executam nas telas revisadas.
  - A CSP `script-src 'self'` bloqueia script inline.
- **A04 Design inseguro:**
  - O preço é calculado no servidor. Testei `price_cents`, `unit_total_cents` e `total_cents` injetados: foram ignorados, e o total ficou 1800. Quantidade negativa deu 400.
  - O resgate de pontos é atômico: lock + `insert ... where soma >= pontos` (correto em READ COMMITTED).
  - O ledger tem `unique(order_id, kind)`. As mudanças de status são otimistas.
  - Os limites de pedido ficam dentro do próprio INSERT.
- **A05 Configuração:**
  - Os cabeçalhos de `vercel.json` estão completos: CSP restritiva, `frame-ancestors 'none'`, XFO DENY, nosniff, Referrer-Policy e Permissions-Policy.
  - `no-store` em order, webhook e status. O 405 para métodos errados funciona.
  - O dev-server não permite traversal (`/../.env.dev` deu 404).
- **A06 Componentes:** só há uma dependência (`@neondatabase/serverless ^1.0.2`), e o `npm audit` deu 0 vulnerabilidades.
- **A07 Autenticação:**
  - Login com resposta uniforme e tempo igualado (`dummyHash`; testei telefone existente contra inexistente).
  - Lockout do admin conferido: 5 falhas e depois 429. O `recover_question` devolve uma pergunta falsa estável para telefone inexistente.
  - Exceções: S-01, S-02, S-03 e S-07.
- **A08 Integridade:**
  - Webhook com HMAC (`id;request-id;ts`), janela de 300 s e `timingSafeEqual`. O valor é conferido em centavos.
  - A gravação é idempotente: um pagamento recusado não sobrescreve um aprovado. O replay é inofensivo, porque o pagamento é buscado de novo na API do Mercado Pago.
  - Pedido cancelado e depois pago gera aviso na auditoria.
- **A09 Logs:**
  - O log de erro do pedido mascara PII (`api/order.js:510-515`). O 401 do webhook não loga o segredo.
  - Falta o monitoramento (O-01).
- **A10 SSRF:**
  - `api/img.js` aceita só id numérico, e o mime vem do banco. O upload valida os bytes mágicos (só jpeg, png, webp e avif), então não há SVG nem HTML.
  - No frete, os hosts são fixos (ViaCEP, Nominatim, OSRM). O CEP é reduzido a 8 dígitos (testei `01001000/../../x`: virou `01001000`). O endereço vai com `encodeURIComponent` e as coordenadas são numéricas.

**Outros pontos conferidos:**

- CSRF: `sameOrigin` + JSON obrigatório. Testes: sem Origin deu 403, Origin de outro site deu 403, `text/plain` deu 415, em order, admin e customer.
- Os rate limits estão no banco (não em memória) em order, status, frete, CEP, points_preview e nos logins.
- Até 9 funções Vercel (`api/*.js`), dentro do limite de 12.
- A resposta de `order-status` não tem PII.
- `.gitignore` cobre `.env` e `.env.*` (exceto `.env.example`). Nenhum `.env` real entrou no histórico.

## 4. Varredura ativa

**Ambiente:**
- Docker: ausente.
- Java: OpenJDK 17.0.21.
- OWASP ZAP 2.17.0 já instalado em `C:\Program Files\ZAP\Zed Attack Proxy`.
- Servidor `node scripts/dev-server.js 3401` com o banco dev. Foi encerrado no fim, e o daemon do ZAP também.

**O que rodou:**

1. **ZAP quick scan** (`-quickurl http://localhost:3401/`, spider tradicional + ativo):
   - 2 Medium: SRI ausente (S-08) e "Absence of Anti-CSRF Tokens" em `/`. O segundo é falso positivo: não há formulário com POST tradicional, e a defesa é Origin + JSON.
   - 2 Info.
   - O spider tradicional não executa JS, por isso achou poucas URLs.
2. **ZAP em modo daemon:**
   - Alimentado à mão com as URLs da API (`/api/menu`, `/api/store?a=cep|quote`, `/api/order-status?t|code`, `/api/img`, `/api/customer?a=me|questions`, `/api/admin?a=me|orders`, `/api/health`, páginas), depois spider e scan ativo recursivo.
   - 3.485 requisições.
   - Resultado: 0 High, 0 Low, 3 Medium (SRI ×2 e anti-CSRF ×1, os mesmos de antes) e 52 Info (User Agent Fuzzer ×48, Content-Type ausente em 404 de `/api/img`, `robots.txt` e `sitemap.xml`).
   - Nenhum achado de injeção.
3. **Testes manuais com curl** (resultados na seção 3):
   - CSRF: 403 e 415.
   - Autenticação: 401 sem sessão. Lockout do admin: 429 após 5 falhas.
   - IDOR em customer.
   - Traversal em `/api/img` e no dev-server.
   - Injeção no CEP e no `code` do order-status.
   - Adulteração de preço e quantidade.
   - XSS armazenado no pedido e no cadastro.
   - Enumeração no cadastro (confirmada, S-03).
   - Tempo do login do cliente.
   - Webhook sem assinatura ou com assinatura falsa: 401.
   - `npm audit`: 0 vulnerabilidades.
4. **Histórico do git:**
   - `git log --all -p` com regex de `postgres://usuario:senha@`, `APP_USR-<dígitos>`, `TEST-<dígitos>`, `WEBHOOK_SECRET=`, chave privada PEM e o genérico `secret|password|api_key = '<16+>'`.
   - Os 3 únicos acertos são dados fictícios de teste:
     - `9423f5e0 scripts/test-order-limits.js`: senha de cliente de teste.
     - `e64589c0 scripts/test-order-handler.js`: senha de cliente de teste.
     - `e130a2a1 scripts/test-mp-webhook.js`: segredo fictício do teste de HMAC, `****`.
   - Nenhum `.env` real foi adicionado. `.env.example` só tem placeholders.

**Dados de teste no banco dev (prefixo ZZ-a1):**
- Criei 1 cliente `ZZ-a1 Cliente ...` e 1 pedido `ZZ-a1 <script>...` (id 414, DG-7445, retirada, sem pagamento). Gerei tentativas de login do usuário fictício `zz-a1-user` e dos telefones fictícios 11900001234, 11900009999 e 11900005678.
- Removidos: pedido, cliente (sessões e consentimentos em cascata), `login_attempts`, `customer_login_attempts`, e `order_attempts` e `rate_hits` de 127.0.0.1.
- **Ficaram de propósito:** 5 linhas `login_falhou` em `admin_audit` com o usuário `zz-a1-user`. É a trilha de auditoria; não apaguei. Ficaram também as entradas normais de cache de CEP, geocodificação e rota para o CEP 01001000.

**Pendente (como o dono resolve):**
- Scan ZAP **autenticado** (admin e cliente) e fuzzing dos **POST JSON**. O ZAP não descobre essas rotas sozinho. Para fazer: abrir o ZAP Desktop, navegar no site local pelo proxy do ZAP já logado (admin e conta), e rodar "Active Scan" no contexto com a sessão, em `localhost` apenas. Os rate limits no banco devolvem 429 e reduzem a cobertura; para o scan, use um banco dev descartável (branch Neon).
- Rajada de `order-status` (300 por 10 min) e `points_preview` (120 por 10 min): não refiz. Isso já está coberto por `scripts/test-rate-limits.js` e `test-qa-points.js`.
- Confirmar no console: plano e PITR do Neon (O-05); rotação de credenciais, secret scanning e Dependabot (O-06); senha atual do admin (S-01).

## 5. Notas para a v4

**Resgate de pontos por itens, com concorrência:**
- Reaproveitar o padrão atual: `sql.transaction([pg_advisory_xact_lock(1, customerId), insert ... where saldo >= custo])`. Usar a forma de duas chaves (A-07).
- Fazer o INSERT do pedido e a reserva em **uma** instrução ou transação (A-02).
- Teste obrigatório: 10 pedidos paralelos com saldo para 1 devem resultar em exatamente 1 reserva.
- Se o item resgatado tiver estoque ou limite por dia, usar um contador com `update ... set usados = usados + 1 where usados < limite returning`, dentro da mesma transação.

**Cupons e itens de R$ 0 em `order.js`:**
- O cupom precisa de:
  - código normalizado
  - `unique(coupon_id, customer_id)` para "1 por cliente"
  - contador atômico de uso (`where usos < max`)
  - validade conferida no servidor
  - reserva liberada quando o pagamento é recusado ou expira, como já se faz com os pontos
- Desconto sempre calculado no servidor. Proibir que cupom e pontos juntos levem o total abaixo de `MIN_CHARGE_CENTS` (R$ 1,00). Ver como fica com o mínimo do Mercado Pago.
- Item de R$ 0: o Pix e a preferência do Mercado Pago recusam `unit_price` 0. Ou o item vai fora da lista de itens do Mercado Pago (como o desconto agregado de hoje, `order.js:229`), ou o pedido 100% gratuito pula o pagamento com um status próprio (`payment_status='not_required'`), que deve ser tratado em `onPaymentStatus`, no `sweepOrders` e nos relatórios.
- O valor conferido no webhook (`total_cents`) continua sendo o total já com desconto.

**Relatórios do admin com exportação CSV:**
- Restringir a exportação ao papel **admin**.
- Registrar cada exportação em `admin_audit`: quem, período, filtros e número de linhas (S-04).
- **Injeção de CSV:** prefixar com `'` toda célula que comece com `=`, `+`, `-`, `@`, tab ou CR. Testei que nome e observações aceitam `=HYPERLINK(...)`. Colocar a célula entre aspas e dobrar as aspas internas. Usar BOM UTF-8 para o Excel.
- Minimização: o padrão sem telefone e endereço; uma coluna de PII só por opção explícita.
- `Content-Disposition: attachment` e `Cache-Control: no-store`.
- Paginar e limitar o período (ex.: 12 meses) para não estourar o tempo da função.
- Rota: usar o roteador `api/admin.js?a=report_*`. Não criar função nova (o limite é 12 funções, hoje são 9).
- Índice sugerido em A-09.
