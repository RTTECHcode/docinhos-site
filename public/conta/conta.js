'use strict';
/*
 * Conta do cliente (A10): telas em /conta/ com rotas por hash (#entrar, #cadastro, #recuperar, #pedidos, #pontos, #dados).
 * Fala só com /api/customer. Preço, pontos e totais vêm sempre do servidor: aqui só exibimos.
 * Nada de innerHTML: todo texto de banco ou digitado entra por textContent/createElement.
 */
(function () {
  const API = '/api/customer';
  const PUBLIC_ROUTES = ['entrar', 'cadastro', 'recuperar'];
  const PRIVATE_ROUTES = ['pedidos', 'pontos', 'dados'];
  const TITLES = { entrar: 'Entrar', cadastro: 'Criar conta', recuperar: 'Recuperar acesso', pedidos: 'Meus pedidos', pontos: 'Clube da Gigi', dados: 'Meus dados' };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  let me = null;              // { name, points: { balance, locked_until } } ou null
  let questionsLoaded = null; // promessa de GET ?a=questions
  let consentInfo = null;     // { text, version }
  let flash = '';             // aviso de uma vez só (ex.: sessão expirou)

  // ---------- Utilidades ----------
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children) if (c !== null && c !== undefined) node.append(c);
    return node;
  }
  const money = cents => (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmtDate = iso => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  const fmtDay = iso => (iso ? new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' }) : '');
  const fmtPoints = n => Number(n || 0).toLocaleString('pt-BR');
  const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

  // Telefone: máscara (11) 91234-5678 enquanto digita; "+55" do começo é ignorado.
  function maskPhone(value) {
    let d = String(value).replace(/\D/g, '');
    if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
    d = d.slice(0, 11);
    if (d.length <= 2) return d ? `(${d}` : '';
    if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
    if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  }
  const phoneDigits = v => { let d = String(v).replace(/\D/g, ''); if (d.length > 11 && d.startsWith('55')) d = d.slice(2); return d; };
  const phoneValid = v => /^[1-9][1-9]9\d{8}$|^[1-9][1-9]\d{8}$/.test(phoneDigits(v));
  const showPhone = e164 => (e164 ? maskPhone(e164.replace(/^\+55/, '')) : '');

  async function api(action, { method = 'GET', body } = {}) {
    const opts = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (method === 'POST') { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body || {}); }
    let res;
    try { res = await fetch(`${API}?a=${encodeURIComponent(action)}`, opts); }
    catch { throw { status: 0, message: 'Sem conexão. Verifique sua internet e tente de novo.' }; }
    let data = null;
    try { data = await res.json(); } catch { /* corpo não-JSON */ }
    if (!res.ok) {
      const err = { status: res.status, code: data && data.code, message: (data && data.error) || 'Não foi possível concluir. Tente de novo.' };
      if (res.status === 401 && err.code === 'login_required') sessionExpired();
      throw err;
    }
    return data || {};
  }

  function setError(form, message) {
    const box = $('.form-error', form);
    if (!box) return;
    box.textContent = message || '';
    box.hidden = !message;
    if (message) box.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }
  function busy(form, on) {
    const b = $('button[type="submit"]', form);
    if (!b) return;
    b.disabled = on;
    if (on) { b.dataset.label = b.textContent; b.textContent = 'Aguarde...'; }
    else if (b.dataset.label) { b.textContent = b.dataset.label; }
  }
  function showNotice(message) {
    const box = $('#conta-aviso');
    box.textContent = message || '';
    box.hidden = !message;
  }
  function sessionExpired() {
    if (!me) return;
    me = null;
    flash = 'Sua sessão terminou. Entre de novo para continuar.';
    go('entrar');
  }
  const go = route => { if (location.hash === '#' + route) render(); else location.hash = route; };

  // ---------- Endereço (D1) e busca de CEP (D3) ----------
  const ADDR_FIELDS = ['cep', 'street', 'number', 'complement', 'district', 'city'];
  const cepDigits = v => String(v || '').replace(/\D/g, '').slice(0, 8);
  const maskCep = v => { const d = cepDigits(v); return d.length > 5 ? d.slice(0, 5) + '-' + d.slice(5) : d; };
  const addrInput = (root, name) => $(`[name="${name}"]`, root);
  function readAddress(root) {
    const a = {};
    ADDR_FIELDS.forEach(n => { a[n] = (addrInput(root, n).value || '').trim(); });
    a.cep = cepDigits(a.cep);
    return a;
  }
  function fillAddress(root, a) {
    ADDR_FIELDS.forEach(n => { addrInput(root, n).value = a && a[n] ? (n === 'cep' ? maskCep(a[n]) : a[n]) : ''; });
  }
  // Devolve null se estiver tudo em branco; senão confere o mínimo (o servidor confere de novo).
  function addressProblem(a, { required }) {
    const blank = ADDR_FIELDS.every(n => !a[n]);
    if (blank) return required ? 'Preencha o endereço ou use "Apagar endereço".' : '';
    if (a.cep.length !== 8) return 'Informe o CEP com 8 números.';
    if (a.street.length < 3) return 'Informe a rua.';
    if (!a.number) return 'Informe o número (ou s/n).';
    return '';
  }
  const cepCache = new Map();
  function bindCep(root) {
    const cepEl = addrInput(root, 'cep'), status = $('[data-cep-status]', root);
    let seq = 0;
    const say = (msg, warn) => { status.textContent = msg; status.hidden = !msg; status.classList.toggle('warn', !!warn); };
    cepEl.addEventListener('input', async () => {
      cepEl.value = maskCep(cepEl.value);
      const cep = cepDigits(cepEl.value);
      if (cep.length !== 8) { seq++; say(''); return; }
      const apply = d => {
        [['street', d.street], ['district', d.district], ['city', d.city]].forEach(([n, v]) => { if (v) addrInput(root, n).value = v; });
        say(d.street ? 'Endereço preenchido pelo CEP. Confira e complete o número.' : 'CEP sem rua cadastrada. Preencha o endereço à mão.', !d.street);
        if (d.street && !addrInput(root, 'number').value) addrInput(root, 'number').focus({ preventScroll: true });
      };
      if (cepCache.has(cep)) { const c = cepCache.get(cep); if (c.ok) apply(c.data); else say(c.msg, true); return; }
      const mine = ++seq;
      say('Buscando o endereço...');
      try {
        const r = await fetch('/api/store?a=cep&cep=' + cep, { cache: 'no-store' });
        let d = {}; try { d = await r.json(); } catch { /* corpo não-JSON */ }
        if (mine !== seq) return;
        if (r.ok && d && typeof d === 'object') { cepCache.set(cep, { ok: true, data: d }); apply(d); return; }
        const msg = r.status === 404 ? 'CEP não encontrado. Confira o número ou preencha o endereço à mão.' : 'Não foi possível buscar o CEP agora. Preencha o endereço à mão.';
        if (r.status === 404) cepCache.set(cep, { ok: false, msg });
        say(msg, true);
      } catch { if (mine === seq) say('Sem conexão para buscar o CEP. Preencha o endereço à mão.', true); }
    });
  }
  $$('[data-address]').forEach(bindCep);

  // Quem veio do checkout (/conta/?voltar=checkout) volta para lá depois de entrar ou criar a conta; o carrinho fica no aparelho.
  const wantsCheckout = () => new URLSearchParams(location.search).get('voltar') === 'checkout';
  function backToCheckout() { if (!wantsCheckout()) return false; location.href = '/?checkout=1'; return true; }

  // ---------- Perguntas e texto do consentimento ----------
  function loadQuestions() {
    if (!questionsLoaded) {
      questionsLoaded = api('questions').then(d => {
        consentInfo = d.consent;
        const sel = $('select[name="security_question"]', $('#form-cadastro'));
        sel.replaceChildren(el('option', { value: '', text: 'Escolha uma pergunta' }), ...d.questions.map(q => el('option', { value: q.id, text: q.text })));
        $('#cad-consent-text').textContent = d.consent.text;
        return d;
      }).catch(err => { questionsLoaded = null; throw err; });
    }
    return questionsLoaded;
  }
  // O servidor recusou o aceite (409 consent_outdated): o texto mudou. Busca o texto novo e mostra nas duas telas.
  // Não mexe na lista de perguntas (a escolha da pessoa no cadastro fica como está).
  async function reloadConsent() {
    try {
      const d = await api('questions');
      consentInfo = d.consent;
      $('#cad-consent-text').textContent = d.consent.text;
      $('#dados-consent-text').textContent = d.consent.text;
    } catch { /* o aviso de erro já está na tela */ }
  }
  const consentVersion = () => (consentInfo ? consentInfo.version : '');
  function fillBirthSelects() {
    const day = $('select[name="birth_day"]'), month = $('select[name="birth_month"]');
    if (day.options.length > 1) return;
    for (let i = 1; i <= 31; i++) day.append(el('option', { value: i, text: String(i) }));
    MONTHS.forEach((m, i) => month.append(el('option', { value: i + 1, text: m })));
  }

  // ---------- Sessão ----------
  async function refreshMe() {
    try {
      const d = await api('me');
      me = d.logged_in ? d.customer : null;
    } catch (e) {
      me = null;
      flash = e.message;
    }
    return me;
  }

  // ---------- Roteamento ----------
  function currentRoute() {
    const r = decodeURIComponent((location.hash || '').replace(/^#/, ''));
    return PUBLIC_ROUTES.includes(r) || PRIVATE_ROUTES.includes(r) ? r : '';
  }
  function render() {
    let route = currentRoute();
    if (me && (!route || PUBLIC_ROUTES.includes(route))) route = 'pedidos';
    if (!me && (!route || PRIVATE_ROUTES.includes(route))) route = 'entrar';
    if (location.hash !== '#' + route) { history.replaceState(null, '', '#' + route); }
    $$('[data-view]').forEach(s => { s.hidden = s.dataset.view !== route; });
    const tabs = $('#conta-tabs');
    tabs.hidden = !me;
    $$('a', tabs).forEach(a => {
      const on = a.dataset.tab === route;
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    document.title = `${TITLES[route]} — Docinhos da Gigi`;
    showNotice(flash); flash = '';
    const section = $(`#view-${route}`);
    const h1 = $('h1', section);
    if (h1) h1.focus({ preventScroll: true });
    window.scrollTo(0, 0);
    if (route === 'cadastro') { fillBirthSelects(); loadQuestions().catch(e => setError($('#form-cadastro'), e.message)); }
    if (route === 'recuperar') resetRecovery();
    if (route === 'pedidos') loadOrders();
    if (route === 'pontos') loadPoints();
    if (route === 'dados') loadProfile();
  }

  // ---------- U2: entrar / sair ----------
  $('#form-entrar').addEventListener('submit', async ev => {
    ev.preventDefault();
    const f = ev.currentTarget, v = Object.fromEntries(new FormData(f));
    if (!phoneValid(v.phone)) return setError(f, 'Informe um telefone válido com DDD, por exemplo (11) 91234-5678.');
    if (!v.password) return setError(f, 'Informe a sua senha.');
    setError(f, ''); busy(f, true);
    try {
      await api('login', { method: 'POST', body: { phone: phoneDigits(v.phone), password: v.password } });
      f.reset();
      await refreshMe();
      if (backToCheckout()) return;
      go('pedidos');
    } catch (e) { setError(f, e.message); }
    finally { busy(f, false); }
  });
  $('#btn-sair').addEventListener('click', async () => {
    try { await api('logout', { method: 'POST' }); } catch { /* sai da tela de qualquer jeito */ }
    me = null; flash = 'Você saiu da conta.';
    go('entrar');
  });

  // ---------- U1: cadastro ----------
  $('#form-cadastro').addEventListener('submit', async ev => {
    ev.preventDefault();
    const f = ev.currentTarget, v = Object.fromEntries(new FormData(f));
    if (!consentInfo) return setError(f, 'Não foi possível carregar o formulário. Atualize a página.');
    if (String(v.name || '').trim().length < 2) return setError(f, 'Informe o seu nome.');
    if (!phoneValid(v.phone)) return setError(f, 'Informe um telefone válido com DDD, por exemplo (11) 91234-5678.');
    if (String(v.password || '').length < 8) return setError(f, 'A senha precisa ter pelo menos 8 caracteres.');
    if (v.password !== v.password2) return setError(f, 'As duas senhas não são iguais.');
    if (!v.security_question) return setError(f, 'Escolha a pergunta de segurança.');
    if (String(v.security_answer || '').trim().length < 3) return setError(f, 'A resposta de segurança precisa ter pelo menos 3 letras.');
    if ((v.birth_day && !v.birth_month) || (!v.birth_day && v.birth_month)) return setError(f, 'Para o aniversário, escolha o dia e o mês (ou deixe os dois em branco).');
    const addr = readAddress(f);
    const addrMsg = addressProblem(addr, { required: false });
    if (addrMsg) return setError(f, addrMsg);
    const body = {
      name: v.name.trim(), phone: phoneDigits(v.phone), password: v.password,
      security_question: v.security_question, security_answer: v.security_answer,
      // Só vale marcado de propósito: a caixa nasce desmarcada e o servidor exige true booleano.
      whatsapp_consent: $('#cad-consent').checked === true,
      consent_version: consentVersion() // o servidor confere se é o texto atual
    };
    if (v.email && v.email.trim()) body.email = v.email.trim();
    if (v.birth_day && v.birth_month) { body.birth_day = Number(v.birth_day); body.birth_month = Number(v.birth_month); }
    if (ADDR_FIELDS.some(n => addr[n])) body.address = addr;
    setError(f, ''); busy(f, true);
    try {
      await api('register', { method: 'POST', body });
      f.reset();
      await refreshMe();
      flash = 'Conta criada! Bem-vinda(o) à Docinhos da Gigi.';
      if (backToCheckout()) return;
      go('pedidos');
    } catch (e) {
      if (e.code === 'consent_outdated') { await reloadConsent(); $('#cad-consent').checked = false; }
      setError(f, e.message);
    }
    finally { busy(f, false); }
  });

  // ---------- U3: recuperar ----------
  let recPhone = '';
  function resetRecovery() {
    recPhone = '';
    $('#rec-etapa1').hidden = false; $('#rec-etapa2').hidden = true; $('#rec-pronto').hidden = true;
    $('#form-rec1').reset(); $('#form-rec2').reset();
    setError($('#form-rec1'), ''); setError($('#form-rec2'), '');
  }
  $('#form-rec1').addEventListener('submit', async ev => {
    ev.preventDefault();
    const f = ev.currentTarget, v = Object.fromEntries(new FormData(f));
    if (!phoneValid(v.phone)) return setError(f, 'Informe um telefone válido com DDD, por exemplo (11) 91234-5678.');
    setError(f, ''); busy(f, true);
    try {
      const q = await api('recover_question', { method: 'POST', body: { phone: phoneDigits(v.phone) } });
      recPhone = phoneDigits(v.phone);
      $('#rec-pergunta').textContent = q.question;
      $('#rec-etapa1').hidden = true; $('#rec-etapa2').hidden = false;
      $('input[name="answer"]', $('#form-rec2')).focus();
    } catch (e) { setError(f, e.message); }
    finally { busy(f, false); }
  });
  $('#form-rec2').addEventListener('submit', async ev => {
    ev.preventDefault();
    const f = ev.currentTarget, v = Object.fromEntries(new FormData(f));
    if (String(v.answer || '').trim().length < 3) return setError(f, 'A resposta precisa ter pelo menos 3 letras.');
    if (String(v.new_password || '').length < 8) return setError(f, 'A nova senha precisa ter pelo menos 8 caracteres.');
    if (v.new_password !== v.new_password2) return setError(f, 'As duas senhas não são iguais.');
    setError(f, ''); busy(f, true);
    try {
      const r = await api('recover', { method: 'POST', body: { phone: recPhone, answer: v.answer, new_password: v.new_password } });
      f.reset();
      $('#rec-etapa2').hidden = true; $('#rec-pronto').hidden = false;
      const until = r.points_locked_until ? ` Seus pontos ficam sem poder ser usados até ${fmtDate(r.points_locked_until)} (48 horas).` : ' Seus pontos ficam sem poder ser usados por 48 horas.';
      $('#rec-pronto-msg').textContent = 'Senha trocada com sucesso. Por segurança, você foi desconectada(o) de todos os aparelhos.' + until;
    } catch (e) { setError(f, e.message); }
    finally { busy(f, false); }
  });

  // ---------- U4: pedidos ----------
  // v4 N1: o rótulo vem pronto do servidor (status_label); status_key só escolhe a cor.
  const STATUS_TONE = { awaiting_payment: 'tone-warn', payment_failed: 'tone-bad', refunded: 'tone-bad', received: 'tone-info', accepted: 'tone-info', preparing: 'tone-warn', ready: 'tone-ok', awaiting_delivery: 'tone-ok', completed: 'tone-done', cancelled: 'tone-bad' };
  // v4 U-10: código público -> token de acompanhamento, dos pedidos feitos neste aparelho.
  function recentTokens() {
    const m = new Map();
    try {
      const list = JSON.parse(localStorage.getItem('dg-recent-orders') || '[]');
      if (Array.isArray(list)) for (const r of list) if (r && typeof r.public_code === 'string' && typeof r.token === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(r.token) && !m.has(r.public_code)) m.set(r.public_code, r.token);
    } catch { /* sem lista */ }
    return m;
  }
  function orderCard(o) {
    const tone = STATUS_TONE[o.status_key] || 'tone-info';
    const head = el('div', { class: 'order-head' },
      el('strong', { class: 'order-code', text: o.public_code || 'Pedido' }),
      el('span', { class: 'badge ' + tone, text: o.status_label || '' }));
    const meta = el('p', { class: 'order-meta' }, el('span', { text: fmtDate(o.created_at) }), el('span', { text: o.delivery_method === 'pickup' ? 'Retirada' : 'Entrega' }));
    // v4 N10: encomenda com data marcada (rótulo pronto do servidor).
    const sched = o.scheduled_label ? el('p', { class: 'order-sched', text: o.scheduled_label }) : null;
    const items = el('ul', { class: 'order-items' }, ...(o.items_summary || []).map(t => el('li', { text: t })));
    const rows = [el('div', { class: 'order-row' }, el('span', { text: 'Total' }), el('strong', { text: money(o.total_cents) }))];
    // v4 N6/N3: desconto é do cupom; prêmio do Clube sai de graça (só os pontos). Pedido antigo pode ter desconto de pontos.
    if (o.coupon_discount_cents > 0) rows.unshift(el('div', { class: 'order-row sub' }, el('span', { text: o.coupon_code ? `Cupom ${o.coupon_code}` : 'Cupom' }), el('span', { text: '- ' + money(o.coupon_discount_cents) })));
    else if (o.discount_cents > 0 && o.points_redeemed > 0) rows.unshift(el('div', { class: 'order-row sub' }, el('span', { text: `Desconto de pontos (${fmtPoints(o.points_redeemed)} pts)` }), el('span', { text: '- ' + money(o.discount_cents) })));
    if (o.club_points > 0) rows.unshift(el('div', { class: 'order-row sub' }, el('span', { text: 'Prêmio do Clube' }), el('span', { text: `${fmtPoints(o.club_points)} pontos` })));
    const foot = el('div', { class: 'order-foot' });
    // Link de acompanhamento: a URL do servidor quando vier; senão o token guardado neste aparelho (dg-recent-orders) pelo código
    // do pedido (v4 U-10). O banco guarda só o hash do token, então pedido feito em outro aparelho fica sem link.
    const recentToken = o.public_code ? recentTokens().get(o.public_code) : null;
    const trackHref = o.tracking_url && /^\/pedido\.html\?t=[A-Za-z0-9_-]{16,64}$/.test(o.tracking_url) ? o.tracking_url : recentToken ? '/pedido.html?t=' + encodeURIComponent(recentToken) : '';
    if (trackHref) foot.append(el('a', { class: 'order-link', href: trackHref, text: 'Acompanhar pedido', 'aria-label': `Acompanhar o pedido ${o.public_code || ''}`.trim() }));
    return el('li', { class: 'order' }, head, meta, sched, items, ...rows, foot);
  }
  async function loadOrders() {
    const status = $('#pedidos-status'), list = $('#pedidos-lista');
    status.hidden = false; status.textContent = 'Carregando...'; list.replaceChildren();
    try {
      const d = await api('orders');
      if (!d.orders.length) {
        status.textContent = 'Você ainda não tem pedidos nesta conta. Pedidos feitos com a conta aberta aparecem aqui.';
        return;
      }
      status.hidden = true;
      list.replaceChildren(...d.orders.map(orderCard));
    } catch (e) { status.textContent = e.message; }
  }

  // ---------- U5: pontos / v4 N3: Clube ----------
  const rewardLabel = r => String(r.name || '') + (r.size_name ? ` (${r.size_name})` : '');
  function renderRewards(cl, p) {
    const ul = $('#clube-premios');
    const list = cl && Array.isArray(cl.rewards) ? cl.rewards : [];
    $('#clube-erro').hidden = !!cl;
    $('#clube-vazio').hidden = !cl || list.length > 0;
    const can = list.filter(r => r.can_redeem);
    const next = list.filter(r => r.available && r.missing_points > 0).sort((a, b) => a.missing_points - b.missing_points)[0];
    $('#pontos-valor').textContent = can.length ? `Dá para trocar por ${can.length === 1 ? '1 prêmio' : `${can.length} prêmios`} do Clube`
      : next ? `Faltam ${fmtPoints(next.missing_points)} pontos para ${rewardLabel(next)}` : '';
    ul.replaceChildren(...list.map(r => {
      const img = r.image_path && /^\/[A-Za-z0-9/_.%-]+$/.test(r.image_path) ? el('img', { src: r.image_path, alt: '', width: 56, height: 56, loading: 'lazy', decoding: 'async' }) : el('span', { class: 'reward-ph', 'aria-hidden': 'true' });
      const info = el('div', { class: 'reward-info' }, el('strong', { class: 'reward-name', text: rewardLabel(r) }), el('span', { class: 'reward-cost', text: `${fmtPoints(r.points_cost)} pontos` }));
      let state;
      if (r.can_redeem) state = el('span', { class: 'badge tone-ok', text: 'Dá para trocar' });
      else if (!r.available) state = el('span', { class: 'badge tone-bad', text: 'Indisponível agora' });
      else if (r.missing_points > 0) {
        state = el('span', { class: 'reward-miss', text: `Faltam ${fmtPoints(r.missing_points)} pontos` });
        info.append(el('progress', { class: 'reward-progress', max: r.points_cost, value: Math.max(0, r.points_cost - r.missing_points), 'aria-label': `Progresso para ${rewardLabel(r)}` }));
      } else state = el('span', { class: 'badge tone-warn', text: p && p.locked_until ? 'Troca bloqueada por 48 h' : 'Troca pausada' });
      return el('li', { class: 'reward' + (r.can_redeem ? ' is-ready' : '') }, img, info, state);
    }));
    if (can.length) ul.append(el('li', { class: 'reward-cta' }, el('a', { class: 'button', href: '/', text: 'Escolher o prêmio no cardápio' })));
  }
  async function loadPoints() {
    const status = $('#pontos-status'), body = $('#pontos-corpo');
    status.hidden = false; status.textContent = 'Carregando...'; body.hidden = true;
    try {
      // v4 N3: saldo e extrato em ?a=points; prêmios (com o que falta e se dá para trocar) em ?a=club.
      const [p, cl] = await Promise.all([api('points'), api('club').then(d => d.club).catch(() => null)]);
      $('#pontos-saldo').textContent = fmtPoints(p.balance);
      renderRewards(cl, p);
      // Regra em vigor (definida no painel da loja); o servidor confere tudo na hora do pedido.
      const perReal = p.points_per_real === 1 ? '1 ponto' : `${fmtPoints(p.points_per_real)} pontos`;
      $('#pontos-regra-ganho').textContent = `Você ganha ${perReal} a cada R$ 1 em produtos.`;
      $('#pontos-pausado').hidden = p.points_enabled !== false;
      if (p.points_enabled === false) $('#pontos-valor').textContent = 'Clube pausado no momento';
      const lock = $('#pontos-bloqueio');
      lock.hidden = !p.locked_until;
      if (p.locked_until) lock.textContent = `Por segurança, a troca de pontos está bloqueada até ${fmtDate(p.locked_until)}, porque você recuperou o acesso da conta há pouco. Você continua juntando pontos.`;
      const res = $('#pontos-reservados');
      res.hidden = !(p.reserved > 0);
      if (p.reserved > 0) res.textContent = `${fmtPoints(p.reserved)} pontos estão reservados em um pedido aguardando pagamento. Se o pedido não for pago, eles voltam sozinhos.`;
      const ul = $('#pontos-extrato');
      ul.replaceChildren(...p.history.map(h => el('li', { class: 'ledger-row' },
        el('div', { class: 'ledger-main' }, el('span', { class: 'ledger-desc', text: h.description }), el('span', { class: 'ledger-date', text: fmtDate(h.created_at) })),
        el('strong', { class: 'ledger-pts ' + (h.points > 0 ? 'plus' : h.points < 0 ? 'minus' : 'zero'), text: (h.points > 0 ? '+' : '') + fmtPoints(h.points) }))));
      $('#pontos-vazio').hidden = p.history.length > 0;
      status.hidden = true; body.hidden = false;
    } catch (e) { status.textContent = e.message; }
  }

  // ---------- Dados ----------
  const consentBox = () => $('#dados-consent');
  async function loadProfile() {
    const status = $('#dados-status'), body = $('#dados-corpo');
    status.hidden = false; status.textContent = 'Carregando...'; body.hidden = true;
    $('#dados-consent-msg').hidden = true; $('#dados-consent-erro').hidden = true;
    try {
      const [d] = await Promise.all([api('profile'), loadQuestions().catch(() => null)]);
      const c = d.customer;
      $('#d-nome').textContent = c.name;
      $('#d-telefone').textContent = showPhone(c.phone);
      $('#d-email').textContent = c.email || 'não informado';
      $('#d-aniversario').textContent = c.birth_day && c.birth_month ? `${c.birth_day} de ${MONTHS[c.birth_month - 1]}` : 'não informado';
      $('#dados-consent-text').textContent = consentInfo ? consentInfo.text : 'Receber novidades, promoções e avisos de pedidos pelo WhatsApp.';
      consentBox().checked = !!c.whatsapp_consent;
      try { const ad = await api('address'); fillAddress($('#form-endereco'), ad.address); } catch (e) { if (e.status !== 401) throw e; }
      $('.notice.ok', $('#form-endereco')).hidden = true; setError($('#form-endereco'), '');
      status.hidden = true; body.hidden = false;
    } catch (e) { status.textContent = e.message; }
  }
  $('#form-endereco').addEventListener('submit', async ev => {
    ev.preventDefault();
    const f = ev.currentTarget, ok = $('.notice.ok', f), addr = readAddress(f);
    ok.hidden = true;
    const msg = addressProblem(addr, { required: true });
    if (msg) return setError(f, msg);
    setError(f, ''); busy(f, true);
    try {
      const d = await api('address_save', { method: 'POST', body: { address: addr } });
      fillAddress(f, d.address);
      ok.textContent = 'Endereço salvo. Ele já vem preenchido no seu próximo pedido.'; ok.hidden = false;
    } catch (e) { setError(f, e.message); }
    finally { busy(f, false); }
  });
  $('#btn-endereco-apagar').addEventListener('click', async () => {
    const f = $('#form-endereco'), ok = $('.notice.ok', f);
    ok.hidden = true; setError(f, '');
    try {
      await api('address_clear', { method: 'POST' });
      fillAddress(f, null);
      $('[data-cep-status]', f).hidden = true;
      ok.textContent = 'Endereço apagado.'; ok.hidden = false;
    } catch (e) { setError(f, e.message); }
  });
  consentBox().addEventListener('change', async ev => {
    const box = ev.currentTarget, want = box.checked;
    const msg = $('#dados-consent-msg'), err = $('#dados-consent-erro');
    msg.hidden = true; err.hidden = true; box.disabled = true;
    try {
      const d = await api('consent', { method: 'POST', body: { whatsapp_consent: want, consent_version: consentVersion() } });
      box.checked = !!d.customer.whatsapp_consent;
      msg.textContent = d.customer.whatsapp_consent ? 'Pronto! Você vai poder receber novidades pelo WhatsApp. Para sair, desmarque aqui ou responda SAIR.' : 'Pronto! Você não vai receber promoções pelo WhatsApp.';
      msg.hidden = false;
    } catch (e) {
      if (e.code === 'consent_outdated') await reloadConsent();
      box.checked = !want; err.textContent = e.message; err.hidden = false;
    }
    finally { box.disabled = false; }
  });
  $('#form-senha').addEventListener('submit', async ev => {
    ev.preventDefault();
    const f = ev.currentTarget, v = Object.fromEntries(new FormData(f)), ok = $('.notice.ok', f);
    ok.hidden = true;
    if (!v.current_password) return setError(f, 'Informe a senha atual.');
    if (String(v.new_password || '').length < 8) return setError(f, 'A nova senha precisa ter pelo menos 8 caracteres.');
    if (v.new_password !== v.new_password2) return setError(f, 'As duas senhas novas não são iguais.');
    setError(f, ''); busy(f, true);
    try {
      await api('password', { method: 'POST', body: { current_password: v.current_password, new_password: v.new_password } });
      f.reset();
      ok.textContent = 'Senha trocada. Os outros aparelhos foram desconectados.'; ok.hidden = false;
    } catch (e) { setError(f, e.message); }
    finally { busy(f, false); }
  });

  // ---------- Início ----------
  document.addEventListener('input', ev => {
    const t = ev.target;
    if (t instanceof HTMLInputElement && t.hasAttribute('data-phone')) t.value = maskPhone(t.value);
  });
  // Apagar a mensagem de erro assim que a pessoa volta a digitar.
  document.addEventListener('input', ev => { const f = ev.target.closest && ev.target.closest('form'); const b = f && f.querySelector('.form-error'); if (b && !b.hidden) { b.hidden = true; b.textContent = ''; } });
  // Mostra a pergunta escolhida inteira (o seletor corta o texto no celular).
  $('select[name="security_question"]').addEventListener('change', ev => { const o = ev.target.selectedOptions[0], p = $('#cad-q-full'); p.textContent = o && o.value ? o.textContent : ''; p.hidden = !(o && o.value); });
  window.addEventListener('hashchange', render);
  (async function init() {
    await refreshMe();
    if (me && backToCheckout()) return;
    render();
  })();
})();
