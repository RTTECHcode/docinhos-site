// Preenche o href dos links [data-wa] com o número de config.js (window.WHATSAPP_NUMBER).
// O HTML já traz um href estático; se config.js falhar ou o número for inválido, ele permanece.
(function () {
  var number = String(window.WHATSAPP_NUMBER || '').replace(/\D/g, '');
  if (!number) return;
  var text = encodeURIComponent('Olá! Gostaria de ver o cardápio e fazer um pedido.');
  document.querySelectorAll('[data-wa]').forEach(function (a) {
    a.href = 'https://wa.me/' + number + '?text=' + text;
  });
})();
