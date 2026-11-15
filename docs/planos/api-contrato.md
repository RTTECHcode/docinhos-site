# Contrato da API (Painel v2, fase F2, A2)

Quem usa: A3 (admin), A4 (admin), A5 (admin), A9 (loja), A10 (conta do cliente). Tudo em português do Brasil. Valores em centavos (inteiros). Datas em ISO 8601 UTC (o fuso da loja é America/Sao_Paulo, UTC-3, sem horário de verão). Preço, frete, desconto, pontos e total são calculados SÓ no servidor: o cliente nunca envia esses valores.

## 0. Convenções

- Erros: `{ "error": "mensagem para mostrar à pessoa", "code": "codigo_opcional" }` com o status HTTP certo. Mensagens já são para o cliente final (pt-BR).
- Todas as respostas de `/api/admin`, `/api/order`, `/api/order-status` e `/api/store` vêm com `Cache-Control: no-store`.
- `POST` do admin, da conta do cliente e de `/api/order`: cabeçalho `Content-Type: application/json` e `Origin` igual ao host (senão 415 e 403). O `fetch` do próprio site já manda os dois.
- IP do cliente (limites e bloqueios): `x-real-ip` (preenchido pela Vercel); o primeiro valor do `x-forwarded-for` é só reserva (`auth.clientIp`).
- Limite de funções: 9 arquivos em `api/` hoje (`admin`, `customer`, `health`, `img`, `menu`, `mp-webhook`, `order`, `order-status`, `store`); máximo de 12 no total. A rodada v3 não criou arquivo novo em `api/`: tudo entrou como `?a=` nos endpoints existentes.

## 1. Cardápio público: GET /api/menu

Campos novos (os antigos continuam):

```json
{
  "categories": [{ "id": 1, "name": "Brigadeiros", "products": [
    { "id": 7, "name": "Brigadeiro de Ninho", "description": "...", "priceCents": 800, "imagePath": "x.avif",
      "complements": [{ "id": 3, "name": "Morango", "priceCents": 0, "kind": "additional", "maxQuantity": 1, "groupId": 12 }],
      "groups": [{ "id": 12, "key": "frutas", "label": "Frutas", "minChoices": 0, "maxChoices": 2 }],
      "unavailable": true, "paused": true }
  ]}],
  "settings": { "storeAddress": "...", "deliveryFeeCents": 0, "storePaused": false, "storePausedMessage": "" },
  "store": { "open": true, "reason": null, "reopens_at": null, "next_open_at": null, "closes_at": "2026-11-10T21:00:00.000Z", "message": null },
  "shipping": { "bands": [{ "max_km": 3, "fee_cents": 600 }, { "max_km": 6, "fee_cents": 900 }, { "max_km": 10, "fee_cents": 1400 }], "maxKm": 10, "pickupFeeCents": 0 }
}
```

- Produto pausado (v3 D6): aparece com `unavailable: true` e `paused: true`, SEM `label`. A etiqueta da pausa agora é fixa e fica na tela (a loja escreve o texto; sugestão "volto logo <3"). `settings.defaultPauseLabel` deixou de existir. Não pode ser pedido (o pedido recusa com 400).
- Produto sem preço (`priceCents: null`) e sem nenhum tamanho disponível (A2 rodada 3): também vem com `unavailable: true` e `label: "Consulte pelo WhatsApp"` (este é o único caso com `label`). Antes aparecia como "Consulte", entrava no carrinho por R$ 0,00 e o pedido recusava só no fim.
- Complemento pausado em um produto (vínculo pausado, inclui as opções do "Monte seu copo" e do "Monte seu açaí") (v3 D5) AGORA aparece em `complements` daquele produto com `unavailable: true` (antes sumia). O pedido continua recusando (400 `adicional inválido para este produto`; um tamanho pausado também é recusado). A tela deve mostrar a opção apagada/desabilitada e não deixar escolher. Tamanho (`kind: "size"`) pausado também vem com `unavailable: true`: um produto sem preço próprio só fica `unavailable` se NÃO restar tamanho disponível.
- `store.reason`: `null` (aberta), `"schedule"` (fora do horário) ou `"manual"` (fechada pelo painel ou pausa antiga). `settings.storePaused` continua existindo (true quando fechada por qualquer motivo) por compatibilidade.
- `settings.deliveryFeeCents` é legado: o frete real vem de `shipping.bands`.

## 2. Loja pública: GET /api/store?a=...

Sem login. Só leitura. Outros métodos: 405.

- `a=state` retorna `{ open, reason, reopens_at, next_open_at, closes_at, message, hours: [{ weekday, opens, closes }] }` (weekday 0 = domingo; horas "HH:MM").
- (v3 D8) `a=state` não traz `hours_warning`; sem horário cadastrado a loja pública aparece fechada (`open: false`, `reason: "schedule"`, `next_open_at: null`).
- `a=shipping` retorna `{ bands, max_km, pickup_fee_cents }`.
- `a=cep&cep=06000000` (v3 D3) retorna `{ "cep": "06000000", "street": "Rua X", "district": "Centro", "city": "Osasco", "uf": "SP" }` (campos que o ViaCEP não souber vêm como `""`). Aceita `06000-000`. Usa o ViaCEP, com cache em banco (`cep_cache`): CEP encontrado vale 90 dias; CEP inexistente (404) também fica em cache, por 1 dia (linha com cidade e UF vazias, sem coluna nova). A cotação de frete (`quote` e o pedido) usa o mesmo cache. Teto global de chamadas ao ViaCEP: 60 por minuto somando todos os IPs (escopo `cep_lookup_global`, `ip = 'global'`), checado só antes da chamada externa (resposta vinda do cache não conta). Estourou: 503 `cep_unavailable` com a mesma mensagem genérica. A cotação conta no teto mas nunca é barrada por ele. Erros: 400 `invalid_cep` (não tem 8 dígitos); 404 `cep_not_found` `CEP não encontrado. Confira o número ou preencha o endereço à mão.`; 503 `cep_unavailable` (ViaCEP fora ou teto global; a tela deve deixar preencher à mão); 429 `rate_limited` (mais de 30 consultas do mesmo IP em 10 min, escopo próprio `cep_lookup`, não gasta o limite da cotação).
- `a=quote&cep=06000000&address=Rua X, 100[&number=100]` retorna `{ "km": 4.2, "fee_cents": 900, "faixa": { "max_km": 6, "fee_cents": 900 }, "max_km": 10 }`. Só informativo: o pedido recalcula.
- Erros do `quote`: 400 `invalid_cep` | `invalid_address`; 422 `cep_not_found` | `address_not_found` | `out_of_area` (com `max_km`); 429 `rate_limited` `Muitas consultas de frete. Aguarde alguns minutos.` (mais de 30 cotações do mesmo IP em 10 min, contadas no banco, valem para todas as instâncias); 429 `shipping_busy` `Muitas consultas de frete agora. Tente de novo em instantes.` (teto global de 40 endereços novos por minuto); 503 `origin_unavailable`.
- Ação desconhecida: 404.

## 3. Pedido: POST /api/order

Sem login obrigatório. Com o cookie `__Host-dg_cliente` o pedido é ligado à conta e pode usar pontos.

Corpo:

```json
{
  "customer_name": "Maria Silva", "customer_phone": "11999998888",
  "delivery_method": "delivery", "cep": "06000-000", "address": "Rua das Flores", "number": "100",
  "notes": "sem granulado", "payment_choice": "pix",
  "use_points": 100,
  "items": [{ "product_id": 7, "qty": 2, "size_id": 31, "extras": [{ "id": 3, "qty": 1 }] }]
}
```

(Os nomes exatos dos campos de cliente seguem `validateCustomer` em `api/order.js`, inalterado.) `payment_choice`: `"card"` (padrão) ou `"pix"`. `use_points`: inteiro, múltiplo de 100, opcional. **v4: `use_points` foi removido (400 `points_discount_ended`); ver seção 10.**

Sucesso 201:

```json
{ "id": 41, "code": "DG1A2B3C4D5E", "public_code": "DG-4821", "tracking_token": "<22 caracteres base64url (16 bytes)>",
  "subtotal_cents": 2000, "delivery_fee_cents": 900, "discount_cents": 1000, "points_redeemed": 100, "total_cents": 1900,
  "distance_km": 4.2, "delivery_method": "delivery", "address": "...", "items": [], "payment": { "type": "pix", "id": "...", "qr_code": "...", "qr_code_base64": "...", "expires_at": "..." } }
```

