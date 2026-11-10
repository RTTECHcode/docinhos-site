# Contrato da API (Painel v2, fase F2, A2)

Quem usa: A3 (admin), A4 (admin), A5 (admin), A9 (loja), A10 (conta do cliente). Tudo em português do Brasil. Valores em centavos (inteiros). Datas em ISO 8601 UTC (o fuso da loja é America/Sao_Paulo, UTC-3, sem horário de verão). Preço, frete, desconto, pontos e total são calculados SÓ no servidor: o cliente nunca envia esses valores.

## 0. Convenções

- Erros: `{ "error": "mensagem para mostrar à pessoa", "code": "codigo_opcional" }` com o status HTTP certo. Mensagens já são para o cliente final (pt-BR).
- Todas as respostas de `/api/admin`, `/api/order`, `/api/order-status` e `/api/store` vêm com `Cache-Control: no-store`.
- `POST` do admin, da conta do cliente e de `/api/order`: cabeçalho `Content-Type: application/json` e `Origin` igual ao host (senão 415 e 403). O `fetch` do próprio site já manda os dois.
- IP do cliente (limites e bloqueios): `x-real-ip` (preenchido pela Vercel); o primeiro valor do `x-forwarded-for` é só reserva (`auth.clientIp`).
- Limite de funções: 9 arquivos em `api/` hoje (`admin`, `customer`, `health`, `img`, `menu`, `mp-webhook`, `order`, `order-status`, `store`); máximo de 12 no total.

## 1. Cardápio público: GET /api/menu

Campos novos (os antigos continuam):

```json
{
  "categories": [{ "id": 1, "name": "Brigadeiros", "products": [
    { "id": 7, "name": "Brigadeiro de Ninho", "description": "...", "priceCents": 800, "imagePath": "x.avif",
      "complements": [{ "id": 3, "name": "Morango", "priceCents": 0, "kind": "additional", "maxQuantity": 1, "groupId": 12 }],
      "groups": [{ "id": 12, "key": "frutas", "label": "Frutas", "minChoices": 0, "maxChoices": 2 }],
      "unavailable": true, "label": "volto logo <3" }
  ]}],
  "settings": { "storeAddress": "...", "deliveryFeeCents": 0, "storePaused": false, "storePausedMessage": "", "defaultPauseLabel": "volto logo <3" },
  "store": { "open": true, "reason": null, "reopens_at": null, "next_open_at": null, "closes_at": "2026-11-10T21:00:00.000Z", "message": null },
  "shipping": { "bands": [{ "max_km": 3, "fee_cents": 600 }, { "max_km": 6, "fee_cents": 900 }, { "max_km": 10, "fee_cents": 1400 }], "maxKm": 10, "pickupFeeCents": 0 }
}
```

- Produto pausado: aparece com `unavailable: true` e `label` (a etiqueta própria ou a padrão). Não pode ser pedido (o pedido recusa com 400).
- Produto sem preço (`priceCents: null`) e sem nenhum tamanho disponível (A2 rodada 3): também vem com `unavailable: true` e `label: "Consulte pelo WhatsApp"`. Antes aparecia como "Consulte", entrava no carrinho por R$ 0,00 e o pedido recusava só no fim.
- Complemento pausado em um produto (vínculo pausado, inclui as opções do "Monte seu copo" e do "Monte seu açaí") NÃO aparece em `complements` daquele produto.
- `store.reason`: `null` (aberta), `"schedule"` (fora do horário) ou `"manual"` (fechada pelo painel ou pausa antiga). `settings.storePaused` continua existindo (true quando fechada por qualquer motivo) por compatibilidade.
- `settings.deliveryFeeCents` é legado: o frete real vem de `shipping.bands`.

## 2. Loja pública: GET /api/store?a=...

Sem login. Só leitura. Outros métodos: 405.

- `a=state` retorna `{ open, reason, reopens_at, next_open_at, closes_at, message, hours: [{ weekday, opens, closes }] }` (weekday 0 = domingo; horas "HH:MM").
- `a=shipping` retorna `{ bands, max_km, pickup_fee_cents }`.
- `a=quote&cep=06000000&address=Rua X, 100[&number=100]` retorna `{ "km": 4.2, "fee_cents": 900, "faixa": { "max_km": 6, "fee_cents": 900 }, "max_km": 10 }`. Só informativo: o pedido recalcula.
- Erros do `quote`: 400 `invalid_cep` | `invalid_address`; 422 `cep_not_found` | `address_not_found` | `out_of_area` (com `max_km`); 429 (limite de consultas); 503 `origin_unavailable`.
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

(Os nomes exatos dos campos de cliente seguem `validateCustomer` em `api/order.js`, inalterado.) `payment_choice`: `"card"` (padrão) ou `"pix"`. `use_points`: inteiro, múltiplo de 100, opcional.

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
- 429 `rate_limited` (F5, A1-12): mais de 300 consultas do mesmo IP em 10 min (por instância). A tela deve esperar e tentar de novo mais tarde, sem martelar (a consulta a cada 5 s de uma aba fica em 120).
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

