// Acompanhamento do pedido: /pedido.html?t=<tracking_token> ou, na conta, /pedido.html?o=<id> (só com a sessão do dono, v4 F3).
// Só mostra dados públicos: itens (nome, tamanho, qtd) e bairro/cidade, nunca telefone, rua ou número.
(function () {
  var RECENT_KEY = 'dg-recent-orders';
  var REFRESH_MS = 20000;
  var FAST_MS = 5000; // enquanto o pagamento está pendente (L8): confirma sozinho assim que aprovar
  var params = new URLSearchParams(location.search);
  var payParam = params.get('pagamento'); // ok | pendente, na volta do cartão (Mercado Pago)
  if (payParam) { params.delete('pagamento'); history.replaceState(null, '', location.pathname + '?' + params.toString() + location.hash); }
  var PENDING = { pending: 1, in_process: 1, authorized: 1 };
  var sawPending = !!payParam, lastLoad = 0, fast = false;
  var TZ = 'America/Sao_Paulo';
  var token = new URLSearchParams(location.search).get('t') || '';
  var orderId = token ? '' : (new URLSearchParams(location.search).get('o') || ''); // v4 F3: link de "Meus pedidos"
  var byId = /^[0-9]{1,12}$/.test(orderId);
  var statusUrl = function () { return '/api/order-status?' + (byId ? 'o=' + orderId : 't=' + encodeURIComponent(token)); };
  var $ = function (id) { return document.getElementById(id); };
  var brl = function (c) { return 'R$ ' + (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var fmt = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  var when = function (iso) { var d = new Date(iso); return iso && !isNaN(d) ? fmt.format(d).replace(',', ' às') : ''; };

  var STEPS = [
    { key: 'new', at: 'created_at' },
    { key: 'accepted', at: 'accepted_at' },
    { key: 'preparing', at: 'preparing_at' },
    { key: 'ready', at: 'ready_at' },
    { key: 'awaiting_delivery', at: 'awaiting_delivery_at' },
    { key: 'completed', at: 'completed_at' }
  ];
  // Nomes fixos das etapas da linha do tempo. O rótulo da situação atual vem pronto do servidor (status_label, v4 N1).
  var STEP_NAMES = { new: 'Pedido recebido', accepted: 'Aceito', preparing: 'Em preparo', ready: 'Pronto', awaiting_delivery: 'Saiu para entrega', completed: 'Concluído' };
  // status_key -> etapa da linha do tempo (todas as situações de pagamento ficam na primeira etapa).
  var KEY_STEP = { awaiting_payment: 'new', payment_failed: 'new', refunded: 'new', received: 'new', accepted: 'accepted', preparing: 'preparing', ready: 'ready', awaiting_delivery: 'awaiting_delivery', completed: 'completed' };

  var timer = null;
  var busy = false;

  function readRecent() {
    try { var r = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(r) ? r : []; } catch (e) { return []; }
  }

  function showRecent() {
    var list = readRecent().filter(function (r) { return r && /^[A-Za-z0-9_-]{16,64}$/.test(r.token || ''); });
    $('t-recent-box').hidden = !list.length;
    var ul = $('t-recent');
    ul.replaceChildren();
    list.forEach(function (r) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = '/pedido.html?t=' + encodeURIComponent(r.token);
      var s = document.createElement('strong'); s.textContent = r.public_code || 'Pedido';
      var d = document.createElement('span'); d.textContent = when(r.date);
      a.append(s, d);
      li.append(a);
      ul.append(li);
    });
  }

  function render(d) {
    var pickup = d.delivery_method === 'pickup';
    var key = String(d.status_key || '');
    var status = key === 'cancelled' ? 'cancelled' : (KEY_STEP[key] || 'new');
    var label = String(d.status_label || '');
    $('t-code').textContent = d.public_code || '';
    var ol = $('t-timeline');
    ol.replaceChildren();
    var cancelled = status === 'cancelled';
    var current = STEPS.findIndex(function (s) { return s.key === status; });
    STEPS.forEach(function (s, i) {
      var stepName = s.key === 'awaiting_delivery' && pickup ? 'Pronto para retirada' : STEP_NAMES[s.key];
      // Etapa atual: mostra o rótulo do servidor (ex.: "Aguardando pagamento" na primeira etapa).
      if (s.key === status && label) stepName = label;
      var li = document.createElement('li');
      var state = cancelled ? (d[s.at] ? 'done' : 'todo') : i < current ? 'done' : i === current ? 'current' : 'todo';
      li.className = 'tl-step ' + state;
      var name = document.createElement('span'); name.className = 'tl-name'; name.textContent = stepName;
      li.append(name);
      if (d[s.at]) { var t = document.createElement('span'); t.className = 'tl-time'; t.textContent = when(d[s.at]); li.append(t); }
      if (state === 'current') li.setAttribute('aria-current', 'step');
      ol.append(li);
    });
    if (cancelled) {
      var c = document.createElement('li');
      c.className = 'tl-step cancelled';
      var n = document.createElement('span'); n.className = 'tl-name'; n.textContent = label || 'Cancelado';
      c.append(n);
      if (d.cancelled_at) { var tt = document.createElement('span'); tt.className = 'tl-time'; tt.textContent = when(d.cancelled_at); c.append(tt); }
      ol.append(c);
    }
    ol.hidden = false;
    $('t-msg').textContent = cancelled ? 'Este pedido foi cancelado. Se tiver dúvida, fale com a gente pelo WhatsApp.' : status === 'completed' ? 'Pedido concluído. Obrigada pela preferência!' : (label ? 'Situação atual: ' + label + '.' : '');
    $('t-pay').textContent = label;
    // v4 N10: encomenda com data marcada (rótulo pronto do servidor: "Agendado: sex 21/11, 15:00-15:30").
    var sched = String(d.scheduled_label || '').replace(/^Agendado:\s*/, '');
    $('t-sched-row').hidden = !sched;
    $('t-sched').textContent = sched;
    $('t-total').textContent = Number.isInteger(d.total_cents) ? brl(d.total_cents) : '';
    // v4 F3: itens (nome, tamanho, quantidade) e endereço resumido (bairro e cidade; na retirada, o endereço da loja).
    var items = Array.isArray(d.items) ? d.items.filter(function (i) { return i && typeof i.name === 'string' && Number.isInteger(i.qty); }).slice(0, 30) : [];
    var ul = $('t-items');
    ul.replaceChildren();
    items.forEach(function (i) {
      var li = document.createElement('li');
      li.textContent = i.qty + 'x ' + i.name + (typeof i.size === 'string' && i.size ? ' (' + i.size + ')' : '');
      if (i.reward === true) { var tag = document.createElement('span'); tag.className = 'reward-tag'; tag.textContent = ' · prêmio do Clube'; li.append(tag); }
      ul.append(li);
    });
    $('t-items-row').hidden = !items.length;
    var addr = typeof d.address_summary === 'string' ? d.address_summary.trim() : '';
    $('t-addr-label').textContent = pickup ? 'Retirada em' : 'Entrega em';
    $('t-addr').textContent = addr;
    $('t-addr-row').hidden = !addr;
    $('t-created').textContent = when(d.created_at);
    $('t-info').hidden = false;
    // L8: aviso do pagamento. Aprovado depois de pendente (ou na volta do cartão) vira "Pagamento confirmado".
    var ps = d.payment_status, banner = $('t-pay-banner');
    fast = !!PENDING[ps] && !cancelled;
    if (PENDING[ps]) sawPending = true;
    if (ps === 'approved' && sawPending) { banner.textContent = 'Pagamento confirmado! Já estamos cuidando do seu pedido.'; banner.className = 'track-msg pay-banner ok'; banner.hidden = false; }
    else if (PENDING[ps] && payParam) { banner.textContent = payParam === 'ok' ? 'Voltamos do pagamento. Estamos confirmando com o Mercado Pago. Esta tela muda sozinha quando for aprovado.' : 'Pagamento pendente. Esta tela muda sozinha quando for aprovado.'; banner.className = 'track-msg pay-banner'; banner.hidden = false; }
    else if (PENDING[ps]) { banner.textContent = 'Aguardando a confirmação do pagamento. Esta tela muda sozinha quando for aprovado.'; banner.className = 'track-msg pay-banner'; banner.hidden = false; }
    else if (ps === 'rejected' || ps === 'cancelled') { banner.textContent = 'O pagamento não foi concluído. Se já pagou, fale com a gente pelo WhatsApp informando o código do pedido.'; banner.className = 'track-msg pay-banner warn'; banner.hidden = false; }
    else banner.hidden = true;
    $('t-note').textContent = fast ? 'Esta página atualiza sozinha a cada 5 segundos enquanto o pagamento é confirmado.' : NOTE_TEXT;
    $('t-note').hidden = status === 'completed' || cancelled;
    if (status === 'completed' || cancelled) stop();
    renderPix(cancelled ? null : d.pix, d.total_cents);
    renderAgain(d, cancelled);
    renderThanks(d.public_code, d.post_payment);
    // v4 U-08: o WhatsApp da página já leva o código do pedido.
    var num = String(window.WHATSAPP_NUMBER || '').replace(/\D/g, '');
    if (num && d.public_code) $('t-wa').href = 'https://wa.me/' + num + '?text=' + encodeURIComponent('Olá! Tenho uma dúvida sobre o meu pedido ' + d.public_code + '.');
  }

  /* v4 U-01/U-09: Pix pendente. O servidor só manda pix enquanto o pagamento está pendente e o código não venceu. */
  var pixCode = '', pixUntil = 0, pixTick = null, copyTimer = null;
  function pixTimer() {
    var left = pixUntil - Date.now();
    if (left <= 0) { hidePix(); $('t-msg').textContent = 'O Pix venceu sem pagamento. Nenhum valor foi cobrado. Se quiser, faça o pedido de novo no cardápio.'; load(); return; }
    var s = Math.ceil(left / 1000);
    $('t-pix-timer').textContent = 'O Pix expira em ' + String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  function hidePix() { clearInterval(pixTick); pixTick = null; pixCode = ''; $('t-pix').hidden = true; }
  function renderPix(p, total) {
    var code = p && typeof p.qr_code === 'string' ? p.qr_code.trim() : '';
    var until = p ? Date.parse(p.expires_at) : NaN;
    if (!code || !(until > Date.now())) { if (!$('t-pix').hidden || pixCode) hidePix(); return; }
    if (code !== pixCode) { // só troca quando muda: não apaga a seleção de quem está copiando
      pixCode = code;
      $('t-pix-code').value = code;
      var b64 = typeof p.qr_code_base64 === 'string' ? p.qr_code_base64.replace(/\s+/g, '') : '';
      var okB64 = /^[A-Za-z0-9+/]+=*$/.test(b64);
      $('t-pix-qr-box').hidden = !okB64;
      if (okB64) $('t-pix-qr').src = 'data:image/png;base64,' + b64; else $('t-pix-qr').removeAttribute('src');
    }
    $('t-pix-amount-row').hidden = !Number.isInteger(total);
    $('t-pix-amount').textContent = Number.isInteger(total) ? brl(total) : '';
    pixUntil = until;
    $('t-pix').hidden = false;
    if (!pixTick) { pixTimer(); pixTick = setInterval(pixTimer, 1000); }
  }
  async function copyPix() {
    var ta = $('t-pix-code'), text = ta.value, ok = false;
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); ok = true; } } catch (e) { /* plano B */ }
    if (!ok) {
      try { ta.focus({ preventScroll: true }); ta.select(); ta.setSelectionRange(0, text.length); ok = document.execCommand('copy'); } catch (e) { ok = false; }
    }
    var st = $('t-pix-copy-status');
    clearTimeout(copyTimer);
    st.textContent = '';
    copyTimer = setTimeout(function () {
      st.textContent = ok ? 'Copiado! Agora cole no app do banco.' : 'Não deu para copiar sozinho. Toque no código, selecione tudo e copie.';
      st.classList.toggle('err', !ok);
    }, 30);
  }
  $('t-pix-copy').addEventListener('click', copyPix);
  $('t-pix-code').addEventListener('focus', function () { $('t-pix-code').select(); });

  /* v4 N8: avaliação no Google e Instagram depois do pagamento aprovado. Só se o servidor mandar post_payment;
     uma vez por pedido (marcado no aparelho ao fechar ou ao tocar num dos links). */
  var SEEN_KEY = 'dg-post-payment-seen';
  function seenList() { try { var v = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'); return Array.isArray(v) ? v.filter(function (c) { return typeof c === 'string'; }) : []; } catch (e) { return []; } }
  function markSeen(code) {
    if (!code) return;
    var list = [code].concat(seenList().filter(function (c) { return c !== code; })).slice(0, 30);
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(list)); } catch (e) { /* segue sem guardar */ }
  }
  function httpsUrl(u) { if (typeof u !== 'string' || u.length > 500) return ''; try { var x = new URL(u); return x.protocol === 'https:' ? x.href : ''; } catch (e) { return ''; } }
  var thanksCode = '';
  function renderThanks(code, pp) {
    if (thanksCode || !code || !pp || typeof pp !== 'object' || seenList().indexOf(code) !== -1) return;
    var review = httpsUrl(pp.review_url), insta = httpsUrl(pp.instagram_url);
    if (!review && !insta) return;
    $('t-review').hidden = !review; if (review) $('t-review').href = review;
    $('t-insta').hidden = !insta; if (insta) $('t-insta').href = insta;
    thanksCode = code;
    $('t-thanks').hidden = false;
  }
  $('t-thanks-close').addEventListener('click', function () { markSeen(thanksCode); $('t-thanks').hidden = true; $('t-wa').focus(); });
  $('t-review').addEventListener('click', function () { markSeen(thanksCode); });
  $('t-insta').addEventListener('click', function () { markSeen(thanksCode); });

  function stop() { clearInterval(timer); timer = null; }

  // 429 rate_limited (F5, A1-12): para de consultar por um tempo (60 s, depois 120 s) e mostra um aviso discreto.
  var NOTE_TEXT = 'Esta página atualiza sozinha a cada 20 segundos.';
  var BACKOFF_MS = [60000, 120000];
  var pausedUntil = 0, backoffStep = 0, resumeTimer = null;
  function rateLimited(r) {
    var wait = BACKOFF_MS[Math.min(backoffStep, BACKOFF_MS.length - 1)];
    var retry = Number(r.headers.get('Retry-After'));
    if (retry > 0) wait = Math.max(wait, Math.min(retry, 600) * 1000);
    backoffStep++;
    pausedUntil = Date.now() + wait;
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(function () { if (timer && !document.hidden) load(); }, wait); // tenta de novo na hora certa, sem esperar o próximo ciclo de 20 s
    var min = Math.round(wait / 60000);
    $('t-note').textContent = 'Muitas consultas agora. Voltamos a atualizar em ' + (min > 1 ? min + ' minutos' : '1 minuto') + '.';
    $('t-note').hidden = false;
  }
  function canLoad() { return !document.hidden && Date.now() >= pausedUntil; }

  async function load() {
    if (busy) return;
    busy = true;
    lastLoad = Date.now();
    try {
      var r = await fetch(statusUrl(), { cache: 'no-store', credentials: 'same-origin' });
      if (r.status === 401) { needLogin(); return; }
      if (r.status === 404) { stop(); $('t-code').textContent = ''; $('t-msg').textContent = 'Não encontramos esse pedido. Confira o link ou veja seus pedidos recentes abaixo.'; return; }
      if (r.status === 429) { rateLimited(r); return; }
      if (!r.ok) { $('t-msg').textContent = 'Não foi possível atualizar agora. Tentamos de novo em instantes.'; return; }
      backoffStep = 0;
      render(await r.json());
    } catch (e) {
      $('t-msg').textContent = 'Sem conexão. Tentamos de novo em instantes.';
    } finally { busy = false; }
  }

  /* v4 F3: ?o= sem sessão: o servidor responde 401 e a página pede para entrar (volta para cá depois). */
  function needLogin() {
    stop();
    $('t-code').textContent = '';
    $('t-msg').textContent = 'Entre na sua conta para ver este pedido.';
    $('t-login-link').href = '/conta/?voltar=pedido&o=' + orderId + '#entrar';
    $('t-login').hidden = false;
    $('t-again').hidden = true;
  }

  /* v4 F3: "Gerar novo pagamento" quando o pagamento falhou, venceu ou ficou pendente. O servidor confere tudo
     (já pago, cancelado, 24 h, cartão em análise, reservas) e pode recusar com 409 ou 429. */
  var AGAIN_MSGS = {
    already_paid: 'Este pedido já está pago. Não precisa pagar de novo.',
    order_cancelled: 'Este pedido foi cancelado. Se quiser, faça um pedido novo no cardápio.',
    retry_expired: 'Passou o prazo de 24 horas para pagar este pedido. Faça um pedido novo no cardápio.',
    payment_in_process: 'O pagamento com cartão ainda está em análise. Espere a resposta antes de tentar de novo, para não cobrar duas vezes.',
    schedule_passed: 'O horário agendado deste pedido já passou. Faça um pedido novo com outro horário.',
    reservation_released: 'O prêmio do Clube ou o cupom deste pedido já foi liberado. Faça um pedido novo no cardápio.',
    slot_full: 'O horário agendado lotou enquanto o pagamento estava pendente. Faça um pedido novo com outro horário.',
    rate_limited: 'Muitas tentativas em pouco tempo. Espere alguns minutos e tente de novo.',
    login_required: 'Entre na sua conta para pagar este pedido.',
    order_not_found: 'Não encontramos este pedido.',
    payment_unavailable: 'O pagamento on-line não respondeu agora. Tente de novo em instantes ou fale com a gente pelo WhatsApp.'
  };
  var AGAIN_KEYS = { awaiting_payment: 1, payment_failed: 1 };
  var IN_ANALYSIS = { in_process: 1, authorized: 1 };
  var againBlocked = false; // recusa definitiva do servidor (pedido novo necessário): não oferece de novo
  function renderAgain(d, cancelled) {
    var ps = d.payment_status;
    var show = !cancelled && !againBlocked && !!AGAIN_KEYS[String(d.status_key || '')] && ps !== 'approved' && !IN_ANALYSIS[ps];
    $('t-again').hidden = !show;
    if (!show) return;
    $('t-again-text').textContent = d.pix ? 'Prefere pagar com cartão ou precisa de um Pix novo? Gere outro pagamento para este mesmo pedido.'
      : (ps === 'rejected' || ps === 'cancelled' || d.status_key === 'payment_failed') ? 'O pagamento não foi concluído. Você pode gerar um novo pagamento para este mesmo pedido, sem montar o carrinho de novo.'
      : 'O pagamento ainda não foi confirmado. Se o Pix venceu ou você não terminou o pagamento com cartão, gere um novo pagamento.';
  }
  function againStatus(msg, warn) { var st = $('t-again-status'); st.textContent = msg; st.className = 'pay-again-status' + (warn ? ' warn' : ''); }
  $('t-again-btn').addEventListener('click', async function () {
    var btn = $('t-again-btn');
    if (btn.disabled) return;
    var pick = document.querySelector('input[name="t_again_choice"]:checked');
    var choice = pick && pick.value === 'card' ? 'card' : 'pix';
    var body = byId ? { o: Number(orderId), payment_choice: choice } : { t: token, payment_choice: choice };
    btn.disabled = true; btn.textContent = 'Gerando...'; againStatus('', false);
    var r, d = {};
    try {
      r = await fetch('/api/order?a=retry_payment', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      try { d = await r.json(); } catch (e) { /* corpo não-JSON */ }
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Gerar novo pagamento';
      againStatus('Sem conexão com o servidor. Confira a internet e tente de novo.', true);
      return;
    }
    btn.disabled = false; btn.textContent = 'Gerar novo pagamento';
    var p = r.ok && d && d.payment && typeof d.payment === 'object' ? d.payment : null;
    if (p && p.type === 'card' && typeof p.url === 'string' && /^https:\/\//i.test(p.url)) {
      againStatus('Abrindo o pagamento com cartão...', false);
      location.href = p.url;
      return;
    }
    if (p && p.type === 'pix' && typeof p.qr_code === 'string' && p.qr_code.trim()) {
      renderPix(p, Number.isInteger(d.total_cents) ? d.total_cents : null);
      againStatus('Novo Pix gerado. Copie o código acima e pague no app do banco.', false);
      sawPending = true;
      $('t-pix').scrollIntoView({ block: 'start', behavior: 'smooth' });
      $('t-pix-copy').focus({ preventScroll: true });
      return;
    }
    var code = d && d.code;
    if (r.status === 401 || code === 'login_required') { needLogin(); return; }
    var msg = (!r.ok && AGAIN_MSGS[code]) || (r.status === 429 ? AGAIN_MSGS.rate_limited : (!r.ok && d && d.error) || 'Não foi possível gerar o pagamento agora. Tente de novo.');
    againStatus(msg, true);
    if (code === 'already_paid' || code === 'order_cancelled' || code === 'retry_expired' || code === 'schedule_passed' || code === 'reservation_released' || code === 'slot_full') {
      if (code !== 'already_paid') againBlocked = true;
      $('t-msg').textContent = msg;
      load();
    }
  });

  showRecent();
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token) && !byId) {
    $('t-code').textContent = '';
    $('t-msg').textContent = token || orderId ? 'Link de acompanhamento inválido.' : 'Abra o link de acompanhamento que você recebeu, ou escolha um pedido recente abaixo.';
    return;
  }
  load();
  timer = setInterval(function () { if (canLoad() && Date.now() - lastLoad >= (fast ? FAST_MS : REFRESH_MS) - 500) load(); }, FAST_MS);
  document.addEventListener('visibilitychange', function () { if (timer && canLoad()) load(); });
})();