- `public_code` (DG-####) é o código que o cliente vê. Único entre pedidos dos últimos 90 dias.
- `tracking_token` (128 bits) aparece UMA vez, aqui. O banco guarda só o SHA-256. O site deve guardá-lo (ex.: no navegador) e usá-lo em `/api/order-status?t=`.
- `payment` pode ser `null` se o Mercado Pago falhar: o pedido continua válido. `payment.type` = `pix` ou `card` (`{ type, url, id }`).

Erros:

- 400: dados inválidos, item pausado/indisponível, mínimo a pagar (R$ 1,00), `invalid_points`, `invalid_block`, `discount_too_big` (desconto maior que o subtotal é recusado, não cortado).
- 401 `login_required` (pediu pontos sem sessão).
- 409 `insufficient_points`.
- 422 `out_of_area` (com `max_km`), `cep_not_found`, `address_not_found`.
- 423 `points_locked` (recuperação de conta recente: pontos bloqueados 48 h).
- 403 `forbidden_origin`: `Origin` ausente ou diferente do host, ou `Sec-Fetch-Site` de outro site (F5, A1-05). Nenhum pedido é criado.
- 415 `unsupported_type`: corpo sem `Content-Type: application/json` (ex.: `text/plain`) (F5, A1-05).
- 429 `rate_limited` `Muitos pedidos em pouco tempo. Aguarde alguns minutos e tente novamente.`: mais de 20 TENTATIVAS do mesmo IP em 10 min (toda tentativa conta, até as recusadas com 400, 409, 422, 429, 503; 403 e 415 não contam), OU 5 pedidos criados do mesmo telefone, OU 10 pedidos criados do mesmo IP em 10 min (trocar o telefone não burla). Tudo é checado ANTES da consulta de frete (A2). O `code` é novo (antes vinha só `error`).
- 429 `shipping_busy` `Muitas consultas de frete agora. Tente de novo em instantes.` (só entrega, A2): mesmo teto global de endereços novos por minuto do `/api/store?a=quote` (40), checado antes do frete.
- 503 `store_closed`: `{ error, code, store: { open:false, reason, reopens_at, next_open_at, message } }`. 503 `origin_unavailable` (frete indisponível agora).

## 4. Acompanhamento: GET /api/order-status

- `?t=<tracking_token>` retorna a visão pública (sem telefone e sem endereço):

```json
{ "public_code": "DG-4821", "payment_status": "approved", "fulfillment_status": "preparing", "fulfillment_label": "em preparo",
  "delivery_method": "delivery", "total_cents": 1900, "created_at": "...", "accepted_at": "...", "preparing_at": "...",
  "ready_at": null, "awaiting_delivery_at": null, "completed_at": null, "cancelled_at": null }
```

- `?code=DGxxxxxxxxxx` (formato antigo) retorna `{ code, payment_status }`. O `public_code` NÃO serve de chave (adivinhável).
- Token ou código malformado/desconhecido: 404. Outros métodos: 405.
- 429 `rate_limited` (F5, A1-12): mais de 300 consultas do mesmo IP em 10 min (contadas no banco por minuto, tabela `rate_hits`; valem para todas as instâncias da Vercel). A tela deve esperar e tentar de novo mais tarde, sem martelar (a consulta a cada 5 s de uma aba fica em 120).
- Fluxo: `new -> accepted -> preparing -> ready -> awaiting_delivery -> completed`, mais `cancelled`. Rótulos: novo, aceito, em preparo, pronto, aguardando entrega (retirada: "aguardando retirada"), concluído, cancelado. Pronto há mais de 1 h vira concluído sozinho na próxima leitura (sem cron). O valor antigo `delivered` é lido como `completed`.

## 5. Admin: /api/admin?a=<ação>

Cookie de sessão `__Host-dg_admin` (HttpOnly). Toda resposta de sucesso inclui `user: { username, role, weakPassword, needsSecurity }`.

Autenticação e perfis:

- Sem sessão: 401 `Sessão expirada...`. Método errado: 405 (com `Allow`). Ação inexistente: 404.
- `role: admin` só em: `shipping_save`, `users`, `user_create`, `user_toggle`, `user_reset`. Staff recebe 403. O resto vale para admin e staff.
- Portão de segurança: enquanto `needsSecurity` for true (usuário sem pergunta de segurança), TUDO é bloqueado com 403 `{ code: "security_setup_required" }`, exceto `me`, `security_questions`, `security_setup`, `logout`. A tela deve mandar a pessoa cadastrar a pergunta.
- Portão de senha fraca (F5, A1-06): enquanto `weakPassword` for true, TUDO é bloqueado com 403 `{ error: "Troque a sua senha para continuar.", code: "password_change_required" }`, exceto `me`, `password_change`, `logout`, `security_questions`, `security_status`, `security_setup`, `recovery_codes_new`. O portão de segurança vem antes (sem pergunta: primeiro cadastra a pergunta, depois troca a senha). **Pendente no front (admin):** ao receber `password_change_required`, abrir a tela de troca de senha em vez de só mostrar o banner.
- Bloqueio de login (F5, A1-04): 5 erros em 15 min ou 10 em 24 h travam o PAR usuário+IP (o mesmo usuário em outro IP segue livre). 20 erros de um IP em 15 min travam o IP para qualquer usuário. Contra ataque espalhado: 30 erros do usuário em 1 h (somando todos os IPs) barram só IPs sem login certo desse usuário nos últimos 7 dias. Resposta: 429 `Muitas tentativas. Tente mais tarde.` (mesmo com a senha certa).
- Senha atual errada em `password_change`, `security_setup` (troca) e `recovery_codes_new` conta no mesmo bloqueio do login (par usuário+IP): ao travar, 429 `Muitas tentativas. Tente mais tarde.` (F5, A1-07).
- `audit`: para `staff`, os eventos `login_falhou` e `recuperacao_falhou` (têm IP e o usuário digitado) não aparecem; o `admin` vê tudo (F5, A1-08).
- `audit` (A2): evento `pagamento_apos_cancelamento` (usuário `mercadopago`), gravado pelo webhook quando um pedido JÁ CANCELADO recebe pagamento aprovado: `Pedido DG-1234 estava cancelado e recebeu pagamento aprovado (pagamento <id>). Pontos não creditados. Estorne o valor manualmente no Mercado Pago.` Um aviso por pedido + pagamento. Nada é estornado automaticamente.
- `user_reset` (A2): a senha definida pelo admin é provisória: grava `weakPassword: true` e a pessoa cai no portão `password_change_required` no próximo login até trocar. Se o admin redefinir a própria senha, não fica preso.

### 5.1 Ações novas por tema

Ações antigas (login, me, catalog, category_*, product_*, complement_*, link_*, group_*, pin_toggle, store_save, command, command_apply, logout, password_change, audit, users, user_*) continuam como estavam, com uma regra nova (A2 rodada 3): produto ATIVO precisa de preço ou de pelo menos um tamanho (complemento `size` ativo vinculado). `product_save` (criar ou editar, considerando o estado final), `product_toggle` (ligar) e `command_apply` (ligar produto) recusam com 400 `Produto ativo precisa de preço ou de pelo menos um tamanho. Informe o preço, ou deixe o item desligado, vincule os tamanhos e depois ative.` (no `command_apply`, seguido de `Sem preço: <nomes>.`). Produto novo nasce ativo: para criar item com preço só pelo tamanho, crie com `active: false`, vincule os tamanhos e depois ligue. **Sugestão para o front (admin):** produto novo sem preço já vir com "ativo" desligado. `catalog` agora devolve também `paused` e `pause_label` nos produtos, `paused` nos vínculos, `settings.defaultPauseLabel` e `storeState`.

#### Segurança da conta (O9)

| Ação | Método | Corpo | Sucesso | Erros |
|---|---|---|---|---|
| `security_questions` | GET | - | `{ questions: [{ id, text }] }` | - |
| `security_status` | GET | - | `{ security: { set, question_id, question, set_at, codes_left } }` | - |
| `security_setup` | POST | `{ question_id, answer, current_password? }` | `{ ok, codes: ["ABCD-EFGH-JKMN", ...10], codes_notice }` | 400 pergunta fora da lista, resposta curta (mínimo 3), senha atual incorreta (exigida só ao TROCAR uma pergunta já cadastrada); 429 bloqueio |
| `recovery_codes_new` | POST | `{ current_password }` | `{ ok, codes: [10], codes_notice }` | 400 senha incorreta; 429 bloqueio |
| `password_change` | POST | `{ current_password, new_password }` | `{ ok }` (mantém a sessão atual, derruba as outras) | 400; 429 bloqueio (5 senhas atuais erradas) |

Os 10 códigos aparecem UMA vez; o banco guarda só hash. Gerar códigos novos apaga os antigos.

Públicas (sem sessão), só POST:

- `recover_question` com `{ username }` retorna `{ question_id, question }`. Usuário inexistente recebe pergunta falsa estável (não revela existência).
- `recover` com `{ username, answer, code, new_password }` retorna `{ ok: true }`. Falha: 400 `Não foi possível recuperar com esses dados.` (mesma mensagem para qualquer erro). 3 falhas bloqueiam por 1 h por usuário e por IP: a partir da 4ª tentativa, 429 `Muitas tentativas. Tente novamente em 1 hora.` (vale mesmo com dados certos). Sucesso: troca a senha, derruba TODAS as sessões, o código vale uma vez, audita `senha_recuperada`.

#### Pausa de produto (O2)

- `product_pause` POST `{ id, paused: bool }` retorna `{ ok, product: { id, name, paused } }`. 404 produto inexistente. (v3 D6) `pause_label` no corpo é IGNORADO sem erro; a resposta não traz mais `pause_label`.
- `pause_default_label` (v3 D6): OBSOLETA. Continua respondendo `{ ok: true, obsolete: true }` (para telas antigas) e não grava nada. A tela nova deve parar de chamar. `settings.defaultPauseLabel` saiu do `catalog`/`settings` do admin e do cardápio.

#### Horários e estado da loja (O3, O4)

- `store_hours` GET retorna `{ hours: [{ weekday, opens, closes }], timezone: "America/Sao_Paulo", hours_warning }`.
- `store_hours_save` POST `{ hours: [{ weekday: 0-6, opens: "09:00", closes: "18:00" }] }` (várias faixas por dia, no máximo 6) retorna `{ ok, hours, hours_warning }`. 400 formato, fechamento antes da abertura, sobreposição. (v3 D8) Lista vazia é aceita, mas a loja FICA FECHADA e `hours_warning` vem `"no_hours"` (a tela deve avisar: "Sem horário cadastrado: a loja fica fechada"). Com algum horário, `hours_warning` é `null`.
- `store_state` GET retorna `{ hours_warning, state: { open, reason, reopens_at, next_open_at, closes_at, message, hours, schedule_configured, hours_warning }, manual: { closed_until, closed_indefinitely, closed_message, updated_by, updated_at } | null }`.
- `store_close` POST `{ minutes: 1..1440 }` ou `{ indefinite: true }`, mais `message?` retorna `{ ok, state }`. A mensagem exibida ganha " Previsão de reabertura: <quando>." Vence sozinho (sem cron).
- `store_reopen` POST `{}` retorna `{ ok, state }`.

#### Frete por faixas (O5)

- `shipping_get` GET retorna `{ shipping: { bands, max_km, pickup_fee_cents: 0, origin_address, origin: { lat, lon } | null } }`.
- `shipping_save` (só admin) POST `{ bands?: [{ max_km, fee_cents }], origin_address? }` retorna `{ ok, shipping, warning? }`. Faixas: crescentes, `max_km > 0`, `fee_cents` inteiro >= 0. Valores padrão: até 3 km R$ 6,00; até 6 km R$ 9,00; até 10 km R$ 14,00 (exemplo até o Renan definir). Retirada sempre R$ 0.

#### Pedidos (O6, O7)

Objeto de pedido (admin): `id, code, public_code, customer_name, customer_phone, delivery_method, address, items, subtotal_cents, delivery_fee_cents, discount_cents, points_redeemed, total_cents, distance_km, payment_method, payment_status, fulfillment_status, fulfillment_label, notes, created_at, accepted_at, preparing_at, ready_at, awaiting_delivery_at, completed_at, cancelled_at, cancel_reason, customer_id`.

- `orders` GET `?f=<status|paid>&s=<busca>` retorna `{ orders: [...], window_hours: 24 }`: só pedidos com menos de 24 h, de todos os status (até 200). `f`: `new|accepted|preparing|ready|awaiting_delivery|completed|cancelled|delivered|paid`. `s` busca em código, DG-#### e nome.
- `order_history` GET `?from=AAAA-MM-DD&to=AAAA-MM-DD&f=&s=&page=1&page_size=20` retorna `{ orders, page, page_size, total, total_pages }`: só pedidos com MAIS de 24 h; datas no fuso de São Paulo; `page_size` máximo 100. 400 data inválida.
- `order_status` POST `{ id, status, reason? }` retorna `{ ok, order: { id, code, public_code, fulfillment_status, fulfillment_label } }`. Só avança (pode pular etapas), nunca volta (409 com mensagem em português); cancelar vale até concluir; pedido concluído ou cancelado não muda mais (409). `delivered` é aceito como `completed`. Cancelar devolve os pontos reservados se o pedido não foi pago. Repetir o mesmo status é aceito sem efeito. 404 pedido inexistente.

#### Sinônimos (O8) — REMOVIDO na v4 (ver 10.0 e 10.8)

- `synonyms` GET retorna `{ synonyms: [{ id, canonical, synonym }] }` (sementes: oreo = biscoito oreo, morango = morangos).
- `synonym_save` POST `{ id?, canonical, synonym }` retorna `{ ok, synonym }`. Sem `id` cria; com `id` edita. 400 curto demais, iguais, duplicado.
- `synonym_delete` POST `{ id }` retorna `{ ok }`. 404.

#### Pausa em lote por ingrediente, reativar e desfazer (O8)

Fluxo da tela: digitar o ingrediente, ver a PRÉVIA, marcar o que vale, CONFIRMAR. Nada muda antes do `confirm: true`. O que vale para os complementos do "Monte seu copo" e do "Monte seu açaí": eles são vínculos produto-complemento (com grupo), então entram em `links` e a pausa vale só naquele produto.

`pause_preview` POST `{ term }` (só lê). A busca ignora acento e maiúsculas, tolera plural e usa os sinônimos.

```json
{ "ok": true, "term": "morango", "terms": ["morango", "morangos"],
  "products": [{ "id": 7, "name": "Torta de Morango", "matched_in": "nome", "matched_term": "morango", "active": true, "paused": false, "builder": false },
               { "id": 9, "name": "Monte seu copo", "matched_in": "descrição", "matched_term": "morango", "active": true, "paused": false, "builder": true }],
  "complements": [{ "id": 3, "name": "Morango", "matched_term": "morango", "active": true,
                    "links": [{ "product_id": 9, "product_name": "Monte seu copo", "group_label": "Frutas", "paused": false }] }],
  "summary": { "products": 2, "complements": 1, "links": 1 } }
```

`builder: true` marca produto "monte seu..." (tem grupos de escolha). Cuidado na tela: um produto assim aparece por causa da descrição; o certo é pausar o complemento (vínculo), não o produto inteiro. Sugestão: deixar o produto `builder` desmarcado por padrão.

`pause_apply` POST. Exige `confirm: true` e `term`:

```json
{ "term": "morango", "confirm": true,
  "product_ids": [7], "links": [{ "product_id": 9, "complement_id": 3 }] }
```

Sucesso:

```json
{ "ok": true, "batch_id": 15, "term": "morango", "products_changed": 1, "links_changed": 1,
  "shared_with_other_batches": 0, "already_paused": 0,
  "warnings": [{ "product_id": 9, "product_name": "Monte seu copo", "group_label": "Frutas", "message": "Todas as opções de \"Frutas\" em \"Monte seu copo\" estão pausadas e a escolha é obrigatória: o produto não poderá ser pedido." }] }
```

- Só pausa. `paused: false` ou sem `term` retorna 400 (para reativar use `resume_*` ou `pause_undo`).
- `batch_id` identifica o lote (guarde para o botão Desfazer). É `null` quando nada mudou (tudo já estava pausado, sem lote vazio).
- O lote grava só o que ESTA aplicação mudou. O que já estava pausado antes (pausa manual) NÃO entra: nunca volta por reativação em lote. `already_paused` conta esses.
- Item já pausado por OUTRO lote aberto entra no lote como compartilhado (`shared_with_other_batches`): só volta quando todos os lotes que o seguram forem liberados.
- `warnings` só aparece quando um grupo de escolha obrigatória (mínimo maior que 0) ficou sem nenhuma opção ativa.
- (v3 D6) `pause_label` no corpo é ignorado sem erro; lotes novos não gravam etiqueta, e desfazer/reativar não restauram etiqueta.
- Erros: 400 sem confirmação, lista vazia ou inválida; ids inexistentes são ignorados (contam em `already_paused`).

`resume_preview` POST `{ term }` (só lê). Procura lotes ABERTOS do termo (com sinônimos): "voltou morango" acha o lote de "morango" e de "morangos".

```json
{ "ok": true, "term": "morango", "terms": ["morango", "morangos"],
  "batches": [{ "id": 15, "term": "morango", "created_by": "gigi", "created_at": "..." }],
  "will_resume": [{ "type": "link", "product_id": 9, "complement_id": 3, "name": "Morango em Monte seu copo" }],
  "keep_paused": [{ "type": "product", "product_id": 7, "complement_id": null, "name": "Torta de Morango e Oreo", "held_by": ["oreo"] }],
  "already_active": [],
  "summary": { "resume": 1, "keep_paused": 1, "already_active": 0 } }
```

- `will_resume`: itens do lote que ainda estão pausados e mais nenhum lote aberto segura.
- `keep_paused` com `held_by`: item que também está em lote aberto de OUTRO termo (ex.: torta com morango e oreo). A tela deve dizer: "continua pausado até liberar: oreo".
- `already_active`: alguém já reativou à mão (não é tocado).
- Sem lote aberto: `batches: []` e `message: "Não há pausa em lote aberta para esse ingrediente."` (status 200).

`resume_apply` POST `{ term, confirm: true }` retorna `{ ok, term, batches_released: [15], products_resumed, links_resumed, will_resume, keep_paused, already_active, summary }`. Marca `released_at` nos lotes do termo (mesmo com itens ainda segurados por outro termo: esses voltam quando o outro lote for liberado). Produto reativado recupera a etiqueta que tinha antes da pausa em lote. 400 sem `confirm`; 404 sem lote aberto para o termo.

`pause_undo` POST `{ batch_id }` (botão Desfazer logo após pausar) retorna `{ ok, batch_id, term, products_resumed, links_resumed, will_resume, keep_paused, already_active, summary }`. Mesmas regras de itens compartilhados. 400 id inválido; 404 lote inexistente; 409 `Esse lote já foi desfeito.`

`pause_batches` GET `?all=1` (opcional) retorna `{ batches: [{ id, term, created_by, created_at, released_at, released_by, products, links }] }`: lotes abertos (ou os 50 mais recentes com `all=1`).

Caixa de comandos (`command`, POST `{ text }`): se o texto tem um verbo de reativar ("voltou morango", "reativar morango") e existe lote aberto do ingrediente, a resposta é a prévia da reativação em lote:

```json
{ "ok": true, "kind": "ingredient_resume", "action": "resume", "term": "morango",
  "apply": { "a": "resume_apply", "body": { "term": "morango", "confirm": true } },
  "batches": [], "will_resume": [], "keep_paused": [], "already_active": [], "summary": {} }
```

Mostre a prévia e, ao confirmar, envie `apply.body` para `apply.a`. Sem lote aberto, o comando segue o fluxo antigo (`command_apply`), inalterado.

Auditoria: `pausa_em_lote`, `retomada_em_lote`, `pausa_em_lote_desfeita`, `pedido_status`, `senha_recuperada` etc. em `audit`.

## 6. Funções de domínio para o A10 (conta do cliente)

NÃO existe `api/customer.js` ainda: o A10 cria a rota HTTP e chama estas funções. Todas recebem `sql` (de `api/_lib/db`, com `sql.query`) como primeiro argumento. Erros: `CustomerError { status, code, message }` (também `auth.AuthError`, `loyalty.LoyaltyError`, todos com `status`, `code` e mensagem em pt-BR; responda `status` e `{ error, code }`).

Cookie: `__Host-dg_cliente` (HttpOnly, Secure, SameSite=Lax, Path=/, 30 dias). A rota deve conferir `auth.sameOrigin(req)` e `auth.isJsonType(req)` nos POST e mandar `Cache-Control: no-store`. `ctx = { ip: auth.clientIp(req), ua: req.headers['user-agent'], source? }`.

`api/_lib/customer.js`:

| Função | Uso | Retorno / erros |
|---|---|---|
| `createAccount(sql, { name, phone, email?, password, security_question, security_answer, whatsapp_consent?, birth_day?, birth_month? }, ctx)` | cadastro (já abre sessão) | `{ customer, token }`; 400 validação; 409 `duplicate`. Pergunta e resposta são obrigatórias. `whatsapp_consent` só vale `true` explícito (nunca pré-marcado); aceite grava texto, versão, data, IP e evento. Telefone vira E.164 (+55...). |
| `login(sql, { phone, password }, ctx)` | entrar | `{ customer, token }`; 401 `bad_login`; 429 `locked` (A2: 5 erros em 30 min = 30 min e 10 em 24 h = 24 h, pelo PAR telefone+IP; 5 erros de um IP em 30 min travam o IP; 10 erros no telefone em 1 h, somando IPs, barram os IPs que nunca entraram nessa conta) |
| `getSession(sql, req)` | cliente da requisição | `{ customer, tokenHash }` ou `null` |
| `sessionCookie(token)` / `clearSessionCookie()` | valor do `Set-Cookie` | string |
| `logoutFromRequest(sql, req)` | sair | devolve o `Set-Cookie` que limpa |
| `recoveryQuestion(sql, { phone })` | tela de recuperar | `{ question_id, question }` (falsa e estável se o telefone não existe) |
| `recover(sql, { phone, answer, new_password }, ctx)` | recuperar | `{ ok, points_locked_until }`; 400 `bad_recovery` (genérico); 429 `locked` (mesmas regras do login, com contagem própria). Derruba todas as sessões e trava o resgate de pontos por 48 h. |
| `getProfile(sql, id)` / `customerView(row)` | perfil | `{ id, name, phone, email, whatsapp_consent, whatsapp_consent_at, whatsapp_opt_out_at, whatsapp_confirmed_at, birth_day, birth_month, points_locked_until, security_question_id, security_question, created_at }` |
| `updateProfile(sql, id, { name?, email?, birth_day?, birth_month? })` | editar | perfil; 409 e-mail em uso |
| `changePassword(sql, id, { current_password, new_password }, keepTokenHash)` | trocar senha | `{ ok }`; derruba as outras sessões (passe `tokenHash` da sessão atual) |
| `changeSecurity(sql, id, { current_password, security_question, security_answer })` | trocar pergunta | `{ ok }` (exige a senha atual) |
| `setWhatsappConsent(sql, id, boolean, ctx)` | ligar/desligar WhatsApp | perfil; grava evento `opt_in`/`opt_out`; sem mudança não grava |
| `listOrders(sql, id, { limit, offset })` | meus pedidos | lista com `public_code`, status, `items`, valores (sem telefone/endereço); limite 50 |
| `getPoints(sql, id, { limit })` | meus pontos | `{ balance, reserved, earned_total, locked_until, points_per_real: 1, block_points: 100, block_value_cents: 1000, history: [{ id, kind, points, note, created_at, public_code }] }` |
| `normalizePhone(input)` | telefone E.164 ou `null` | |
| `SECURITY_QUESTIONS`, `CONSENT_TEXT`, `CONSENT_VERSION`, `COOKIE_NAME`, `SESSION_TTL_S` | constantes | mostrar `CONSENT_TEXT` ao lado da caixa de WhatsApp (caixa vem DESMARCADA) |

`api/_lib/loyalty.js` (pontos; saldo = soma do `loyalty_ledger`):

- Ganho: 1 ponto por R$ 1,00 do subtotal pago (sem frete, depois do desconto, arredonda para baixo), só quando o pagamento é aprovado. Resgate: blocos de 100 pontos = R$ 10,00; desconto nunca passa do subtotal; mínimo a pagar R$ 1,00.
- Puras: `earnPoints(subtotal, desconto)`, `discountForPoints(pontos)`, `maxRedeemablePoints(subtotal, saldo)`, `validateRedemption({ points, subtotalCents, balance, lockedUntil })` (lança `LoyaltyError`: `invalid_points`, `invalid_block`, `points_locked`, `insufficient_points`, `discount_too_big`).
- Banco: `getBalance`, `listLedger`, `reserve`, `releaseReserve(sql, orderId, nota)`, `onPaymentStatus(sql, orderId)` (chamada pelo webhook), `adjust(sql, { customerId, points, note })`. Reserva não paga volta sozinha depois de 24 h (na leitura do saldo). Tipos de linha: `earn`, `redeem_reserve`, `redeem_release`, `redeem_commit`, `reversal`, `adjust`.

`api/_lib/auth.js` (compartilhado): `hashPassword`/`verifyPassword` (scrypt N=32768, r=8, p=1), `validatePassword` (8 a 128), `hashAnswer`/`verifyAnswer`/`normalizeAnswer`/`validateAnswer`, `SECURITY_QUESTIONS`, `validateQuestionId`, `fakeQuestionFor`, `generateRecoveryCodes`/`matchRecoveryCode`, `evaluateAttemptLock`, `parseCookies`, `buildCookie`, `clientIp`, `sameOrigin`, `isJsonType`, `newToken`, `sha256`.

## 7. Banco (aditivo; `scripts/schema.sql` é o estado final)

Migração: `node scripts/migrate-2026-11-10-painel-v2.js` (idempotente; nada é apagado ou renomeado).

F5: `node scripts/migrate-2026-11-10-scopes.js` (idempotente, aditiva; rodar ANTES do deploy do código da F5): amplia o CHECK de `customer_login_attempts.scope` para `login`, `recover`, `register` (cadastro, por IP) e `password` (senha atual errada na troca); cria `orders.client_ip` (limite de pedidos por IP; não aparece em nenhuma resposta). Linhas antigas com chave falsa na coluna `phone` (`#cadastro`, `#senha:+55...`) continuam sendo lidas nas mesmas janelas (até 48 h) e depois deixam de importar. Novas tabelas: `store_hours`, `store_state`, `ingredient_synonyms`, `ingredient_pause_batches`, `ingredient_pause_items`, `geocode_cache`, `route_cache`, `customers` e tabelas de sessão/pontos/consentimento, `admin_recovery_codes`, `admin_recovery_attempts`. Colunas novas: `products.paused/pause_label`, `product_complements.paused`, `orders.public_code/tracking_token_hash/…_at/discount_cents/points_redeemed/distance_km/customer_id`, `admin_users.security_*`.

A2: `node scripts/migrate-2026-11-10-order-attempts.js` (idempotente, aditiva; rodar ANTES do deploy): cria `order_attempts (id, ip, at)` com índice `(ip, at)`. Uma linha por tentativa de pedido; o próprio `/api/order` apaga, de vez em quando, linhas com mais de 1 dia.

v3 (A2): rodar ANTES do deploy do código da v3, nesta ordem (ambas idempotentes e não destrutivas; `node --env-file=.env ...` em produção, só com ordem do Renan; em desenvolvimento `node -r ./scripts/dev-env.js ...`):

1. `scripts/migrate-2026-11-10-v3-schema.js`: colunas de endereço em `customers` (`address_cep`, `address_street`, `address_number`, `address_complement`, `address_district`, `address_city`, todas `text` nulas) e tabela `cep_cache (cep pk, logradouro, bairro, localidade, uf, created_at)`. O código novo falha sem elas.
2. `scripts/migrate-2026-11-10-v3-categoria-familia.js`: renomeia a categoria "Sobremesas tamanho família" para "Para família" (só renomeia; ids e produtos iguais).

Colunas `products.pause_label`, `ingredient_pause_batches.pause_label`, `ingredient_pause_items.prev_pause_label` e a chave `settings.default_pause_label` ficam no banco, OBSOLETAS (ninguém lê nem grava; nada foi apagado).

## 8. Decisões e pontos de atenção

- Usuário criado em `user_create` não tem pergunta: cadastra no primeiro login (portão `security_setup_required`).
- `password_change` mantém a sessão atual e derruba as outras; recuperação derruba todas.
- Histórico = pedidos com mais de 24 h; o dia nos filtros é o de São Paulo.
- Desconto maior que o subtotal é recusado (400), não cortado. Mínimo a pagar R$ 1,00.
- (v3 D8) Sem horário cadastrado = FECHADA (`reason: "schedule"`, `next_open_at: null`). Dia sem faixa = fechado naquele dia. Fechamento manual vence a agenda, sempre. Texto antigo "Nenhum horário cadastrado: a loja fica aberta o tempo todo" (`public/admin/admin-settings.js`) está errado agora: A3/A4 devem trocar e usar `hours_warning`.
- `shipping_save` é só do admin; a equipe (staff) pausa, fecha a loja e edita horários.
- O parser de comandos (`command`) não usa sinônimos; a busca com sinônimos é o fluxo `pause_preview`/`pause_apply`. Exceção: o verbo de reativar abre a prévia de lote quando há lote aberto.
- Complementos do "Monte seu copo" e do "Monte seu açaí" são pausados por vínculo (`links`), sempre só no produto escolhido. Pausar a opção em todos os produtos exige marcar todos os vínculos da prévia.
- Reativar em lote nunca mexe no que já estava pausado antes do lote nem no que foi pausado à mão depois.
- Tentativas de recuperação do admin têm tabela própria (`admin_recovery_attempts`) e não afetam o bloqueio de login.

## 9. Conta do cliente e carrinho: /api/customer?a=... (v3, A2)

Mesmas convenções de `/api/customer` (sessão por cookie, `no-store`, POST com `Content-Type: application/json` e `Origin`). Erros: `{ error, code }`. Nenhum dado pessoal é registrado em log; só o dono da sessão vê e altera o próprio endereço (o corpo nunca escolhe a conta).

Objeto `address` (entrada e saída): `{ cep, street, number, complement, district, city }`. Limites validados no servidor: `cep` com 8 dígitos (aceita `06000-000`; sai sempre só com dígitos), `street` 3 a 120, `number` 1 a 10, `complement` até 60, `district` até 80, `city` até 80, sem caracteres de controle; espaços repetidos viram um só. Opcionais vazios saem como `""`.

- `address` GET: retorna `{ address }` (`address: null` se a conta não tem). 401 `login_required`.
- `address_save` POST: corpo `{ address: {...} }` ou os campos soltos. Troca o endereço salvo. Retorna `{ ok: true, address }`. 400 `invalid_cep` (CEP sem 8 dígitos) ou `invalid_address` (rua/número/limites); 401 `login_required`. Em erro nada é gravado.
- `address_clear` POST `{}`: apaga o endereço salvo. Retorna `{ ok: true, address: null }`. 401.
- `register` POST agora aceita `address` OPCIONAL (mesmo formato). Ausente ou todo em branco = conta sem endereço. Endereço inválido recusa o cadastro com 400 (`invalid_cep` ou `invalid_address`) e NÃO cria a conta. Conta e endereço são gravados no mesmo INSERT (um comando só, sem estado intermediário).
- `prefill` GET (D2): para o checkout. Visitante: `{ logged_in: false }`. Logado: `{ logged_in: true, name, phone, phone_national, address }` (`phone` em E.164, `phone_national` só com DDD e número, `address` ou `null`). Sempre `Cache-Control: no-store`. Nunca devolve dados de outra conta.
- `points_preview` POST (D4): prévia de pontos do carrinho, para visitante e logado. Corpo `{ items: [{ product_id, qty, size_id?, extras?: [{ id, qty }] }], use_points?: inteiro }` (mesmo formato do pedido; preço e adicionais vêm do servidor, valores do cliente são ignorados). Retorna `{ points, enabled, rules: { enabled, points_per_real, block_points, block_value_cents }, subtotal_cents }`. `points` = o que o pedido pago renderia (mesma regra do pedido: `earnPoints(subtotal, desconto)`; frete não conta). `use_points` (múltiplo do bloco) só abate o desconto do resgate no cálculo; não confere saldo; valor inválido é ignorado. Programa de pontos desligado: `{ points: 0, enabled: false, rules, subtotal_cents: null }`. 400 `invalid_items` (carrinho vazio: `O carrinho está vazio.`; mais de 30 itens: `O carrinho tem itens demais (máximo 30).`; produto/tamanho/adicional inexistente ou pausado, quantidade inválida; a mensagem diz o que corrigir). 429 `rate_limited` `Muitas consultas de pontos. Aguarde alguns minutos.`: mais de 120 prévias do mesmo IP em 10 min (escopo próprio `points_preview` em `rate_hits`, vale para todas as instâncias).

Resumo das ações novas de outros endpoints: `GET /api/store?a=cep` (seção 2); no admin, `hours_warning` em `store_hours`, `store_hours_save` e `store_state` (seção 5.1); `pause_default_label` obsoleta.

## 10. v4 (A2, F2)

Vale tudo das seções 0 a 9, com as mudanças abaixo. Esta seção é a fonte para A3 (painel) e A4 (loja). Valores em centavos, datas ISO 8601 UTC, erros `{ error, code }`. Preço, frete, desconto, cupom, pontos e total são SEMPRE do servidor: a tela só mostra.

### 10.0 O que saiu (não usar mais)

- `use_points` em `POST /api/order`: qualquer valor diferente de ausente, `null`, `0` ou `false` = **400 `points_discount_ended`** (`O desconto com pontos foi substituído pelo Clube: troque seus pontos por um prêmio.`). O saldo continua e vale para os prêmios do Clube (10.2).
- `use_points` em `points_preview` (seção 9): ignorado. A prévia calcula sem desconto e sem cupom.
- Sinônimos (seção 5.1, "Sinônimos (O8)"): `synonyms`, `synonym_save` e `synonym_delete` foram REMOVIDOS (agora 404 `Ação não encontrada.`). A busca da pausa em lote mudou (10.8).
- `blockPoints`/`blockValueCents` do bloco `points` do `/api/menu` ficam só por compatibilidade. Não mostrar "desconto por pontos".

### 10.1 Status único do pedido (N1)

Todo objeto de pedido (acompanhamento, "Meus pedidos", painel) ganha `status_key` e `status_label`. A tela mostra `status_label` e usa `status_key` para cor/ícone. Nenhum valor gravado mudou (`payment_status` e `fulfillment_status` continuam).

| `status_key` | `status_label` | Quando |
|---|---|---|
| `awaiting_payment` | Aguardando pagamento | preparo `new` e pagamento pendente/sem pagamento |
| `payment_failed` | Pagamento não concluído | preparo `new` e pagamento `rejected`, `cancelled` ou `expired` |
| `refunded` | Pagamento estornado | preparo `new` e pagamento `refunded` ou `charged_back` |
| `received` | Pedido recebido | preparo `new` e pagamento `approved` |
| `accepted` | Pedido aceito | preparo `accepted` |
| `preparing` | Em preparo | preparo `preparing` |
| `ready` | Pronto | preparo `ready` |
| `awaiting_delivery` | Saiu para entrega (retirada: `Pronto para retirada`) | preparo `awaiting_delivery` |
| `completed` | Concluído | preparo `completed` (ou `delivered` antigo) |
| `cancelled` | Cancelado | preparo `cancelled` (vence tudo) |

### 10.2 Clube por prêmios (N3)

**Vitrine pública:** `GET /api/menu` ganha `club`:

```json
"club": { "enabled": true, "points_per_real": 1,
  "rewards": [{ "id": 3, "product_id": 80, "name": "Brigadeiro", "size_name": null, "image_path": "/images/...", "points_cost": 60, "max_per_order": 1, "available": true }] }
```

Só prêmios ligados, dentro da vigência e com produto/categoria ativos. `available: false` = aparece, mas não pode ser trocado agora (produto pausado, tamanho fora, etc.). `enabled: false` = Clube pausado (mostrar aviso, não deixar trocar).

**Conta:** `GET /api/customer?a=club` (logado; 401 `login_required`):

```json
{ "club": { "balance": 120, "reserved": 0, "locked_until": null, "enabled": true, "points_per_real": 1,
  "rewards": [{ "...": "mesmos campos da vitrine", "missing_points": 0, "can_redeem": true }] } }
```

`missing_points` = quanto falta. `can_redeem` = disponível + Clube ligado + sem bloqueio de 48 h + saldo suficiente. `locked_until` (ISO) = troca bloqueada até essa hora (recuperação de conta).

**Pedido:** `POST /api/order` aceita `rewards: [{ "reward_id": 3, "qty": 1 }]` (até 10 linhas, sem repetir `reward_id`, `qty` de 1 a `max_per_order`). O prêmio entra em `items` com `reward: true, reward_id, points_cost, unit_total_cents: 0`. Regras e erros (nessa ordem):

- 400 `invalid_rewards` (formato), `reward_unavailable` (prêmio desligado, fora da vigência, pausado), `reward_max_per_order`.
- 400 `reward_min_subtotal`: precisa de pelo menos R$ 1,00 em itens PAGOS (só prêmio, ou carrinho vazio com prêmio, é recusado). Mensagem: `Para trocar pontos por um prêmio, o pedido precisa ter pelo menos R$ 1,00 em outros produtos.`
- 401 `login_required` (prêmio sem sessão).
- 409 `points_disabled` (Clube pausado).
- 423 `points_locked` com `locked_until`.
- 409 `insufficient_points` (saldo menor que a soma dos prêmios). Também quando dois pedidos simultâneos disputam o mesmo saldo: só um passa.
- Resposta 201 ganha `club_points` (pontos gastos no pedido), `coupon_code`, `coupon_discount_cents`; `points_redeemed` é sempre 0. `items` inclui os prêmios.
- Ciclo dos pontos: reserva ao criar o pedido (sai do saldo na hora), confirma no pagamento aprovado, devolve se o pagamento falhar/expirar ou se o pedido for cancelado. Cancelar pedido PAGO no painel também devolve (10.7).

**Extrato** (`GET /api/customer?a=points`): novos `kind`: `reward_reserve` (`Prêmio do Clube no pedido DG-1234`), `reward_release` (`Pontos do prêmio devolvidos (pedido DG-1234 não foi pago)`), `reward_commit` (`Prêmio confirmado no pedido DG-1234 (pagamento aprovado)`, 0 pontos). Mostrar `description`.

**Painel (Clube):**

- `club_rewards` GET (qualquer usuário): `{ rewards: [...], rules: { enabled, points_per_real, block_points, block_value_cents } }`. Prêmio do painel: `{ id, product_id, product_name, category_name, size_complement_id, size_name, points_cost, max_per_order, active, starts_at, ends_at, sort_order, state, available, product_paused, product_active, created_at, updated_at }`. `state`: `on`, `off`, `scheduled` (começa depois), `ended` (vigência acabou).
- `club_reward_save` POST (só admin) `{ id?, product_id, size_complement_id?, points_cost, max_per_order?, active?, starts_at?, ends_at?, sort_order? }` retorna `{ ok, reward }`. Sem `id` cria. `points_cost` 1 a 100000; `max_per_order` 1 a 10 (padrão 1); `sort_order` 0 a 9999; datas ISO ou `AAAA-MM-DD` (dia de São Paulo; fim = 23:59:59); `active` padrão true. Erros 400: `invalid_product`, `invalid_cost`, `invalid_max`, `invalid_date`, `invalid_window`, `required_group` (produto com escolha obrigatória não pode ser prêmio), `size_required` (produto com tamanhos: escolha um), `invalid_size`. 404 `not_found`. Sem apagar: desligue.
- `club_reward_toggle` POST (só admin) `{ id, active? }` (omitido = inverte) retorna `{ ok, reward }`.
- Ligar/desligar o Clube e `points_per_real` continuam em `points_get`/`points_save` (F3: `points_save` aceita só esses dois campos; ver 10.14).
- No dev há 3 prêmios de exemplo DESLIGADOS.

### 10.3 Cupons (N6)

**Loja:** `POST /api/customer?a=coupon_check` (visitante ou logado) `{ code, items: [...mesmo formato do pedido], rewards?: [...] }` retorna

```json
{ "ok": true, "coupon": { "code": "GIGI10", "kind": "percent", "value": 10, "stacks_with_club": false, "expires_at": null },
  "subtotal_cents": 5000, "discount_cents": 500 }
```

- É só prévia: o pedido valida e reserva de novo. Subtotal recalculado no servidor (itens pagos; prêmio vale R$ 0).
- Limite por cliente na prévia usa só o telefone da conta (logado). F5-S-08: `phone` de visitante é ignorado (não revela uso de telefone de outra pessoa); para visitante o limite por pessoa é conferido no pedido.
- `kind`: `percent` (`value` = %) ou `fixed` (`value` = centavos). Desconto só nos produtos, nunca no frete; os produtos ficam com pelo menos R$ 1,00.
- Erros: 400 `invalid_coupon` (`Cupom inválido ou indisponível.`: não existe, desligado, fora da validade), `coupon_min_order`, `coupon_not_stackable` (não acumula com prêmio), `coupon_no_discount`, `invalid_items`; 409 `coupon_exhausted`, `coupon_customer_limit`; 429 `rate_limited` (mais de 20 consultas do mesmo IP em 10 min).

**Pedido:** `POST /api/order` aceita `coupon_code`. Mesmos erros acima (status iguais). A contagem de usos e a reserva acontecem na mesma transação do pedido: com `max_uses` = N, nunca passam N pedidos, mesmo simultâneos. `discount_cents` = desconto do cupom; `coupon_discount_cents` igual; `coupon_code` normalizado (maiúsculas). Uso volta a ficar livre se o pagamento falhar, expirar, 24 h sem pagar ou pedido cancelado.

**Painel (tudo só admin; staff recebe 403):**

- `coupons` GET: `{ coupons: [{ id, code, kind, value, min_order_cents, starts_at, expires_at, max_uses, max_uses_per_customer, active, stacks_with_club, note, created_by, created_at, uses_reserved, uses_committed, discount_committed_cents, state }] }`. `state`: `on`, `off`, `scheduled`, `expired`.
- `coupon_save` POST `{ id?, code (só ao criar), kind, value, min_order_cents?, starts_at?, expires_at?, max_uses?, max_uses_per_customer?, active?, stacks_with_club?, note? }` retorna `{ ok, coupon }`. `code`: 3 a 20 letras, números ou hífen (vira maiúscula); não muda depois (400 `code_locked`). `value`: percent 1 a 100, fixed 1 a 1.000.000 centavos. Limites vazios = sem limite. Erros 400 `invalid_kind`, `invalid_value`, `invalid_code`, `invalid_field`, `invalid_date`, `invalid_window`; 409 `code_taken`; 404 `not_found`.
- `coupon_toggle` POST `{ id, active? }` retorna `{ ok, coupon }`.
- `coupon_audience` POST `{ coupon_id, audience }` retorna `{ ok, audience, count, capped, preview: [{ customer_id, name }] }` (até 10 nomes). `audience`: `{ type: "all" }`, `{ type: "bought_within", days }`, `{ type: "inactive_for", days }` (`days` 1 a 3650), `{ type: "spent_over", cents }`. Só contas com consentimento de WhatsApp ativo. Compras = pagas e não canceladas. 400 `invalid_audience`.
- `coupon_campaign_create` POST `{ coupon_id, audience }` grava a lista e retorna `{ ok, campaign_id, count, audience, created_at }`. Máximo 5000 clientes.
- `coupon_campaign` GET `?id=<campanha>` retorna `{ ok, campaign: { id, coupon_id, coupon_code, audience, created_by, created_at }, targets: [{ customer_id, name, phone, message, sent_at, sent_by }] }`. `?coupon_id=<cupom>` (sem `id`) lista: `{ ok, campaigns: [{ id, audience, created_by, created_at, total, sent }] }`. `message` vem pronta; a tela monta o link `https://wa.me/<phone só dígitos>?text=<encodeURIComponent(message)>` e abre num toque (nada é enviado automaticamente).
- `coupon_target_sent` POST `{ campaign_id, customer_id, sent?: true|false }` retorna `{ ok, sent_at }` (`null` ao desmarcar).
- Tudo grava `admin_audit`.

### 10.4 Avaliação no Google e mimo (N8)

**Loja:** `GET /api/order-status?t=` ganha `post_payment`: `{ review_url, instagram_url }` só com pagamento aprovado e pedido não cancelado; senão `null`. `review_url` `null` = bloco de avaliação desligado. `instagram_url` `null` = sem botão. **O cliente nunca vê o mimo**: nenhum campo de mimo vai para a loja.

**Painel:**

- Objeto de pedido em `orders` e `order_history` ganha `gift`: `{ id, label }` quando o telefone tem mimo pendente concedido ANTES deste pedido (e não pelo próprio pedido); senão `null`. Mostrar destaque "Mimo: 1 brigadeirinho" no pedido. Ao concluir o pedido (`order_status` -> `completed`, ou conclusão automática), o mimo vira entregue sozinho.
- `gift_grant` POST `{ order_id }` (qualquer usuário: botão "Cliente avaliou" no pedido) ou `{ phone }` (só admin, tela de clientes). Retorna `{ ok, gift: { id, label, granted_at } }`. Erros: 400 `invalid_order`, `invalid_phone`; 404 `not_found`; 409 `order_cancelled`, `gift_pending` (já tem um pendente: 1 por telefone); 403 staff com `phone`.
- `gift_cancel` POST `{ id }` (qualquer usuário) retorna `{ ok, gift: { id } }`. 404 `not_found` (não existe ou já entregue/cancelado).
- `review_gifts` GET (só admin): `{ gifts: [{ id, phone_key, label, granted_by, granted_at, granted_order_id, granted_order_code }] }` (pendentes, até 500).
- `review_settings` GET (qualquer usuário): `{ review: { google_review_url, review_url_is_default, default_review_url, instagram_url } }`.
- `review_settings_save` POST (só admin) `{ google_review_url?, instagram_url?, reset_review_url?: true }` retorna `{ ok, review }`. `""` desliga; só `https://` (até 300 caracteres); `reset_review_url: true` volta ao link padrão. Erros 400 `invalid_review_url`, `invalid_instagram_url`, `nothing_to_change`. O link padrão é uma busca da loja no Google Maps (CONFIRMAR com o Renan o link direto "Pedir avaliações").
- `customers` em `report_customers` traz `gift_status` (`pending`, `delivered`, `cancelled` ou `null`) e `gift_pending_id`.

### 10.5 Relatórios e CSV (N5, S-04) — só admin

- `report_sales` GET `?from=AAAA-MM-DD&to=AAAA-MM-DD` (dias de São Paulo, `to` incluso; padrão: últimos 30 dias; máximo 366). Venda = pagamento `approved` e pedido não cancelado. Retorna `{ report: { from, to, timezone, paid_orders, gross_cents, delivery_fee_cents, discount_cents, coupon_discount_cents, club_points_spent, net_cents, avg_ticket_cents, total_orders, unpaid_orders, unpaid_rate, by_payment: { pix: { orders, net_cents }, card: {...} }, by_delivery: { delivery: {...}, pickup: {...} }, top_products: [{ name, qty, revenue_cents, reward_qty }], by_weekday: [{ weekday (0 = domingo), orders, net_cents }] (7), by_hour: [{ hour, orders, net_cents }] (24), by_day: [{ day, paid_orders, gross_cents, delivery_fee_cents, discount_cents, net_cents }] } }`. `gross` = produtos + frete; `net` = total cobrado; `unpaid_rate` de 0 a 1 (4 casas). `total_orders`/`unpaid_orders` contam todos os pedidos do período. Erros 400 `invalid_date`, `invalid_range`, `range_too_long`.
- `report_customers` GET `?s=&sort=name|paid_orders|spent|last_order|points&dir=asc|desc&page=1` (padrão `spent desc`, 50 por página). Retorna `{ report: { search, sort, dir, page, page_size, total, total_pages, customers: [{ phone_key, name, phone, customer_id, has_account, paid_orders, spent_cents, last_order_at, last_paid_at, points_balance, whatsapp_consent, gift_status, gift_pending_id }] } }`. Cliente = telefone normalizado (junta visitante e conta). `s` busca nome ou telefone (3+ dígitos).
- `report_sales_csv` GET `?from=&to=` e `report_customers_csv` GET `?s=&sort=&dir=&pii=1`: resposta NÃO é JSON. `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="vendas-AAAA-MM-DD-a-AAAA-MM-DD.csv"` / `clientes-AAAA-MM-DD.csv`. Separador `;`, BOM UTF-8, CRLF, toda célula entre aspas, célula que começa com `= + - @` ou tab ganha `'` na frente (contra fórmula no Excel). Clientes: telefone mascarado (`*******8888`) a não ser com `pii=1`; até 10000 linhas. Baixar com `fetch` + `blob()` (o cookie vai junto) ou link direto. Erro vem em JSON normal.
- Toda consulta grava `admin_audit` `relatorio_consulta`; todo CSV grava `relatorio_csv` (filtros, número de linhas, telefone completo ou mascarado; o termo buscado NÃO é gravado).

### 10.6 Pix reabre e moeda (U-01, S-06)

- `GET /api/order-status?t=` ganha `pix`: `{ qr_code, qr_code_base64, expires_at }` só enquanto o pagamento estiver pendente (`pending`, `in_process`, `authorized`), não vencido e o pedido não cancelado; senão `null`. Usar para reabrir a tela "Falta só pagar o Pix" e o botão "Copiar código Pix". Quando o pagamento sai de pendente, o servidor apaga o código.
- Pagamento com moeda diferente de BRL (ou sem moeda) nunca confirma o pedido.

### 10.7 Painel: pedidos, login e saúde (A-10, S-01, O-01)

- Objeto de pedido do painel ganha `status_key`, `status_label`, `club_points`, `coupon_code`, `coupon_discount_cents`, `gift`. Prêmio aparece em `items` com `reward: true` (mostrar "Prêmio do Clube").
- `order_status` cancelar pedido JÁ PAGO: pontos ganhos estornados (`reversal`), pontos do prêmio devolvidos, uso do cupom liberado, Pix apagado. O dinheiro continua sendo estornado à mão no Mercado Pago (a tela deve lembrar disso). Auditoria `pedido_status` com `(pontos estornados)`.
- Login em produção: senha certa com menos de 8 caracteres não entra. Desde a F5 (F5-S-07) a resposta é igual à da senha errada (401, ver 10.15). Dev não bloqueia.
- Teto diário: 50 senhas erradas de um usuário em 24 h (somando todos os IPs, inclusive o conhecido) travam o login desse usuário: 429 `Muitas tentativas. Tente mais tarde.`. Aviso em `admin_audit` `login_teto_diario` (1 por usuário a cada 24 h).
- `GET /api/health` (público, sem login): 200 ou 503, `{ ok, checks: { database, mercadopago_token, mercadopago_webhook_secret, webhook_no_401_24h } }` (só sim/não, nunca valor). `no-store`. Serve para o UptimeRobot. `webhook_no_401_24h` mudou na F5 (10.15).
- `health_detail` GET (só admin desde a F5): `{ health: { ok, checks, last_accepted_at, last_unauthorized_at, unauthorized_24h, accepted_24h, unauthorized_since_accepted_24h } }`. Aviso no painel quando `checks.webhook_no_401_24h` for `false` ("O Mercado Pago tentou avisar pagamentos e foi recusado: confira a chave do webhook").

### 10.8 Busca da pausa em lote (N4)

`pause_preview` e `pause_apply`: sem sinônimos. Ignora acento e maiúsculas, tolera plural e procura o termo DENTRO do nome/descrição, a partir do começo de uma palavra: `oreo` acha "Biscoito Oreo", `morangos` acha "Morango", `choco` acha "Chocolate"; `ovo` não acha "novo". Formato de entrada e saída inalterado. A tela de sinônimos sai.

### 10.9 Web Push de pedido pago (U-06) — PWA do painel

Desligado sem as variáveis `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (sem erro). O Renan gera com `node scripts/gerar-vapid.js` e cadastra na Vercel.

- `push_config` GET (qualquer usuário): `{ push: { enabled, public_key, devices } }`. `public_key` (base64url) vai em `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: <public_key convertida para Uint8Array> })`. `enabled: false` = esconder o botão "Ativar avisos".
- `push_subscribe` POST `{ subscription: <PushSubscription.toJSON()> }` (`{ endpoint, keys: { p256dh, auth } }`) retorna `{ ok, device: { id, created_at }, devices }`. Erros: 409 `push_disabled`, 409 `push_limit` (10 aparelhos por usuário), 400 `invalid_subscription`, 400 `unsupported_push_service` (só serviços de push do Chrome/Edge/Firefox/Safari). Repetir é seguro (atualiza).
- `push_unsubscribe` POST `{ endpoint }` retorna `{ ok, removed, devices }` (só o próprio aparelho; admin pode remover qualquer um). Chamar também ao desligar no aparelho.
- `push_test` POST `{}` manda "Teste de notificação" para os aparelhos do próprio usuário: `{ ok, sent, failed, removed }`. 409 `push_disabled`, 409 `no_subscription`.
- Envio automático: quando o pagamento é confirmado (webhook ou conferência), UMA vez por pedido, para todos os aparelhos inscritos. Só pedidos criados nas últimas 24 h e não cancelados.
- Conteúdo (JSON cifrado, lido no `push` do service worker com `event.data.json()`): `{ title: "Pedido DG-1234 pago", body: "R$ 45,90", tag: "pedido-DG-1234", url: "/admin/#pedidos" }`. Nenhum dado pessoal. O service worker mostra `showNotification(title, { body, tag, data: { url } })` e no `notificationclick` abre/foca `url`.
- Aparelho que o navegador derrubou (404/410) ou que falhou 5 vezes seguidas é apagado sozinho.

### 10.10 Endereço do site (A-05)

Variável `SITE_URL` (só `https://`; `http://localhost` no dev). Sem ela: `https://docinhos-site.vercel.app`. Usada nos links de volta do Mercado Pago, no webhook e na mensagem do cupom.

