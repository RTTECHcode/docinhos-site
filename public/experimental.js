// N9 (v4): landing experimental. Só LÊ /api/menu (nada de pedido, login ou escrita).
// Tudo vira texto com textContent/createElement: nenhum dado do banco passa por innerHTML.
// Preços e frete são só exibidos como vêm do servidor; o pedido acontece no cardápio oficial (/).
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var brl = function (cents) {
    return 'R$ ' + (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  var hora = function (iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
  };
  var dia = function (iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('pt-BR', { weekday: 'long', timeZone: 'America/Sao_Paulo' });
  };
  var el = function (tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  // Caminho de imagem só do próprio site (a CSP já bloqueia o resto; aqui evita URL estranha).
  var imgSrc = function (p) {
    if (typeof p !== 'string' || p.charAt(0) !== '/' || p.charAt(1) === '/') return '';
    return encodeURI(p);
  };
  // Mesmo texto do cardápio oficial: com tamanhos, o preço é "a partir de".
  var priceText = function (p) {
    if (p.priceCents == null) return '';
    var hasSize = Array.isArray(p.complements) && p.complements.some(function (x) { return x && x.kind === 'size'; });
    return (hasSize ? 'a partir de ' : '') + brl(Number(p.priceCents) || 0);
  };

  function storeLine(store) {
    if (!store) return;
    var s = $('x-store');
    if (store.open) {
      s.textContent = store.closes_at ? 'Aberto agora · pedidos até ' + hora(store.closes_at) : 'Aberto agora';
      s.className = 'x-store is-open';
    } else {
      var next = store.reopens_at || store.next_open_at;
      s.textContent = next ? 'Fechado agora · abre ' + dia(next) + ' às ' + hora(next) : (store.message || 'Fechado agora');
      s.className = 'x-store is-closed';
    }
    s.hidden = false;
  }

  function trust(data) {
    var ship = data.shipping;
    if (ship && Array.isArray(ship.bands) && ship.bands.length) {
      var fees = ship.bands.map(function (b) { return Number(b.fee_cents) || 0; });
      var min = Math.min.apply(null, fees), max = Math.max.apply(null, fees);
      var km = Number(ship.maxKm) || ship.bands[ship.bands.length - 1].max_km;
      $('x-ship').textContent = 'até ' + km + ' km: ' + (min === max ? brl(min) : 'de ' + brl(min) + ' a ' + brl(max));
    }
    if (ship && Number(ship.pickupFeeCents) > 0) {
      $('x-pickup').textContent = 'retirada na loja: ' + brl(ship.pickupFeeCents);
      $('x-pickup').previousElementSibling.textContent = 'Retirada';
    }
    var pts = data.points;
    if (pts && pts.enabled && pts.blockPoints && pts.blockValueCents) {
      $('x-points').textContent = pts.blockPoints + ' pontos valem ' + brl(pts.blockValueCents) + ' de desconto';
      $('x-points-li').hidden = false;
    }
  }

  function card(p, cat) {
    var li = el('li', 'x-fav');
    var a = el('a', 'x-fav-link');
    a.href = '/#cat-' + encodeURIComponent(cat.id);
    var src = imgSrc(p.imagePath);
    if (src) {
      var img = el('img');
      img.src = src; img.alt = ''; img.width = 300; img.height = 300;
      img.loading = 'lazy'; img.decoding = 'async';
      a.appendChild(img);
    } else {
      a.appendChild(el('span', 'x-fav-ph'));
    }
    a.appendChild(el('span', 'x-fav-cat', cat.name));
    a.appendChild(el('strong', 'x-fav-name', p.name));
    var price = priceText(p);
    if (price) a.appendChild(el('span', 'x-fav-price', price));
    li.appendChild(a);
    return li;
  }

  function render(data) {
    var cats = (data.categories || []).filter(function (c) { return c && Array.isArray(c.products) && c.products.length; });
    var favs = $('x-favs'), list = $('x-cats');
    var art = [];
    cats.forEach(function (c) {
      var avail = c.products.filter(function (p) { return !p.paused; });
      var pick = avail.filter(function (p) { return imgSrc(p.imagePath); })[0] || avail[0];
      if (pick) {
        favs.appendChild(card(pick, c));
        if (imgSrc(pick.imagePath)) art.push(pick);
      }
      var li = el('li');
      var a = el('a', 'x-cat');
      a.href = '/#cat-' + encodeURIComponent(c.id);
      a.appendChild(el('strong', null, c.name));
      a.appendChild(el('span', null, c.products.length + (c.products.length === 1 ? ' opção' : ' opções')));
      li.appendChild(a);
      list.appendChild(li);
    });
    [['x-art-1', art[0]], ['x-art-2', art[1]]].forEach(function (pair) {
      if (!pair[1]) return;
      var img = $(pair[0]);
      img.src = imgSrc(pair[1].imagePath);
      img.hidden = false;
    });
    $('x-status').hidden = favs.children.length > 0;
    if (!favs.children.length) $('x-status').textContent = 'Os doces aparecem no cardápio completo.';
  }

  fetch('/api/menu', { credentials: 'same-origin' })
    .then(function (r) { if (!r.ok) throw new Error('menu'); return r.json(); })
    .then(function (data) { storeLine(data.store); trust(data); render(data); })
    .catch(function () { $('x-status').textContent = 'Não foi possível carregar os doces agora. Veja o cardápio completo.'; });
})();
