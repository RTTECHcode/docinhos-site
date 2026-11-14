'use strict';
/* Painel /admin - núcleo: helpers, API, login, navegação e aba Conta.
   Regra: dado vindo do servidor só entra na tela via textContent / createElement (nunca innerHTML). */
(function () {
  const DG = window.DG = { state: { user: null, catalog: null, tab: 'orders' }, tabs: {} };
  const $ = sel => document.querySelector(sel);
  DG.$ = $;

  DG.el = function (tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
      else if (k === 'value') node.value = v;
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, String(v));
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  };
  const el = DG.el;
  // Estados padrão (classes .is-loading e .empty-state em admin.css): use estes em vez de um p.muted solto.
  DG.loading = text => el('p', { class: 'is-loading', role: 'status', text: text || 'Carregando...' });
  DG.empty = text => el('p', { class: 'empty-state', text });

  // append/replaceChildren nativos transformam null/false em texto ("null"). Aqui eles passam a ignorar esses valores,
  // para que condicionais como `cond ? el(...) : null` funcionem em qualquer ponto da interface.
  for (const method of ['append', 'prepend', 'replaceChildren']) {
    const native = Element.prototype[method];
    Element.prototype[method] = function (...kids) { return native.apply(this, kids.filter(k => k !== null && k !== undefined && k !== false)); };
  }

  DG.money = cents => (cents === null || cents === undefined ? 'sem preço' : (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
  DG.parseMoney = text => {
    let s = String(text || '').replace(/[^\d,.]/g, '');
    if (!s) return null;
    s = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : NaN;
  };
  DG.moneyInput = cents => (cents === null || cents === undefined ? '' : (cents / 100).toFixed(2).replace('.', ','));
  // v4 N1: situação única do pedido. A API manda status_key (cor) e status_label (texto); a tela não monta rótulo.
  const STATUS_CLASS = { awaiting_payment: 'warn', payment_failed: 'off', refunded: 'off', cancelled: 'off', received: 'ok', completed: 'ok' };
  DG.statusPill = o => el('span', { class: 'pill st-' + (o.status_key || 'x') + ' ' + (STATUS_CLASS[o.status_key] || ''), text: o.status_label || o.fulfillment_label || o.fulfillment_status || '' });
  DG.isAdmin = () => !!(DG.state.user && DG.state.user.role === 'admin');
  // v4: datas no fuso da loja (São Paulo). daySP devolve AAAA-MM-DD (para <input type="date">), fmtDay mostra dd/mm/aaaa.
  DG.daySP = iso => (iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }) : '');
  DG.fmtDay = iso => (iso ? new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '');
  DG.todaySP = () => DG.daySP(new Date().toISOString());
  // v4: partes do pedido usadas em Pedidos e Histórico (mesmo desenho nos dois).
  // Destaques: agendamento (N10) e mimo pendente do cliente (N8). Textos vêm prontos da API.
  DG.orderFlags = o => [
    o.scheduled_label ? el('span', { class: 'pill sched', text: o.scheduled_label }) : null,
    o.gift ? el('span', { class: 'pill gift', text: 'Mimo: ' + o.gift.label }) : null
  ].filter(Boolean);
  // Itens: prêmio do Clube aparece como "Prêmio do Clube" (não cobra), não como R$ 0,00.
  DG.orderItems = items => (Array.isArray(items) ? items : []).map(i => el('div', { class: 'card' + (i.reward ? ' item-reward' : '') },
    el('div', { class: 'row between' }, el('strong', { class: 'wrap', text: (i.qty || 1) + 'x ' + (i.name || '') }),
      i.reward ? el('span', { class: 'pill club-cost', text: 'Prêmio do Clube' }) : el('span', { text: DG.money((i.unit_total_cents || 0) * (i.qty || 1)) })),
    i.size ? el('p', { class: 'muted small wrap', text: 'Tamanho: ' + i.size }) : null,
    Array.isArray(i.extras) && i.extras.length ? el('p', { class: 'muted small wrap', text: 'Extras: ' + i.extras.map(x => (x && x.name) || x).join(', ') }) : null,
    i.reward && i.points_cost ? el('p', { class: 'muted small', text: 'Trocado por ' + Number(i.points_cost).toLocaleString('pt-BR') + ' pontos' }) : null));
  // Totais: todos os valores vêm do servidor; a tela só mostra.
  DG.orderTotals = o => {
    const line = (label, value, strong) => el('div', { class: 'row between' }, el(strong ? 'strong' : 'span', { class: 'wrap', text: label }), el(strong ? 'strong' : 'span', { text: value }));
    return el('div', { class: 'card' },
      line('Subtotal', DG.money(o.subtotal_cents)),
      line('Entrega', DG.money(o.delivery_fee_cents)),
      o.coupon_code ? line('Cupom ' + o.coupon_code, '- ' + DG.money(o.coupon_discount_cents || o.discount_cents || 0))
        : (o.discount_cents ? line('Desconto' + (o.points_redeemed ? ' (' + o.points_redeemed + ' pontos)' : ''), '- ' + DG.money(o.discount_cents)) : null),
      o.club_points ? line('Pontos do Clube usados', Number(o.club_points).toLocaleString('pt-BR') + ' pontos') : null,
      line('Total', DG.money(o.total_cents), true));
  };
  // Mimo da avaliação no Google (N8). Pedido com mimo pendente: mostra e deixa cancelar.
  // Sem mimo: "Cliente avaliou" registra o mimo para o PRÓXIMO pedido desse telefone (o servidor recusa se já houver um pendente).
  DG.giftBox = (o, onChange) => {
    const box = el('div', { class: 'card stack gift-box', 'aria-live': 'polite' });
    const paint = () => {
      if (o.gift) {
        box.replaceChildren(
          el('strong', { class: 'wrap', text: 'Mimo para entregar: ' + o.gift.label }),
          el('p', { class: 'muted small wrap', text: 'O cliente avaliou a loja. Mande o mimo junto com este pedido; ao concluir, ele fica como entregue.' }),
          el('button', { class: 'btn small danger', type: 'button', text: 'Cancelar mimo', on: { click: async function () {
            if (!(await DG.confirm('Cancelar o mimo "' + o.gift.label + '"?', 'Cancelar mimo', true))) return;
            this.disabled = true;
            if (await DG.run(() => DG.api('gift_cancel', { body: { id: o.gift.id } }), 'Mimo cancelado.')) { o.gift = null; paint(); if (onChange) onChange(); } else this.disabled = false;
          } } }));
        return;
      }
      if (o.fulfillment_status === 'cancelled') { box.hidden = true; return; }
      box.replaceChildren(
        el('p', { class: 'muted small wrap', text: 'O cliente avaliou a loja no Google? Registre o mimo: ele aparece no próximo pedido deste telefone.' }),
        el('button', { class: 'btn small', type: 'button', text: 'Cliente avaliou: dar mimo', on: { click: async function () {
          this.disabled = true;
          const r = await DG.run(() => DG.api('gift_grant', { body: { order_id: o.id } }));
          if (r && r.gift) { box.replaceChildren(el('p', { class: 'wrap', role: 'status', text: 'Mimo registrado (' + r.gift.label + '). Ele aparece no próximo pedido deste cliente.' })); DG.toast('Mimo registrado.'); }
          else this.disabled = false;
        } } }));
    };
    paint();
    return box;
  };
  // Campo numérico inteiro com rótulo. Lê com DG.readInt(input, min, max, rótulo): número ou { problem }.
  DG.intField = (label, value, min, max) => {
    const input = el('input', { type: 'number', inputmode: 'numeric', step: 1, min, max, value: value === null || value === undefined ? '' : String(value) });
    return { input, field: el('label', { class: 'field' }, el('span', { text: label }), input) };
  };
  DG.readInt = (input, min, max, label, optional) => {
    const raw = String(input.value).trim();
    if (raw === '' && optional) return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) return { problem: label + ': use um número inteiro de ' + min.toLocaleString('pt-BR') + ' a ' + max.toLocaleString('pt-BR') + '.' };
    return n;
  };
  DG.fmtDate = iso => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  let toastTimer = null;
  DG.toast = (message, isError) => {
    const t = $('#toast');
    t.textContent = message;
    t.className = 'toast show' + (isError ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; }, 2800);
  };

  DG.api = async function (action, { body, query } = {}) {
    const qs = new URLSearchParams({ a: action, ...(query || {}) }).toString();
    const opts = { credentials: 'same-origin', cache: 'no-store' };
    if (body) { opts.method = 'POST'; opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
    let res;
    try { res = await fetch('/api/admin?' + qs, opts); } catch { throw new Error('Sem conexão. Tente de novo.'); }
    let data = {};
    try { data = await res.json(); } catch { /* corpo vazio */ }
    if (res.status === 401 && action !== 'login') { showLogin(); throw new Error(data.error || 'Sessão expirada.'); }
    if (!res.ok) {
      const err = new Error(data.error || 'Algo deu errado. Tente de novo.');
      err.status = res.status; err.code = data.code;
      if (res.status === 403 && data.code === 'security_setup_required' && DG.forceSecurity) DG.forceSecurity();
      else if (res.status === 403 && data.code === 'password_change_required') DG.forcePasswordChange();
      throw err;
    }
    if (data.user) setUser(data.user);
    return data;
  };
  DG.run = async (fn, okMessage) => {
    try { const r = await fn(); if (okMessage) DG.toast(okMessage); return r; } catch (e) { DG.toast(e.message, true); return undefined; }
  };

  // ---- sheet e confirmação ----
  // Interruptor play/pause acessível. onChange(próximoValor) deve retornar false se falhar (o botão volta ao valor confirmado).
  // B2: o clique atualiza na hora e os envios ao servidor são feitos em fila (um por vez, em ordem); se o usuário clicar várias
  // vezes enquanto um envio está em andamento, só o último valor desejado é enviado depois. Assim o estado final no servidor
  // sempre bate com o último clique (antes o botão ficava desabilitado e cliques rápidos eram perdidos ou chegavam fora de ordem).
  DG.switchEl = (checked, label, onChange, big) => {
    const b = el('button', { class: 'switch' + (big ? ' big' : ''), type: 'button', role: 'switch', 'aria-checked': String(!!checked), 'aria-label': label });
    let confirmed = !!checked; // último valor aceito pelo servidor
    let wanted = confirmed;    // último valor pedido pelo usuário
    let busy = false;
    const show = v => b.setAttribute('aria-checked', String(v));
    async function flush() {
      busy = true;
      while (wanted !== confirmed) {
        const target = wanted;
        let ok;
        try { ok = await onChange(target); } catch { ok = false; }
        if (ok === false) { wanted = confirmed; show(confirmed); break; }
        confirmed = target;
      }
      busy = false;
    }
    b.addEventListener('click', () => {
      wanted = !wanted;
      show(wanted);
      if (!busy) flush();
    });
    return b;
  };

  // ---- sheets (pop-ups) com histórico do navegador (B3) e animação de fechar (B5) ----
  // Cada sheet aberto empilha uma entrada no histórico; o botão voltar (popstate) fecha o sheet do topo.
  // Fechar pelo X/fundo/botões consome a própria entrada com history.back() (ignorando o popstate resultante).
  const sheetStack = [];
  let ignorePops = 0;      // popstates causados por history.back() nosso
  const afterPops = [];    // pushState adiado enquanto há history.back() pendente
  function runAfterPops() { while (!ignorePops && afterPops.length) afterPops.shift()(); }
  window.addEventListener('popstate', () => {
    if (ignorePops > 0) { ignorePops--; runAfterPops(); return; }
    const top = sheetStack[sheetStack.length - 1];
    if (top) top.dismiss(false);
  });

  DG.sheet = function (title, build, onClose) {
    const root = $('#overlay-root');
    const body = el('div', { class: 'stack' });
    const entry = { pushed: false, closed: false };
    function dismiss(fromUi) {
      if (entry.closed) return;
      entry.closed = true;
      const i = sheetStack.indexOf(entry);
      const wasTop = i === sheetStack.length - 1;
      if (i >= 0) sheetStack.splice(i, 1);
      if (entry.pushed && fromUi && wasTop) { ignorePops++; history.back(); }
      backdrop.classList.add('closing');
      let gone = false;
      const remove = () => { if (!gone) { gone = true; backdrop.remove(); } };
      sheet.addEventListener('animationend', remove, { once: true });
      setTimeout(remove, 320);
      if (onClose) onClose();
    }
    entry.dismiss = dismiss;
    const close = () => dismiss(true);
    const sheet = el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      el('div', { class: 'sheet-head' }, el('h2', { text: title }), el('button', { class: 'x', type: 'button', 'aria-label': 'Fechar', text: '×', on: { click: close } })),
      body);
    const backdrop = el('div', { class: 'backdrop', on: { click: e => { if (e.target === backdrop) close(); } } }, sheet);
    root.append(backdrop);
    sheetStack.push(entry);
    const push = () => { if (entry.closed) return; history.pushState({ dgSheet: true }, ''); entry.pushed = true; };
    if (ignorePops) afterPops.push(push); else push();
    build(body, close);
    return close;
  };
  DG.confirm = (message, okLabel, danger) => new Promise(resolve => {
    // resolve(valor) vem antes de close(): voltar/fechar sem escolher cai no onClose e cancela (resolve(false)).
    DG.sheet('Confirmar', (body, close) => {
      body.append(el('p', { text: message, class: 'wrap' }), el('div', { class: 'grid2' },
        el('button', { class: 'btn', type: 'button', text: 'Cancelar', on: { click: () => { resolve(false); close(); } } }),
        el('button', { class: 'btn ' + (danger ? 'danger solid' : 'primary'), type: 'button', text: okLabel || 'Confirmar', on: { click: () => { resolve(true); close(); } } })));
    }, () => resolve(false));
  });

  // ---- usuário, abas ----
  function setUser(u) {
    DG.state.user = u;
    $('#weak-banner').hidden = !u.weakPassword;
  }
  function showLogin() {
    stopTab();
    $('#app').hidden = true;
    $('#login-view').hidden = false;
    $('#overlay-root').replaceChildren();
    sheetStack.length = 0;
  }
  function stopTab() { const t = DG.tabs[DG.state.tab]; if (t && t.stop) t.stop(); }
  // v4: telas que ficam dentro de "Mais" (a barra de baixo não cabe mais abas no celular).
  const SUB_TABS = { club: 'Clube', coupons: 'Cupons e WhatsApp', reports: 'Relatórios', account: 'Conta' };
  DG.go = async function (tab) {
    if (!DG.tabs[tab]) tab = 'orders';
    stopTab();
    DG.state.tab = tab;
    const navTab = SUB_TABS[tab] ? 'more' : tab;
    document.querySelectorAll('#tabbar button').forEach(b => { if (b.dataset.tab === navTab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    const view = $('#view');
    let target = view;
    if (SUB_TABS[tab]) {
      target = el('div', { class: 'sub-body' }, DG.loading());
      view.replaceChildren(el('div', { class: 'sub-head' },
        el('button', { class: 'btn small', type: 'button', text: '‹ Mais', 'aria-label': 'Voltar para Mais', on: { click: () => DG.go('more') } }),
        el('h2', { class: 'sub-title', text: SUB_TABS[tab] })), target);
    } else view.replaceChildren(DG.loading());
    window.scrollTo(0, 0);
    try { await DG.tabs[tab].render(target); } catch (e) { if (DG.state.tab === tab) target.replaceChildren(el('p', { class: 'error', text: e.message })); }
  };
  DG.reload = () => DG.go(DG.state.tab);
  DG.loadCatalog = async () => { DG.state.catalog = await DG.api('catalog'); return DG.state.catalog; };
  DG.setStoreBadge = paused => { $('#store-badge').hidden = !paused; };

  async function boot() {
    try { await DG.api('me'); } catch { return; }
    $('#login-view').hidden = true;
    if (DG.state.user && DG.state.user.needsSecurity && DG.forceSecurity) { DG.forceSecurity(); return; }
    if (DG.state.user && DG.state.user.weakPassword) { DG.forcePasswordChange(); return; }
    $('#app').hidden = false;
    DG.go(DG.state.tab);
  }

  // Rótulos em pt-BR para eventos da atividade; os de AUDIT_WARN aparecem em destaque (pedem ação de alguém).
  const AUDIT_LABELS = { pagamento_apos_cancelamento: 'Pagamento recebido após cancelamento – verificar devolução' };
  const AUDIT_WARN = new Set(['pagamento_apos_cancelamento']);

  // ---- aba Mais (v4): atalhos para Clube, Cupons, Relatórios e Conta ----
  DG.tabs.more = {
    render(view) {
      const admin = DG.isAdmin();
      const item = (tab, title, sub, icon) => el('button', { class: 'card item-btn more-item', type: 'button', on: { click: () => DG.go(tab) } },
        el('span', { class: 'more-ico', 'aria-hidden': 'true', text: icon }),
        el('span', { class: 'grow' }, el('strong', { class: 'more-t', text: title }), el('span', { class: 'muted small more-s', text: sub })),
        el('span', { class: 'more-go', 'aria-hidden': 'true', text: '›' }));
      view.replaceChildren(
        el('h2', { class: 'section-title', text: 'Mais' }),
        item('club', 'Clube de pontos', admin ? 'Prêmios que o cliente troca por pontos e pontos por real.' : 'Prêmios do Clube (só leitura).', '★'),
        admin ? item('coupons', 'Cupons e WhatsApp', 'Criar cupons e montar envios pelo WhatsApp.', '%') : null,
        admin ? item('reports', 'Relatórios', 'Clientes e vendas, com exportação em planilha.', '▤') : null,
        item('account', 'Conta e avisos', 'Senha, avisos de pedido neste aparelho, usuários e atividade.', '☺'));
    }
  };

  // ---- aba Conta ----
  DG.tabs.account = {
    async render(view) {
      const u = DG.state.user;
      view.replaceChildren(
        el('div', { class: 'card' }, el('div', { class: 'row between' }, el('div', {}, el('strong', { text: u.username }), el('p', { class: 'muted small', text: u.role === 'admin' ? 'Administrador' : 'Equipe' })),
          el('button', { class: 'btn', type: 'button', text: 'Sair', on: { click: logout } }))),
        el('h2', { class: 'section-title', text: 'Trocar senha' }), passwordForm(),
        u.role === 'admin' ? el('div', { id: 'users-box' }) : null,
        el('h2', { class: 'section-title', text: 'Atividade recente' }), el('div', { id: 'audit-box', class: 'card' }, DG.loading()));
      DG.api('audit').then(r => {
        const box = $('#audit-box');
        if (!box) return;
        // P2: começa recolhida, mostrando só os 5 primeiros; "Ver mais" expande o resto.
        let open = false;
        const LIMIT = 5;
        const paintAudit = () => {
          const rows = open ? r.rows : r.rows.slice(0, LIMIT);
          const items = rows.length ? rows.map(a => el('div', { class: 'audit' + (AUDIT_WARN.has(a.action) ? ' warn' : ''), role: AUDIT_WARN.has(a.action) ? 'note' : null },
          el('strong', { text: AUDIT_LABELS[a.action] || a.action.replace(/_/g, ' ') }),
          el('span', { class: 'muted wrap', text: DG.fmtDate(a.at) + ' - ' + (a.username || 'sistema') + (a.detail ? ' - ' + a.detail : '') }))) : [DG.empty('Nada registrado ainda.')];
          const more = r.rows.length > LIMIT ? el('button', { class: 'btn block', type: 'button', 'aria-expanded': String(open),
            text: open ? 'Recolher' : 'Ver mais (' + (r.rows.length - LIMIT) + ')', on: { click: () => { open = !open; paintAudit(); } } }) : null;
          box.replaceChildren(...items, ...(more ? [more] : []));
        };
        paintAudit();
      }).catch(() => {});
      if (u.role === 'admin') loadUsers();
    }
  };
  async function logout() { await DG.run(() => DG.api('logout', { body: {} })); showLogin(); }

  function passwordForm() {
    const cur = el('input', { type: 'password', autocomplete: 'current-password', maxlength: 256 });
    const nw = el('input', { type: 'password', autocomplete: 'new-password', maxlength: 128 });
    const msg = el('p', { class: 'error', hidden: true });
    const form = el('form', { class: 'card stack', novalidate: true, on: { submit: async e => {
      e.preventDefault();
      msg.hidden = true;
      const r = await DG.run(() => DG.api('password_change', { body: { current_password: cur.value, new_password: nw.value } }), 'Senha alterada.').catch(() => undefined);
      if (r) { cur.value = ''; nw.value = ''; } else { msg.hidden = true; }
    } } },
    el('label', { class: 'field' }, el('span', { text: 'Senha atual' }), cur),
    el('label', { class: 'field' }, el('span', { text: 'Nova senha (mínimo 8 caracteres)' }), nw),
    msg, el('button', { class: 'btn primary block', type: 'submit', text: 'Salvar nova senha' }));
    return form;
  }

  // Tela obrigatória de troca de senha (F5, A1-06): o servidor bloqueia tudo com 403 password_change_required
  // enquanto a senha for fraca. Mesmo padrão da tela da pergunta de segurança; ao trocar, recarrega o painel.
  let pwLock = null;
  DG.forcePasswordChange = function () {
    if (pwLock) return;
    stopTab();
    $('#app').hidden = true;
    $('#login-view').hidden = true;
    $('#overlay-root').replaceChildren();
    sheetStack.length = 0;
    const cur = el('input', { type: 'password', autocomplete: 'current-password', maxlength: 256, required: true });
    const nw = el('input', { type: 'password', autocomplete: 'new-password', maxlength: 128, minlength: 8, required: true });
    const again = el('input', { type: 'password', autocomplete: 'new-password', maxlength: 128, required: true });
    const err = el('p', { class: 'error wrap', role: 'alert', hidden: true });
    const save = el('button', { class: 'btn primary block', type: 'submit', text: 'Salvar nova senha' });
    const show = t => { err.textContent = t; err.hidden = false; };
    const form = el('form', { class: 'stack', novalidate: true, on: { submit: async e => {
      e.preventDefault();
      err.hidden = true;
      if (!cur.value) return show('Digite a sua senha atual.');
      if (nw.value.length < 8) return show('A nova senha precisa ter pelo menos 8 caracteres.');
      if (nw.value !== again.value) return show('As duas senhas novas não são iguais.');
      save.disabled = true;
      try {
        await DG.api('password_change', { body: { current_password: cur.value, new_password: nw.value } });
        DG.toast('Senha alterada.');
        location.reload();
      } catch (ex) { show(ex.message); save.disabled = false; }
    } } },
    el('label', { class: 'field' }, el('span', { text: 'Senha atual' }), cur),
    el('label', { class: 'field' }, el('span', { text: 'Nova senha (mínimo 8 caracteres)' }), nw),
    el('label', { class: 'field' }, el('span', { text: 'Repita a nova senha' }), again),
    err, save);
    const card = el('div', { class: 'login-card' }, el('h1', { text: 'Troque a sua senha' }),
      el('p', { class: 'muted wrap', text: 'Sua senha atual é fraca. Para continuar usando o painel, escolha uma senha nova.' }),
      form,
      el('button', { class: 'btn block', type: 'button', text: 'Sair', on: { click: async () => { await DG.run(() => DG.api('logout', { body: {} })); location.reload(); } } }));
    pwLock = el('main', { class: 'login a5-lock', 'aria-label': 'Troca de senha obrigatória' }, card);
    document.body.append(pwLock);
    cur.focus();
  };

  async function loadUsers() {
    const box = $('#users-box');
    if (!box) return;
    const r = await DG.api('users').catch(() => null);
    if (!r) return;
    box.replaceChildren(el('h2', { class: 'section-title', text: 'Usuários' }),
      ...r.users.map(u => el('div', { class: 'card' }, el('div', { class: 'row between' },
        el('div', { class: 'grow' }, el('strong', { text: u.username }), el('p', { class: 'muted small', text: (u.role === 'admin' ? 'Administrador' : 'Equipe') + (u.active ? '' : ' - desativado') + (u.weak_password ? ' - senha fraca' : '') })),
        el('button', { class: 'btn small', type: 'button', text: 'Nova senha', on: { click: () => resetPassword(u) } }),
        u.username === DG.state.user.username ? null : el('button', { class: 'btn small' + (u.active ? ' danger' : ''), type: 'button', text: u.active ? 'Desativar' : 'Ativar', on: { click: async () => {
          if (u.active && !(await DG.confirm('Desativar o usuário ' + u.username + '?', 'Desativar', true))) return;
          await DG.run(() => DG.api('user_toggle', { body: { id: u.id, active: !u.active } }), 'Pronto.');
          loadUsers();
        } } })))),
      el('button', { class: 'btn block', type: 'button', text: 'Criar usuário', on: { click: createUser } }));
  }
  function resetPassword(u) {
    DG.sheet('Nova senha de ' + u.username, (body, close) => {
      const pw = el('input', { type: 'password', autocomplete: 'new-password', maxlength: 128 });
      body.append(el('label', { class: 'field' }, el('span', { text: 'Nova senha (mínimo 8 caracteres)' }), pw),
        el('button', { class: 'btn primary block', type: 'button', text: 'Salvar', on: { click: async () => {
          if (await DG.run(() => DG.api('user_reset', { body: { id: u.id, new_password: pw.value } }), 'Senha redefinida.')) { close(); loadUsers(); }
        } } }));
    });
  }
  function createUser() {
    DG.sheet('Novo usuário', (body, close) => {
      const name = el('input', { type: 'text', autocapitalize: 'none', maxlength: 32 });
      const pw = el('input', { type: 'password', autocomplete: 'new-password', maxlength: 128 });
      const role = el('select', {}, el('option', { value: 'staff', text: 'Equipe' }), el('option', { value: 'admin', text: 'Administrador' }));
      body.append(el('label', { class: 'field' }, el('span', { text: 'Usuário' }), name), el('label', { class: 'field' }, el('span', { text: 'Senha (mínimo 8 caracteres)' }), pw),
        el('label', { class: 'field' }, el('span', { text: 'Perfil' }), role),
        el('button', { class: 'btn primary block', type: 'button', text: 'Criar', on: { click: async () => {
          if (await DG.run(() => DG.api('user_create', { body: { username: name.value, password: pw.value, role: role.value } }), 'Usuário criado.')) { close(); loadUsers(); }
        } } }));
    });
  }

  // ---- inicialização ----
  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#login-error'), btn = $('#login-submit');
    err.hidden = true; btn.disabled = true;
    try {
      await DG.api('login', { body: { username: $('#login-user').value, password: $('#login-pass').value } });
      $('#login-pass').value = '';
      await boot();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    btn.disabled = false;
  });
  $('#tabbar').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) DG.go(b.dataset.tab); });
  $('#login-forgot').addEventListener('click', () => { if (DG.forgotPassword) DG.forgotPassword(); });
  $('#weak-banner').addEventListener('click', () => DG.go('account'));
  boot().then(() => { if (!DG.state.user) { $('#login-view').hidden = false; } });
})();