### 10.11 Banco (v4)

Migração `scripts/migrate-2026-11-12-v4-schema.js` (aditiva, idempotente; `schema.sql` espelhado e sobe em banco vazio): `club_rewards`, `coupons`, `coupon_redemptions`, `coupon_campaigns`, `coupon_campaign_targets`, `review_gifts`, `webhook_events`, `admin_push_subscriptions`; em `orders`: `club_points`, `coupon_id`, `coupon_code`, `coupon_discount_cents`, `pix_qr_code`, `pix_qr_base64`, `pix_expires_at`, `push_notified_at`, `scheduled_for` (N10), `payment_attempt_at`, `address_district` e `address_city` (F3, 10.14); índices parciais `orders_paid_created_idx` e `orders_scheduled_for_idx`; CHECK do ledger com `reward_*`. Prêmios de exemplo (só dev): `scripts/migrate-2026-11-12-v4-club-seed.js`. `ingredient_synonyms` fica no banco, sem uso.

### 10.12 Encomenda com data marcada (N10)

**Regra:** o pedido pode mandar `scheduled_for` (ISO 8601 com fuso, ex.: `2026-11-21T18:00:00.000Z` ou `2026-11-21T15:00:00-03:00`). Ausente, `null` ou `""` = "o quanto antes" (como hoje). O servidor aceita só se TUDO vale:
- agendamento ligado (`scheduling_enabled`);
- início alinhado a :00 ou :30 (sem segundos) e a janela de 30 min cabe inteira numa faixa do horário de funcionamento daquele dia (`store_hours`, fuso de São Paulo). Ex.: faixa 09:00-18:00 = janelas 09:00 a 17:30;
- pelo menos `scheduling_min_lead_min` minutos à frente de agora e no máximo `scheduling_max_days` dias de calendário à frente (hoje = dia 0);
- sem fechamento manual cobrindo a janela: "até reabrir" e a pausa antiga bloqueiam todas; fechamento com prazo bloqueia as janelas que começam antes da reabertura;
- vaga na janela (`scheduling_slot_capacity`, 0 = sem limite). Entrega e retirada dividem a mesma vaga. Ocupa a vaga o pedido não cancelado que está pago (`approved`) ou que espera pagamento (`pending`, `in_process`, `authorized`) há menos de 60 min. Recusado, cancelado, vencido, estornado e checkout abandonado há mais de 60 min não ocupam.

