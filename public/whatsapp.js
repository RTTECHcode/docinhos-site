// Preenche o href dos links [data-wa] com o número de config.js (window.WHATSAPP_NUMBER).
// O HTML já traz um href estático; se config.js falhar ou o número for inválido, ele permanece.
(function () {
  var number = String(window.WHATSAPP_NUMBER || '').replace(/\D/g, '');
  if (!number) return;
  var DEFAULT = 'Olá! Gostaria de ver o cardápio e fazer um pedido.';
  document.querySelectorAll('[data-wa]').forEach(function (a) {
    a.href = 'https://wa.me/' + number + '?text=' + encodeURIComponent(a.getAttribute('data-wa-text') || DEFAULT);
  });
})();

// v4 N7 / A6-02: links [data-instagram] (Quem somos e rodapé). O endereço vem de /api/menu (settings.instagram_url, dos Ajustes do painel);
// se o servidor não mandar nada válido, vale window.INSTAGRAM_URL de config.js. Sem endereço válido, ficam escondidos
// (o elemento [data-instagram-item] em volta, se houver, também). O front valida de novo: só https://(www.)instagram.com/.
(function () {
  var links = document.querySelectorAll('[data-instagram]');
  if (!links.length) return;
  var RE = /^https:\/\/(www\.)?instagram\.com\/[A-Za-z0-9_.\/-]+$/;
  function valid(v) { v = String(v || '').trim(); return RE.test(v) ? v : ''; }
  function apply(url) {
    links.forEach(function (a) {
      var box = a.closest('[data-instagram-item]') || a;
      if (url) a.href = url;
      box.hidden = !url;
    });
  }
  apply(valid(window.INSTAGRAM_URL)); // reserva imediata (config.js)
  if (!window.fetch) return;
  fetch('/api/menu', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      var url = valid(d && d.settings && d.settings.instagram_url);
      if (url) apply(url);
    })
    .catch(function () { /* fica a reserva do config.js */ });
})();
