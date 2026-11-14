'use strict';
/* Avisos do painel (v4 U-06 e O-01).
   - Pedido pago novo (status_key "received"): som (arquivo /admin/pedido.wav), vibração e contagem no título da aba.
     O navegador só toca som depois de um toque: botão "Ativar som" (preferência guardada neste aparelho).
   - PWA: registra o service worker (/admin/sw.js, sem cache de dados) e oferece "Instalar o painel" quando o navegador deixa.
   - Web Push (contrato 10.9): "Receber notificações" neste aparelho. Sem chave VAPID no servidor o botão some e a tela explica.
   - Aviso de webhook recusado (health_detail.unauthorized_24h > 0).
   Nada de dado de cliente no console nem no título. */
(function () {
  const DG = window.DG;
  const { el, $ } = DG;
  const LS_SOUND = 'dg_sound_on';
  const BASE_TITLE = document.title;
  const st = { known: null, received: 0, soundOn: lsGet(), blocked: false, audio: null, timer: null, healthAt: 0, installEvt: null };

  function lsGet() { try { return localStorage.getItem(LS_SOUND) === '1'; } catch { return false; } }
  function lsSet(v) { try { localStorage.setItem(LS_SOUND, v ? '1' : '0'); } catch { /* sem storage */ } }
  const loggedIn = () => !!(DG.state.user && !$('#app').hidden);

  // ---------- som, vibração e título ----------
  function audio() { if (!st.audio) { st.audio = new Audio('/admin/pedido.wav'); st.audio.preload = 'auto'; } return st.audio; }
  async function playSound() {
    const a = audio();
    try { a.currentTime = 0; await a.play(); st.blocked = false; } catch { st.blocked = true; }
    paintButtons();
    return !st.blocked;
  }
  function paintTitle() {
    document.title = loggedIn() && st.received > 0 ? '(' + st.received + ') Pedidos pagos — Docinhos da Gigi' : BASE_TITLE;
  }
  function ring(count) {
    if (st.soundOn) playSound();
    try { if (navigator.vibrate) navigator.vibrate([220, 120, 220]); } catch { /* sem vibração */ }
    if (DG.state.tab !== 'orders') {
      const dot = $('#orders-dot'); if (dot) dot.hidden = false;
      DG.toast(count === 1 ? 'Chegou um pedido pago.' : 'Chegaram ' + count + ' pedidos pagos.');
    }
  }
  // Recebe a lista completa de pedidos (da aba Pedidos ou da checagem em segundo plano). Lista parcial (busca/filtro) é ignorada.
  function observe(orders, partial) {
    if (partial || !Array.isArray(orders)) return;
    const ids = orders.filter(o => o.status_key === 'received').map(o => o.id);
    st.received = ids.length;
    paintTitle();
    if (st.known) {
      const fresh = ids.filter(id => !st.known.has(id));
      if (fresh.length) ring(fresh.length);
    }
    st.known = new Set([...(st.known || []), ...ids]);
  }

  // Checagem em segundo plano: a cada 30 s. A aba Pedidos visível já busca sozinha (e chama observe), então pula.
  async function tick() {
    if (!loggedIn()) { st.known = null; st.received = 0; st.healthAt = 0; paintTitle(); return; }
    if (!(DG.state.tab === 'orders' && !document.hidden)) {
      try { observe((await DG.api('orders')).orders, false); } catch { /* tenta no próximo ciclo */ }
    }
    if (Date.now() - st.healthAt > 5 * 60000) checkHealth();
  }

  // ---------- O-01: webhook do Mercado Pago recusado ----------
  async function checkHealth() {
    st.healthAt = Date.now();
    let h;
    try { h = (await DG.api('health_detail')).health; } catch { return; }
    let bar = $('#webhook-warn');
    if (!(h && h.unauthorized_24h > 0)) { if (bar) bar.remove(); return; }
    const when = h.last_unauthorized_at ? ' Última tentativa recusada: ' + DG.fmtDate(h.last_unauthorized_at) + ' (' + h.unauthorized_24h + ' nas últimas 24 h).' : '';
    const text = 'O Mercado Pago tentou avisar pagamentos e foi recusado: confira a chave do webhook.' + when + ' Enquanto isso, use "Conferir pagamento" no pedido.';
    if (!bar) {
      bar = el('div', { id: 'webhook-warn', class: 'a5-warn wh-warn', role: 'alert' });
      $('#view').before(bar);
    }
    if (bar.textContent !== text) bar.textContent = text;
  }

  // ---------- botões de som ----------
  const buttons = new Set();
  function paintButtons() {
    for (const b of buttons) {
      // só descarta botão que já esteve na tela e saiu (o recém-criado ainda não foi colocado na página)
      if (b.isConnected) b.dataset.shown = '1';
      else if (b.dataset.shown) { buttons.delete(b); continue; }
      const on = st.soundOn && !st.blocked;
      b.setAttribute('aria-pressed', String(on));
      b.textContent = st.soundOn ? (st.blocked ? '🔔 Toque para ativar o som' : '🔔 Som ligado') : '🔕 Ativar som';
      b.classList.toggle('snd-off', !on);
    }
  }
  function soundButton(extraClass) {
    const b = el('button', { class: 'btn small snd-btn ' + (extraClass || ''), type: 'button', title: 'Som quando chegar pedido pago' });
    b.addEventListener('click', async () => {
      if (st.soundOn && !st.blocked) { st.soundOn = false; lsSet(false); paintButtons(); DG.toast('Som desligado neste aparelho.'); return; }
      st.soundOn = true; lsSet(true);
      if (await playSound()) DG.toast('Som ligado. Deixe o painel aberto para ouvir os pedidos pagos.');
      else DG.toast('O navegador bloqueou o som. Toque de novo ou libere o som deste site.', true);
    });
    buttons.add(b);
    paintButtons();
    return b;
  }
  // Depois de qualquer toque na página o navegador libera o som: tira o aviso de "bloqueado" sem tocar nada.
  ['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, () => { if (st.blocked) { st.blocked = false; paintButtons(); } }, { once: true, capture: true }));

  // ---------- PWA e push ----------
  const swReady = ('serviceWorker' in navigator) ? navigator.serviceWorker.register('/admin/sw.js', { scope: '/admin/' }).catch(() => null) : Promise.resolve(null);
  if ('serviceWorker' in navigator) {
    // clique na notificação com o painel já aberto: o service worker manda abrir Pedidos
    navigator.serviceWorker.addEventListener('message', e => { if (e.data && e.data.type === 'dg-open' && loggedIn()) DG.go('orders'); });
  }
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); st.installEvt = e; const b = $('#install-btn'); if (b) b.hidden = false; });
  window.addEventListener('hashchange', () => { if (location.hash === '#pedidos' && loggedIn()) DG.go('orders'); });

  const keyBytes = s => { const p = '='.repeat((4 - (s.length % 4)) % 4); const raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, c => c.charCodeAt(0)); };
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  function pushBox() {
    const box = el('div', { class: 'stack', 'aria-live': 'polite' }, DG.loading('Verificando notificações...'));
    const paint = async () => {
      let cfg;
      try { cfg = (await DG.api('push_config')).push; } catch (e) { box.replaceChildren(el('p', { class: 'error wrap', text: e.message })); return; }
      if (!cfg.enabled) {
        box.replaceChildren(el('p', { class: 'muted small wrap', text: 'Notificações no celular ainda não estão ligadas no servidor (falta cadastrar a chave VAPID na Vercel). Por enquanto, deixe o painel aberto com o som ligado.' }));
        return;
      }
      if (!pushSupported()) { box.replaceChildren(el('p', { class: 'muted small wrap', text: 'Este navegador não recebe notificações. No iPhone, instale o painel na tela de início (Compartilhar > Adicionar à Tela de Início) e abra por lá.' })); return; }
      const reg = await swReady;
      const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
      const devices = el('p', { class: 'muted small', text: cfg.devices + (cfg.devices === 1 ? ' aparelho recebe' : ' aparelhos recebem') + ' avisos nesta conta.' });
      if (Notification.permission === 'denied') {
        box.replaceChildren(el('p', { class: 'a5-warn wrap', text: 'As notificações deste site estão bloqueadas no navegador. Libere nas configurações do site e volte aqui.' }), devices);
        return;
      }
      if (sub) {
        box.replaceChildren(el('p', { class: 'wrap' }, el('strong', { text: 'Notificações ligadas neste aparelho.' })), devices,
          el('div', { class: 'row wrap-row' },
            el('button', { class: 'btn small', type: 'button', text: 'Enviar teste', on: { click: async function () {
              this.disabled = true;
              const r = await DG.run(() => DG.api('push_test', { body: {} }));
              if (r) DG.toast(r.sent ? 'Teste enviado. Deve chegar em instantes.' : 'Não consegui entregar o teste.', !r.sent);
              this.disabled = false;
            } } }),
            el('button', { class: 'btn small danger', type: 'button', text: 'Desligar neste aparelho', on: { click: async function () {
              this.disabled = true;
              try { await DG.api('push_unsubscribe', { body: { endpoint: sub.endpoint } }); } catch { /* remove local mesmo assim */ }
              await sub.unsubscribe().catch(() => {});
              DG.toast('Notificações desligadas neste aparelho.');
              paint();
            } } })));
        return;
      }
      box.replaceChildren(devices, el('button', { class: 'btn primary block', type: 'button', text: 'Receber notificações neste aparelho', on: { click: async function () {
        this.disabled = true;
        let s = null;
        try {
          if ((await Notification.requestPermission()) !== 'granted') throw new Error('Permissão de notificação não concedida.');
          if (!reg) throw new Error('Não consegui preparar o aparelho. Recarregue a página.');
          s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(cfg.public_key) });
          await DG.api('push_subscribe', { body: { subscription: s.toJSON() } });
          DG.toast('Pronto: este aparelho vai receber os pedidos pagos.');
        } catch (e) {
          if (s) await s.unsubscribe().catch(() => {});
          // erros do navegador vêm em inglês: troca por texto simples (os nossos já estão em português)
          const own = e && e.name === 'Error' && !e.code;
          DG.toast(own ? e.message : (e && e.status ? e.message : 'Este navegador não deixou ligar as notificações. Tente pelo painel instalado no celular.'), true);
        }
        paint();
      } } }));
    };
    paint();
    return box;
  }

  // Cartão "Avisos neste aparelho" (aba Conta).
  function card() {
    const install = el('button', { id: 'install-btn', class: 'btn block', type: 'button', text: 'Instalar o painel neste aparelho', hidden: !st.installEvt, on: { click: async function () {
      if (!st.installEvt) return;
      st.installEvt.prompt();
      try { await st.installEvt.userChoice; } catch { /* ignorado */ }
      st.installEvt = null; this.hidden = true;
    } } });
    return el('div', { class: 'card stack' },
      el('strong', { text: 'Som de pedido pago' }),
      el('p', { class: 'muted small wrap', text: 'Com o painel aberto (mesmo em outra aba), toca um som e vibra quando chega pedido pago. O título da aba mostra quantos esperam aceite.' }),
      el('div', { class: 'row wrap-row' }, soundButton(), el('button', { class: 'btn small', type: 'button', text: 'Testar som', on: { click: () => playSound() } })),
      el('strong', { text: 'Notificações' }),
      pushBox(),
      install);
  }

  DG.alerts = { observe, soundButton, card, checkHealth };
  // Ao abrir qualquer tela pela primeira vez depois do login, confere o webhook na hora (sem esperar a checagem de 30 s).
  const go = DG.go;
  DG.go = function (...args) { if (!st.healthAt && DG.state.user) checkHealth(); return go.apply(this, args); };
  // Primeira checagem logo depois do login; depois a cada 30 s.
  setTimeout(() => { tick(); st.timer = setInterval(tick, 30000); }, 3000);
})();