Loja fechada agora + `scheduled_for` válido = pedido aceito (pagamento na hora, igual hoje). Loja fechada sem `scheduled_for` = 503 `store_closed` (como antes). Preço, frete, cupom, Clube e pagamento não mudam.

Trava contra corrida: `pg_advisory_xact_lock(3, floor(epoch_ms / 1800000))` na mesma transação do insert do pedido, depois das travas 1 (pontos) e 2 (cupom). O insert só entra se a contagem da janela ainda estiver abaixo da vaga. Testado com 6 pedidos simultâneos e vaga 1: entra 1.

**Erros do `POST /api/order`:**

| HTTP | `code` | Quando |
|---|---|---|
| 400 | `invalid_schedule` | formato inválido, não alinhado a 30 min ou fora das janelas do dia |
| 400 | `schedule_too_soon` | antes de agora + antecedência mínima |
| 400 | `schedule_too_far` | depois do máximo de dias |
| 400 | `schedule_closed` | fechamento manual cobre a janela |
| 409 | `scheduling_disabled` | agendamento desligado (oferecer "o quanto antes") |
| 409 | `slot_full` | a janela lotou (recarregar as janelas e escolher outra) |

**Resposta 201** ganha `scheduled_for` (ISO UTC ou `null`) e `scheduled_label` (`"Agendado: sex 21/11, 15:00-15:30"` ou `null`).

