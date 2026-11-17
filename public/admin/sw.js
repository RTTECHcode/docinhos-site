'use strict';
/* Service worker do painel (v4 U-06). Escopo /admin/.
   Só existe para o painel ser instalável e para receber o aviso (Web Push) de pedido pago.
   NÃO guarda nada em cache: sem evento fetch, sem Cache Storage. Pedido e cliente vêm sempre da rede, com login. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// Conteúdo do aviso (sem dado pessoal): { title: "Pedido DG-1234 pago", body: "R$ 45,90", tag, url: "/admin/#pedidos" }
self.addEventListener('push', event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = {}; }
  const url = typeof d.url === 'string' && d.url.startsWith('/admin/') ? d.url : '/admin/#pedidos';
  event.waitUntil(self.registration.showNotification(d.title || 'Pedido pago', {
    body: d.body || '', tag: d.tag || 'pedido', data: { url }, icon: '/admin/icons/icon-192.png', badge: '/admin/icons/icon-192.png', renotify: true
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/admin/#pedidos';
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if (new URL(c.url).pathname.startsWith('/admin/')) {
        c.postMessage({ type: 'dg-open', url });
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
