// Acompanhamento do pedido: /pedido.html?t=<tracking_token>. Só mostra dados públicos (sem telefone nem endereço).
(function () {
  var RECENT_KEY = 'dg-recent-orders';
  var REFRESH_MS = 20000;
  var TZ = 'America/Sao_Paulo';
  var token = new URLSearchParams(location.search).get('t') || '';
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
  var LABELS = { new: 'Pedido recebido', accepted: 'Aceito', preparing: 'Em preparo', ready: 'Pronto', awaiting_delivery: 'Aguardando entrega', completed: 'Concluído', cancelled: 'Cancelado' };
  var PAY = { approved: 'Pago', pending: 'Aguardando pagamento', in_process: 'Em análise', rejected: 'Recusado', cancelled: 'Cancelado', refunded: 'Reembolsado', charged_back: 'Contestado' };

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
    var status = d.fulfillment_status === 'delivered' ? 'completed' : d.fulfillment_status;
    $('t-code').textContent = d.public_code || '';
    var ol = $('t-timeline');
    ol.replaceChildren();
    var cancelled = status === 'cancelled';
    var current = STEPS.findIndex(function (s) { return s.key === status; });
    STEPS.forEach(function (s, i) {
      var label = s.key === 'awaiting_delivery' && pickup ? 'Aguardando retirada' : LABELS[s.key];
      var li = document.createElement('li');
      var state = cancelled ? (d[s.at] ? 'done' : 'todo') : i < current ? 'done' : i === current ? 'current' : 'todo';
      li.className = 'tl-step ' + state;
      var name = document.createElement('span'); name.className = 'tl-name'; name.textContent = label;
      li.append(name);
      if (d[s.at]) { var t = document.createElement('span'); t.className = 'tl-time'; t.textContent = when(d[s.at]); li.append(t); }
      if (state === 'current') li.setAttribute('aria-current', 'step');
      ol.append(li);
    });
    if (cancelled) {
      var c = document.createElement('li');
      c.className = 'tl-step cancelled';
      var n = document.createElement('span'); n.className = 'tl-name'; n.textContent = LABELS.cancelled;
      c.append(n);
      if (d.cancelled_at) { var tt = document.createElement('span'); tt.className = 'tl-time'; tt.textContent = when(d.cancelled_at); c.append(tt); }
      ol.append(c);
    }
    ol.hidden = false;
    $('t-msg').textContent = cancelled ? 'Este pedido foi cancelado. Se tiver dúvida, fale com a gente pelo WhatsApp.' : status === 'completed' ? 'Pedido concluído. Obrigada pela preferência!' : 'Situação atual: ' + (status === 'awaiting_delivery' && pickup ? 'aguardando retirada' : (d.fulfillment_label || LABELS[status] || '')).toLowerCase() + '.';
    $('t-pay').textContent = PAY[d.payment_status] || d.payment_status || '';
    $('t-total').textContent = Number.isInteger(d.total_cents) ? brl(d.total_cents) : '';
    $('t-created').textContent = when(d.created_at);
    $('t-info').hidden = false;
    $('t-note').hidden = status === 'completed' || cancelled;
    if (status === 'completed' || cancelled) stop();
  }

  function stop() { clearInterval(timer); timer = null; }

  async function load() {
    if (busy) return;
    busy = true;
    try {
      var r = await fetch('/api/order-status?t=' + encodeURIComponent(token), { cache: 'no-store' });
      if (r.status === 404) { stop(); $('t-code').textContent = ''; $('t-msg').textContent = 'Não encontramos esse pedido. Confira o link ou veja seus pedidos recentes abaixo.'; return; }
      if (!r.ok) { $('t-msg').textContent = 'Não foi possível atualizar agora. Tentamos de novo em instantes.'; return; }
      render(await r.json());
    } catch (e) {
      $('t-msg').textContent = 'Sem conexão. Tentamos de novo em instantes.';
    } finally { busy = false; }
  }

  showRecent();
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) {
    $('t-code').textContent = '';
    $('t-msg').textContent = token ? 'Link de acompanhamento inválido.' : 'Abra o link de acompanhamento que você recebeu, ou escolha um pedido recente abaixo.';
    return;
  }
  load();
  timer = setInterval(function () { if (!document.hidden) load(); }, REFRESH_MS);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && timer) load(); });
})();