**Janelas:** `GET /api/store?a=slots&date=AAAA-MM-DD&mode=delivery|pickup` (limite 120 consultas por IP em 10 min, 429 `rate_limited`; 400 `invalid_date` e `invalid_mode`):

```json
{ "enabled": true, "date": "2026-11-21", "mode": "pickup", "slot_minutes": 30, "min_lead_min": 120, "max_days": 7,
  "slots": [ { "start": "2026-11-21T12:00:00.000Z", "end": "2026-11-21T12:30:00.000Z", "label": "09:00-09:30", "available": true, "reason": null } ] }
```

`reason`: `null` (livre), `too_soon`, `too_far`, `closed`, `full`. Agendamento desligado, data no passado ou além de `max_days` = `slots: []`. Dia sem horário = `slots: []`. A tela manda o `start` escolhido como `scheduled_for`. `mode` só é validado (a vaga é a mesma).

**`GET /api/menu`** ganha `scheduling: { enabled, min_lead_min, max_days, slot_minutes: 30 }`.

**Acompanhamento e "Meus pedidos"** (`/api/order-status?t=`, `customer?a=orders`): `scheduled_for` e `scheduled_label` (null quando "o quanto antes").

**Painel:**
- todo pedido (`orders`, `order_history`) traz `scheduled_for` e `scheduled_label`;
- `orders?f=scheduled`: só agendados, ordenados pela data marcada (a mais próxima primeiro). `order_history?f=scheduled` também filtra (ordem continua por criação);
- a lista principal mostra pedidos criados há menos de 24 h OU com data marcada há menos de 24 h (encomenda feita há 3 dias para amanhã aparece). O histórico é o resto;
- conclusão automática ("pronto" ou "aguardando entrega" há mais de 1 h) conta a partir do mais tarde entre pronto e data marcada: pronto às 10:00 para as 15:00 só conclui às 16:00 (`completed_at` = data marcada + 1 h);
- a devolução de reserva de pontos e cupom (24 h sem pagar) continua contando da criação, porque o pagamento é na hora do pedido.