- `product_pause` POST `{ id, paused: bool, pause_label?: string|null }` retorna `{ ok, product: { id, name, paused, pause_label } }`. `pause_label` ausente mantém a etiqueta; `null` ou `""` limpa (volta a usar a padrão). 404 produto inexistente.
- `pause_default_label` POST `{ label }` retorna `{ ok, defaultPauseLabel }`. Padrão inicial: `volto logo <3`.

#### Horários e estado da loja (O3, O4)

- `store_hours` GET retorna `{ hours: [{ weekday, opens, closes }], timezone: "America/Sao_Paulo" }`.
- `store_hours_save` POST `{ hours: [{ weekday: 0-6, opens: "09:00", closes: "18:00" }] }` (várias faixas por dia, no máximo 6; lista vazia = sem horário configurado = aberta pelo horário) retorna `{ ok, hours }`. 400 formato, fechamento antes da abertura, sobreposição.
- `store_state` GET retorna `{ state: { open, reason, reopens_at, next_open_at, closes_at, message, hours, schedule_configured }, manual: { closed_until, closed_indefinitely, closed_message, updated_by, updated_at } | null }`.
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

#### Sinônimos (O8)

- `synonyms` GET retorna `{ synonyms: [{ id, canonical, synonym }] }` (sementes: oreo = biscoito oreo, morango = morangos).
- `synonym_save` POST `{ id?, canonical, synonym }` retorna `{ ok, synonym }`. Sem `id` cria; com `id` edita. 400 curto demais, iguais, duplicado.
- `synonym_delete` POST `{ id }` retorna `{ ok }`. 404.

#### Pausa em lote por ingrediente, reativar e desfazer (O8)

Fluxo da tela: digitar o ingrediente, ver a PRÉVIA, marcar o que vale, CONFIRMAR. Nada muda antes do `confirm: true`. O que vale para os complementos do "Monte seu copo" e do "Monte seu açaí": eles são vínculos produto-complemento (com grupo), então entram em `links` e a pausa vale só naquele produto.

`pause_preview` POST `{ term }` (só lê). A busca ignora acento e maiúsculas, tolera plural e usa os sinônimos.

```json
{ "ok": true, "term": "morango", "terms": ["morango", "morangos"],
  "products": [{ "id": 7, "name": "Torta de Morango", "matched_in": "nome", "matched_term": "morango", "active": true, "paused": false, "pause_label": null, "builder": false },
               { "id": 9, "name": "Monte seu copo", "matched_in": "descrição", "matched_term": "morango", "active": true, "paused": false, "pause_label": null, "builder": true }],
  "complements": [{ "id": 3, "name": "Morango", "matched_term": "morango", "active": true,
                    "links": [{ "product_id": 9, "product_name": "Monte seu copo", "group_label": "Frutas", "paused": false }] }],
  "summary": { "products": 2, "complements": 1, "links": 1 } }
```

`builder: true` marca produto "monte seu..." (tem grupos de escolha). Cuidado na tela: um produto assim aparece por causa da descrição; o certo é pausar o complemento (vínculo), não o produto inteiro. Sugestão: deixar o produto `builder` desmarcado por padrão.

`pause_apply` POST. Exige `confirm: true` e `term`:

```json
{ "term": "morango", "confirm": true, "pause_label": "sem morango hoje",
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
- `pause_label` é opcional (vale para os produtos pausados; `null` ou `""` limpa).
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

`pause_batches` GET `?all=1` (opcional) retorna `{ batches: [{ id, term, created_by, created_at, released_at, released_by, pause_label, products, links }] }`: lotes abertos (ou os 50 mais recentes com `all=1`).

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

## 8. Decisões e pontos de atenção

- Usuário criado em `user_create` não tem pergunta: cadastra no primeiro login (portão `security_setup_required`).
- `password_change` mantém a sessão atual e derruba as outras; recuperação derruba todas.
- Histórico = pedidos com mais de 24 h; o dia nos filtros é o de São Paulo.
- Desconto maior que o subtotal é recusado (400), não cortado. Mínimo a pagar R$ 1,00.
- Sem horário cadastrado = aberta pelo horário (só o fechamento manual fecha).
- `shipping_save` é só do admin; a equipe (staff) pausa, fecha a loja e edita horários.
- O parser de comandos (`command`) não usa sinônimos; a busca com sinônimos é o fluxo `pause_preview`/`pause_apply`. Exceção: o verbo de reativar abre a prévia de lote quando há lote aberto.
- Complementos do "Monte seu copo" e do "Monte seu açaí" são pausados por vínculo (`links`), sempre só no produto escolhido. Pausar a opção em todos os produtos exige marcar todos os vínculos da prévia.
- Reativar em lote nunca mexe no que já estava pausado antes do lote nem no que foi pausado à mão depois.
- Tentativas de recuperação do admin têm tabela própria (`admin_recovery_attempts`) e não afetam o bloqueio de login.
