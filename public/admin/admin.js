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
    if (!res.ok) throw new Error(data.error || 'Algo deu errado. Tente de novo.');
    if (data.user) setUser(data.user);
    return data;
  };
  DG.run = async (fn, okMessage) => {
    try { const r = await fn(); if (okMessage) DG.toast(okMessage); return r; } catch (e) { DG.toast(e.message, true); return undefined; }
  };

  // ---- sheet e confirmação ----
  // Interruptor play/pause acessível. onChange(próximoValor) deve retornar false se falhar (o botão não muda).
  DG.switchEl = (checked, label, onChange, big) => {
    const b = el('button', { class: 'switch' + (big ? ' big' : ''), type: 'button', role: 'switch', 'aria-checked': String(!!checked), 'aria-label': label });
    b.addEventListener('click', async () => {
      const next = b.getAttribute('aria-checked') !== 'true';
      b.disabled = true;
      const ok = await onChange(next);
      b.disabled = false;
      if (ok !== false) b.setAttribute('aria-checked', String(next));
    });
    return b;
  };

  DG.sheet = function (title, build, onClose) {
    const root = $('#overlay-root');
    const body = el('div', { class: 'stack' });
    const close = () => { backdrop.remove(); if (onClose) onClose(); };
    const sheet = el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      el('div', { class: 'sheet-head' }, el('h2', { text: title }), el('button', { class: 'x', type: 'button', 'aria-label': 'Fechar', text: '×', on: { click: close } })),
      body);
    const backdrop = el('div', { class: 'backdrop', on: { click: e => { if (e.target === backdrop) close(); } } }, sheet);
    root.append(backdrop);
    build(body, close);
    return close;
  };
  DG.confirm = (message, okLabel, danger) => new Promise(resolve => {
    DG.sheet('Confirmar', (body, close) => {
      body.append(el('p', { text: message, class: 'wrap' }), el('div', { class: 'grid2' },
        el('button', { class: 'btn', type: 'button', text: 'Cancelar', on: { click: () => { close(); resolve(false); } } }),
        el('button', { class: 'btn ' + (danger ? 'danger solid' : 'primary'), type: 'button', text: okLabel || 'Confirmar', on: { click: () => { close(); resolve(true); } } })));
    });
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
  }
  function stopTab() { const t = DG.tabs[DG.state.tab]; if (t && t.stop) t.stop(); }
  DG.go = async function (tab) {
    stopTab();
    DG.state.tab = tab;
    document.querySelectorAll('#tabbar button').forEach(b => { if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    const view = $('#view');
    view.replaceChildren(el('p', { class: 'muted', text: 'Carregando...' }));
    window.scrollTo(0, 0);
    try { await DG.tabs[tab].render(view); } catch (e) { if (DG.state.tab === tab) view.replaceChildren(el('p', { class: 'error', text: e.message })); }
  };
  DG.reload = () => DG.go(DG.state.tab);
  DG.loadCatalog = async () => { DG.state.catalog = await DG.api('catalog'); return DG.state.catalog; };
  DG.setStoreBadge = paused => { $('#store-badge').hidden = !paused; };

  async function boot() {
    try { await DG.api('me'); } catch { return; }
    $('#login-view').hidden = true;
    $('#app').hidden = false;
    DG.go(DG.state.tab);
  }

  // ---- aba Conta ----
  DG.tabs.account = {
    async render(view) {
      const u = DG.state.user;
      view.replaceChildren(
        el('div', { class: 'card' }, el('div', { class: 'row between' }, el('div', {}, el('strong', { text: u.username }), el('p', { class: 'muted small', text: u.role === 'admin' ? 'Administrador' : 'Equipe' })),
          el('button', { class: 'btn', type: 'button', text: 'Sair', on: { click: logout } }))),
        el('h2', { class: 'section-title', text: 'Trocar senha' }), passwordForm(),
        u.role === 'admin' ? el('div', { id: 'users-box' }) : null,
        el('h2', { class: 'section-title', text: 'Atividade recente' }), el('div', { id: 'audit-box', class: 'card' }, el('p', { class: 'muted', text: 'Carregando...' })));
      DG.api('audit').then(r => {
        const box = $('#audit-box');
        if (!box) return;
        box.replaceChildren(...(r.rows.length ? r.rows.map(a => el('div', { class: 'audit' }, el('strong', { text: a.action.replace(/_/g, ' ') }),
          el('span', { class: 'muted wrap', text: DG.fmtDate(a.at) + ' - ' + (a.username || 'sistema') + (a.detail ? ' - ' + a.detail : '') }))) : [el('p', { class: 'muted', text: 'Nada registrado.' })]));
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

  async function loadUsers() {
    const box = $('#users-box');
    if (!box) return;
    const r = await DG.api('users').catch(() => null);
    if (!r) return;
    box.replaceChildren(el('h2', { class: 'section-title', text: 'Usuários' }),
      ...r.users.map(u => el('div', { class: 'card' }, el('div', { class: 'row between' },
        el('div', { class: 'grow' }, el('strong', { text: u.username }), el('p', { class: 'muted small', text: (u.role === 'admin' ? 'Administrador' : 'Equipe') + (u.active ? '' : ' - desativado') + (u.weak_password ? ' - senha fraca' : '') })),
        el('button', { class: 'btn small', type: 'button', text: 'Nova senha', on: { click: () => resetPassword(u) } }),
        u.username === DG.state.user.username ? null : el('button', { class: 'btn small', type: 'button', text: u.active ? 'Desativar' : 'Ativar', on: { click: async () => {
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
  $('#weak-banner').addEventListener('click', () => DG.go('account'));
  boot().then(() => { if (!DG.state.user) { $('#login-view').hidden = false; } });
})();