**Ajustes:** `GET order_settings` (admin e staff) e `POST order_settings_save` (só admin, auditado em `ajustes_pedido_salvos`). Manda só os campos que mudam. Se um campo for inválido, nada é gravado (400, `code: invalid_settings`; corpo vazio = 400 `Nada para alterar.`).

| Campo | Tipo | Padrão | Limites |
|---|---|---|---|
| `scheduling_enabled` | boolean | `true` | |
| `scheduling_min_lead_min` | inteiro (min) | 120 | 0 a 2880 |
| `scheduling_max_days` | inteiro (dias) | 7 | 1 a 30 |
| `scheduling_slot_capacity` | inteiro | 0 (sem limite) | 0 a 100 |
| `best_seller_enabled` | boolean | `true` | (N11) |
| `delivery_eta_min` | inteiro (min) | 30 | 0 a 600 (N11) |
| `delivery_eta_max` | inteiro (min) | 50 | 0 a 600, maior ou igual ao mínimo (N11) |

Resposta: `{ settings: { ...campos acima, limits: { scheduling_min_lead_min: [0, 2880], scheduling_max_days: [1, 30], scheduling_slot_capacity: [0, 100], delivery_eta: [0, 600] } } }`.

### 10.13 Selo "Mais pedido" e prazo de entrega (N11)

