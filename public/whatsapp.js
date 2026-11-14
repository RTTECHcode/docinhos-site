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

// v4 N7: links [data-instagram] recebem o endereço de config.js (window.INSTAGRAM_URL). Sem endereço válido, ficam escondidos
// (o elemento [data-instagram-item] em volta, se houver, também).
(function () {
  var url = String(window.INSTAGRAM_URL || '').trim();
  var ok = /^https:\/\/(www\.)?instagram\.com\/[A-Za-z0-9_.\/-]+$/.test(url);
  document.querySelectorAll('[data-instagram]').forEach(function (a) {
    var box = a.closest('[data-instagram-item]') || a;
    if (ok) a.href = url;
    box.hidden = !ok;
  });
})();
