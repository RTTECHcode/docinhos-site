// Cloudflare Web Analytics: só carrega com token em config.js e nunca no painel, na conta ou no acompanhamento do pedido.
(function () {
  var token = String(window.CF_ANALYTICS_TOKEN || '').trim();
  if (!/^[A-Za-z0-9]{16,64}$/.test(token)) return;
  if (/^\/(admin|conta|pedido)/.test(location.pathname)) return;
  var s = document.createElement('script');
  s.defer = true;
  s.src = 'https://static.cloudflareinsights.com/beacon.min.js';
  s.setAttribute('data-cf-beacon', JSON.stringify({ token: token }));
  document.head.appendChild(s);
})();