- `GET /api/menu`: todo produto ganha `best_seller` (boolean). `true` nos até 3 produtos ativos com mais unidades vendidas nos últimos 30 dias, em pedidos pagos (`approved`) e não cancelados, com no mínimo 5 unidades cada. Prêmios do Clube não contam. Empate: menor id. `best_seller_enabled = false` = todos `false`. Sem dado pessoal.
- `GET /api/menu`: `delivery_eta_min` e `delivery_eta_max` (minutos, padrão 30 e 50). Só informativos. A4 mostra "Entrega em 30 a 50 min".
- Ajustes no painel: `order_settings` / `order_settings_save` (10.12).

### 10.14 Rodada F3: novo pagamento, link da conta, rastreio com itens, MIME e regra de pontos

**Novo pagamento do mesmo pedido: `POST /api/order?a=retry_payment`** (mesmas exigências do pedido: mesma origem e corpo JSON; senão 403/415).

- Corpo: `{ t: "<token de rastreio>", payment_choice?: "pix" | "card" }` ou, na conta, `{ o: <id do pedido>, payment_choice? }` com a sessão do dono. Sem `payment_choice`: o método atual (Pix continua Pix; cartão ou nada vira cartão). Pode trocar entre Pix e cartão.
- Não recalcula nada: total, itens, frete, desconto e as reservas (prêmio do Clube, cupom e vaga agendada) continuam as do pedido. Nada é reservado de novo.
- Antes de gerar, confere no Mercado Pago (o cliente pode ter acabado de pagar).
- 200: `{ public_code, total_cents, payment_choice, payment }`. `payment` igual ao da criação: Pix `{ type: "pix", id, qr_code, qr_code_base64, expires_at }` ou cartão `{ type: "card", url, id }`. O Pix novo fica guardado (10.6, U-01) e aparece em `order-status`. Trocar para cartão apaga o Pix guardado.
- A volta do cartão vai para `/pedido.html?t=<token>&pagamento=ok|pendente` (ou `?o=<id>` quando veio da conta).
- Erros:

| Status | `code` | Quando |
|---|---|---|
| 400 | (sem code) | `payment_choice` diferente de `pix` e `card` |
| 401 | `login_required` | `{ o }` sem sessão |
| 404 | `order_not_found` | token inválido ou pedido de outro cliente |
| 404 | `unknown_action` | `?a=` diferente de `retry_payment` |
| 409 | `already_paid` | pagamento aprovado, estornado ou contestado |
| 409 | `order_cancelled` | pedido cancelado |
| 409 | `retry_expired` | pedido criado há 24 h ou mais |
| 409 | `payment_in_process` | cartão em análise (`in_process`, `authorized`): outro pagamento cobraria duas vezes |
| 409 | `schedule_passed` | a data marcada já passou |
| 409 | `reservation_released` | o prêmio do Clube ou o cupom já foi devolvido (pagamento recusado ou vencido). Fazer pedido novo |
| 409 | `slot_full` | o pedido agendado já não segurava a vaga (pendente há mais de 60 min) e a janela lotou |
| 429 | `rate_limited` | mais de 10 por IP ou 3 por pedido em 10 min |
| 502 | `payment_unavailable` | o Mercado Pago falhou |
| 503 | `payment_unavailable` | pagamento on-line desligado no servidor |

- Aviso atrasado do pagamento antigo: depois de um novo pagamento (`orders.payment_attempt_at`), aviso não aprovado de pagamento criado antes dele é ignorado (`payment_check` do painel responde `outcome: "stale"`). Assim o Pix antigo vencido não cancela o novo. Pagamento aprovado vale sempre.

**Link em "Meus pedidos"** (`GET /api/customer?a=orders`): cada pedido traz `tracking_url: "/pedido.html?o=<id>"`.

- O banco guarda só o SHA-256 do token de rastreio, então o token não pode voltar. O link usa o id interno e só abre com a sessão do dono.
- `GET /api/order-status?o=<id>`: mesma resposta do `?t=`. Sem sessão: 401 `login_required` (a página pede para entrar na conta). Pedido de outro cliente ou id inválido: 404.
- A4: em `pedido.html`, ler `?o=` além de `?t=` e chamar `/api/order-status?o=<id>` (o fetch na mesma origem já manda o cookie). O "pagar de novo" nessa página manda `{ o }` no lugar de `{ t }`.

**Rastreio com itens e endereço resumido** (`GET /api/order-status?t=` e `?o=`):

- `items`: `[{ name, size, qty, reward }]`. Só nome, tamanho (ou `null`), quantidade e se é prêmio do Clube. Sem preço, complemento ou id. No máximo 30.
- `address_summary`: texto ou `null`.
  - Entrega: só `"Bairro, Cidade"`, vindos do CEP (ViaCEP, no servidor) e gravados no pedido. Nunca rua, número ou complemento.
  - Pedido antigo (antes da F3) ou CEP sem bairro e cidade: `null`. O texto livre do endereço nunca é recortado.
  - Retirada: o endereço da loja (`store_address` do painel).

**Servidor local** (`scripts/dev-server.js`): `.webmanifest` = `application/manifest+json`, `.wav` = `audio/wav`, `.avif` = `image/avif`, `.txt` = `text/plain`, `.xml` = `application/xml`, além de `.woff`, `.gif` e `.mp3`. Só o servidor de desenvolvimento; a Vercel serve pelos próprios tipos.

**Regra de pontos no painel** (`POST points_save`, só admin):

- Corpo: `{ enabled: boolean, points_per_real: 1 a 10 }`. Grava só essas duas chaves.
- `block_points` e `block_value_cents` (desconto em reais, fim na v4 N3) não são mais pedidos. Se vierem, são ignorados e as chaves antigas não mudam.
- O teto de 50% de retorno saiu: 10 pt/R$ 1 vale.
- Erro: 400 `invalid_rules` com mensagem.
- Auditoria `pontos_regra_alterada`: `ligado, 1 pt/R$ 1 -> ligado, 2 pt/R$ 1`.
- `points_get` continua igual (as regras ainda trazem `block_*`, só para os pedidos antigos).

**Banco:** em `orders`, `payment_attempt_at`, `address_district` e `address_city`. A migração `scripts/migrate-2026-11-12-v4-schema.js` foi ampliada e já rodou no dev. Em produção, rodar antes do deploy da v4, como o resto.

### 10.15 Correções da revisão de segurança F5 (`docs/planos/seguranca-v4-f5.md`)

| ID | O que mudou |
|---|---|
| F5-S-01 | `POST /api/mp-webhook` sem assinatura válida: continua 401, mas grava em `webhook_events` no máximo 5 por IP e 60 no geral a cada 10 min. `checks.webhook_no_401_24h` (nome mantido) só fica `false` com 3 ou mais recusas nas últimas 24 h **depois do último aviso aceito**. Um aviso aceito apaga o alerta. |
| F5-S-02 | Estorno (`refunded`) e contestação (`charged_back`) nunca viram `stale`, mesmo de pagamento antigo. Se o estorno é de um pagamento que não é o atual do pedido, o pedido não muda e vai para `admin_audit` (`estorno_pagamento_antigo`, uma vez por pagamento e status). |
| F5-S-03 | `retry_payment` grava `payment_attempt_at` antes de chamar o Mercado Pago (pedido aberto; senão 409 `already_paid`). Se o Mercado Pago falhar (502), a hora anterior volta. Aviso de expiração do Pix antigo durante a chamada é ignorado. |
| F5-S-04 | `user_toggle` com `active: false` apaga as inscrições push do usuário (a auditoria `usuario_desativado` diz quantas). Aviso de pedido pago só vai para usuário ativo. |
| F5-S-05 | `audit` para staff: sem `login_falhou`, `recuperacao_falhou`, `login_senha_curta_bloqueado` e `login_teto_diario`. Qualquer `ip <endereço>` no detalhe aparece como `ip (oculto)`. O admin vê tudo. |
| F5-S-06 | `health_detail` só admin (staff: 403). O painel só consulta para o admin. Decisão do A0. |
| F5-S-07 | Login com senha certa porém curta em produção: 401 com a mesma mensagem da senha errada (`Usuário ou senha incorretos. Se a sua senha tem menos de 8 caracteres, use "Esqueci minha senha" para criar uma nova.`). Conta como falha. Sai o 403 `weak_password_blocked`. Motivo real só na auditoria do admin. |
| F5-S-08 | `coupon_check` sem sessão ignora `phone` (ver 10.3). O limite por pessoa do visitante é conferido no pedido. |
