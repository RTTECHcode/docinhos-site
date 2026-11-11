const statusEl = document.querySelector('#status');
const menuEl = document.querySelector('#menu');
const catsEl = document.querySelector('#categorias');
const cartFab = document.querySelector('#cart-fab');
const cartFabCount = document.querySelector('#cart-fab-count');
const catFab = document.querySelector('#cat-fab');
const trackFab = document.querySelector('#track-fab');
const trackFabCount = document.querySelector('#track-fab-count');
const catList = document.querySelector('#cat-list');
const toastEl = document.createElement('div');
toastEl.id = 'toast';
document.body.appendChild(toastEl);

// Vêm de /config.js (futuramente, do painel admin)
const WHATSAPP_NUMBER = String(window.WHATSAPP_NUMBER || '').replace(/\D/g, '');
const STORE_ADDRESS = String(window.STORE_ADDRESS || '').trim();
const CART_KEY = 'dg-cart';
const LAST_ORDER_KEY = 'dg-last-order';
const RECENT_KEY = 'dg-recent-orders';
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');
const MODAL_MS = 300; // um pouco acima da transição de 280ms do CSS

let menu = [];
let activeProduct = null;
let sel = { size: null, extras: {} };
let pmGroups = []; // grupos de escolha do produto aberto: { id, label, min, max, opts[] }

const brl = cents => 'R$ ' + (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' };
const esc = s => String(s ?? '').replace(/[&<>'"]/g, c => ESC_MAP[c]);
const waLink = text => `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`;

// O app controla o scroll sozinho: a restauração automática do navegador brigava com o voltar/fechar de modais.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

/* ---------- Armazenamento (localStorage; pode falhar em aba privada ou cota cheia) ---------- */
function readStore(key, storage = localStorage) {
  try { const raw = storage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function writeStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* segue sem persistir */ }
}
function removeStore(key) {
  try { localStorage.removeItem(key); } catch { /* ignora */ }
}

/* Último pedido (para a volta do Mercado Pago). Guarda só o mínimo: DG-####, token de acompanhamento, status, forma de
   pagamento e os valores do resumo. O texto do WhatsApp (tem nome, telefone e endereço) só é guardado no pagamento com
   cartão, que sai do site e volta; tudo vale 24 h e o texto é apagado assim que a pessoa toca em "Enviar pelo WhatsApp".
   Entradas antigas (sem prazo, com dados pessoais) são apagadas na primeira leitura. */
const LAST_ORDER_TTL_MS = 24 * 60 * 60 * 1000;
function saveLastOrder(o) { writeStore(LAST_ORDER_KEY, { ...o, expires_at: Date.now() + LAST_ORDER_TTL_MS }); }
function readLastOrder() {
  const last = readStore(LAST_ORDER_KEY);
  if (!last || typeof last !== 'object' || typeof last.token !== 'string' || !(last.expires_at > Date.now())) { removeStore(LAST_ORDER_KEY); return null; }
  return last;
}
function forgetWhatsAppText() {
  const last = readLastOrder();
  if (last && 'whatsappText' in last) { delete last.whatsappText; writeStore(LAST_ORDER_KEY, last); }
}

const isId = n => Number.isInteger(n) && n > 0;
const cartKey = i => `${i.productId}|${i.size ? i.size.id : ''}|${i.extras.map(x => `${x.id}x${x.qty}`).sort().join(',')}`;
function validCartItem(i) {
  return !!i && isId(i.productId) && typeof i.name === 'string'
    && Number.isInteger(i.qty) && i.qty > 0
    && Number.isInteger(i.unitTotal) && i.unitTotal >= 0
    && (i.size === null || (!!i.size && isId(i.size.id)))
    && Array.isArray(i.extras) && i.extras.every(x => !!x && isId(x.id) && Number.isInteger(x.qty) && x.qty > 0);
}
// Entradas antigas (sessionStorage, sem ids de tamanho/extras) só sobrevivem se ainda forem válidas; o resto é descartado.
function loadCart() {
  const raw = readStore(CART_KEY) ?? readStore(CART_KEY, sessionStorage);
  try { sessionStorage.removeItem(CART_KEY); } catch { /* ignora */ }
  if (!Array.isArray(raw)) return [];
  return raw.filter(validCartItem).map(i => ({ ...i, key: cartKey(i) }));
}
let cart = loadCart();
const save = () => { writeStore(CART_KEY, cart); renderCartFab(); };

toastEl.setAttribute('role', 'status');
toastEl.setAttribute('aria-live', 'polite');
function toast(msg, ms = 1800) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => toastEl.classList.remove('show'), ms);
}

/* ---------- Modais e sheets, integrados ao histórico (botão voltar do celular) ----------
   Abrir = pushState({dgModal:id}). Voltar (popstate) fecha o modal do topo.
   X / fundo / Esc chamam history.back() quando o estado atual é do modal, então há um só caminho de fechamento. */
const modalStack = [];      // ids abertos; o último é o do topo
const closing = new Set();  // ids com history.back() em andamento (evita voltar duas vezes)
let modalSeq = 0;           // V4: cada abertura ganha um número crescente, gravado no estado do histórico (dgSeq)
const abandoned = new Set(); // V4: números cujo history.back() demorou demais e o fechamento foi resolvido pelo temporizador
const BACK_WAIT_MS = 500;   // espera pelo popstate antes de fechar por conta própria
const modalHooks = {
  '#cat-sheet': {
    open() {
      catFab.setAttribute('aria-expanded', 'true');
      const item = catList.querySelector('.cat-item.active') || catList.querySelector('.cat-item');
      if (item) item.focus({ preventScroll: true });
    },
    close() { catFab.setAttribute('aria-expanded', 'false'); }
  }
};
const modalEl = id => document.querySelector(id);

let pendingOpen = null;     // abertura pedida enquanto outro modal ainda fecha (history.back em andamento)
function openModal(id, opts = {}) {
  const modal = modalEl(id);
  if (!modal || modalStack.includes(id)) return;
  // Antes: o toque era descartado se algum modal estava fechando. Agora fica na fila e abre quando o fechamento termina.
  if (closing.size) { pendingOpen = [id, opts]; return; }
  clearTimeout(modal._hideTimer);
  modal._opener = opts.opener || document.activeElement;
  modalStack.push(id);
  modal._seq = ++modalSeq;
  const hState = { dgModal: id, dgSeq: modal._seq };
  if (opts.replace) history.replaceState(hState, ''); else history.pushState(hState, '');
  modal.hidden = false;
  document.body.classList.add('modal-open');
  void modal.offsetWidth; // reflow: a transição parte do estado fechado
  modal.classList.add('is-open');
  const close = modal.querySelector('.modal-close');
  if (close) close.focus({ preventScroll: true });
  if (modalHooks[id]) modalHooks[id].open();
}

function hideModal(id) {
  const idx = modalStack.lastIndexOf(id);
  if (idx === -1) return;
  modalStack.splice(idx, 1);
  closing.delete(id);
  const modal = modalEl(id);
  modal.classList.remove('is-open');
  const after = modal._after;
  modal._after = null;
  if (modalHooks[id]) modalHooks[id].close();
  const opener = modal._opener;
  if (!modalStack.length && opener && opener.isConnected && opener.focus) opener.focus({ preventScroll: true });
  const finish = () => {
    modal.hidden = true;
    if (!modalStack.length) document.body.classList.remove('modal-open');
  };
  clearTimeout(modal._hideTimer);
  if (REDUCED.matches) finish(); else modal._hideTimer = setTimeout(finish, MODAL_MS);
  if (after) after();
  if (!closing.size && pendingOpen) { const [pid, popts] = pendingOpen; pendingOpen = null; openModal(pid, popts); }
}

function requestClose(id, after) {
  if (!modalStack.includes(id) || closing.has(id)) return;
  if (after) modalEl(id)._after = after;
  const seq = modalEl(id)._seq;
  if (history.state && history.state.dgModal === id && history.state.dgSeq === seq) {
    closing.add(id);
    history.back();
    // Rede de segurança: se o popstate não chegar, fecha mesmo assim. A volta que chegar depois (aparelho lento,
    // navegador embutido) é reconhecida como atrasada em 'abandoned' e não derruba o modal que abriu nesse meio tempo (V4).
    setTimeout(() => { if (closing.has(id)) { abandoned.add(seq); hideModal(id); } }, BACK_WAIT_MS);
  } else {
    hideModal(id);
  }
}

window.addEventListener('popstate', () => {
  const wantSeq = (history.state && history.state.dgSeq) || 0;
  if (wantSeq && abandoned.has(wantSeq)) {
    // Volta atrasada de um fechamento que o temporizador já resolveu. Se há modal aberto depois dela, ele continua valendo:
    // volta uma entrada para o estado dele, em vez de fechá-lo.
    abandoned.delete(wantSeq);
    if (modalStack.length) history.forward(); else history.replaceState(null, '');
    return;
  }
  while (modalStack.length && (modalEl(modalStack[modalStack.length - 1])._seq || 0) > wantSeq) hideModal(modalStack[modalStack.length - 1]);
  // "avançar" para uma entrada de modal que não está aberto: neutraliza a entrada
  if (wantSeq && !modalStack.some(id => modalEl(id)._seq === wantSeq)) history.replaceState(null, '');
});
// recarregar com estado de modal no histórico: esse estado não vale mais
if (history.state && history.state.dgModal) history.replaceState(null, '');

document.addEventListener('click', e => {
  if (!e.target.closest('[data-close], [data-sheet-close]')) return;
  const modal = e.target.closest('.modal');
  if (modal) requestClose('#' + modal.id);
});

function trapFocus(e, modal) {
  const f = [...modal.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), textarea, select, [tabindex]:not([tabindex="-1"])')]
    .filter(el => !el.hidden && el.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (!modal.contains(document.activeElement) || (e.shiftKey && document.activeElement === first)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
document.addEventListener('keydown', e => {
  const topId = modalStack[modalStack.length - 1];
  if (!topId) return;
  if (e.key === 'Escape') requestClose(topId);
  else if (e.key === 'Tab') trapFocus(e, modalEl(topId));
});

fetch('/api/menu').then(r => { if (!r.ok) throw 0; return r.json(); }).then(data => {
  statusEl.remove();
  menu = data.categories;
  setStoreState(data.store);
  setPointsRules(data.points);
  renderCats();
  renderMenu();
  observeCats();
}).catch(() => { statusEl.textContent = 'Cardápio indisponível no momento.'; });

/* ---------- Navegação entre categorias ---------- */
let activeCat = null;
let navLockUntil = 0;
const scrollBehavior = () => (REDUCED.matches ? 'auto' : 'smooth');

// V3: a categoria "Para família" ganha o ícone do brigadeiro (identificada pelo nome, sem acento e em minúsculas)
const isFamilyCat = c => String(c.name || '').normalize('NFD').replace(/[^a-zA-Z ]/g, '').trim().toLowerCase() === 'para familia';
const brigIcon = c => isFamilyCat(c) ? '<span class="cat-brig" aria-hidden="true"></span>' : '';
function renderCats() {
  catsEl.innerHTML = menu.map(c =>
    `<a class="cat-chip${isFamilyCat(c) ? ' has-brig' : ''}" href="#cat-${c.id}" data-cat="${c.id}">${esc(c.name)}</a>`).join('');
  catList.innerHTML = menu.map(c =>
    `<li><a class="cat-item" href="#cat-${c.id}" data-cat="${c.id}">${brigIcon(c)}<span>${esc(c.name)}</span><span class="cat-count">${c.products.length}</span></a></li>`).join('');
  catFab.hidden = menu.length === 0;
  if (menu.length) setActiveCat(menu[0].id);
}

function setActiveCat(id) {
  if (id == null || String(id) === String(activeCat)) return;
  activeCat = id;
  document.querySelectorAll('[data-cat]').forEach(el => {
    const on = el.dataset.cat === String(id);
    el.classList.toggle('active', on);
    if (on) el.setAttribute('aria-current', 'true'); else el.removeAttribute('aria-current');
  });
  const chip = catsEl.querySelector('.cat-chip.active');
  if (chip) catsEl.scrollTo({ left: chip.offsetLeft - (catsEl.clientWidth - chip.offsetWidth) / 2, behavior: scrollBehavior() });
}

function observeCats() {
  const sections = [...document.querySelectorAll('.category')];
  if (!sections.length || !('IntersectionObserver' in window)) return;
  const visible = new Set();
  // faixa de leitura: logo abaixo da barra de chips até ~40% da altura da tela
  const io = new IntersectionObserver(entries => {
    entries.forEach(en => en.isIntersecting ? visible.add(en.target) : visible.delete(en.target));
    if (Date.now() < navLockUntil) return;
    const first = sections.find(s => visible.has(s));
    if (first) setActiveCat(first.id.slice(4));
  }, { rootMargin: '-90px 0px -60% 0px' });
  sections.forEach(s => io.observe(s));
}

// no fim da página, a última categoria pode nunca entrar na faixa de leitura
window.addEventListener('scroll', () => {
  if (!menu.length || Date.now() < navLockUntil) return;
  if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) setActiveCat(menu[menu.length - 1].id);
}, { passive: true });

// Rola até o alvo sem criar entrada de histórico (href="#..." empilharia uma entrada por toque).
function scrollToEl(target, hash) {
  target.scrollIntoView({ block: 'start', behavior: scrollBehavior() }); // scroll-margin-top no CSS cobre a barra sticky
  history.replaceState(history.state, '', hash);
}
function goToCat(id) {
  const target = document.getElementById('cat-' + id);
  if (!target) return;
  navLockUntil = Date.now() + 1200;
  setActiveCat(id);
  scrollToEl(target, '#cat-' + id);
}

catFab.addEventListener('click', () => openModal('#cat-sheet', { opener: catFab }));

document.addEventListener('click', e => {
  const link = e.target.closest('a[data-cat]');
  if (link) {
    e.preventDefault();
    const id = link.dataset.cat;
    // no sheet: fecha primeiro (history.back) e só então rola, para o replaceState não pegar a entrada do sheet
    if (link.classList.contains('cat-item')) requestClose('#cat-sheet', () => goToCat(id)); else goToCat(id);
    return;
  }
  const hero = e.target.closest('a[href="#cardapio"]');
  if (hero) { e.preventDefault(); scrollToEl(document.getElementById('cardapio'), '#cardapio'); }
});

function renderMenu() {
  menuEl.innerHTML = menu.map(c => `
    <section class="category" id="cat-${c.id}">
      <h2>${brigIcon(c)}${esc(c.name)}</h2>
      <div class="grid">${c.products.map(p => `
        <button type="button" class="card${p.unavailable ? ' is-unavailable' : ''}${p.paused ? ' is-paused' : ''}" ${p.unavailable ? 'disabled aria-disabled="true"' : `data-pid="${p.id}"`}>
          ${p.imagePath ? `<img src="${esc(encodeURI(p.imagePath))}" alt="" width="88" height="88" loading="lazy" decoding="async">` : '<span class="placeholder" aria-hidden="true"></span>'}
          <span class="body">
            <span class="name">${esc(p.name)}</span>
            ${p.description ? `<span class="desc">${esc(p.description)}</span>` : ''}
            ${p.unavailable && !p.paused ? '<span class="unavail-tag">Indisponível no momento</span>' : ''}
            <span class="price-row">
              <span class="price">${p.priceCents != null ? (p.complements?.some(x => x.kind === 'size') ? `<span class="from">a partir de</span> ${brl(p.priceCents)}` : brl(p.priceCents)) : 'Consulte'}</span>
            </span>
          </span>
          ${p.unavailable ? '' : '<span class="add-hint" aria-hidden="true">+</span>'}
          ${p.paused ? '<span class="pause-clip"><span class="pause-band">Volto logo</span></span>' : ''}
        </button>`).join('')}</div>
    </section>`).join('');
}

const findProduct = id => menu.flatMap(c => c.products).find(p => p.id === id);

document.addEventListener('click', e => {
  const card = e.target.closest('.card[data-pid]');
  if (card) openProduct(Number(card.dataset.pid), card);
});

function openProduct(id, opener) {
  activeProduct = findProduct(id);
  if (!activeProduct) return;
  if (activeProduct.unavailable) { activeProduct = null; toast('Este produto está indisponível no momento.'); return; }
  const comps = activeProduct.complements || [];
  const sizes = comps.filter(c => c.kind === 'size');
  const extras = comps.filter(c => c.kind !== 'size');
  const firstSize = sizes.find(c => !c.unavailable) || null;
  sel = { size: firstSize, extras: {} };
  // Grupos de escolha: a API pode não enviar `groups` (ainda); sem eles tudo segue como complemento com +/−.
  pmGroups = (Array.isArray(activeProduct.groups) ? activeProduct.groups : []).map(g => {
    const opts = extras.filter(c => c.groupId != null && Number(c.groupId) === Number(g.id));
    const free = opts.filter(c => !c.unavailable).length; // pausados não contam para o limite nem para o mínimo
    const max = Number(g.maxChoices) > 0 ? Math.min(Number(g.maxChoices), free) : free;
    return { id: Number(g.id), label: String(g.label || ''), min: Math.min(Math.max(0, Number(g.minChoices) || 0), max), max, opts };
  }).filter(g => g.opts.length);
  const grouped = new Set(pmGroups.flatMap(g => g.opts.map(o => o.id)));
  const loose = extras.filter(c => !grouped.has(c.id));

  document.querySelector('#product-modal-body').innerHTML = `
    <div class="pm-photo">${activeProduct.imagePath ? `<img src="${esc(encodeURI(activeProduct.imagePath))}" alt="${esc(activeProduct.name)}">` : ''}</div>
    <h3 class="pm-name">${esc(activeProduct.name)}</h3>
    ${activeProduct.description ? `<p class="pm-desc">${esc(activeProduct.description)}</p>` : ''}
    <div class="pm-price">${activeProduct.priceCents != null ? brl(activeProduct.priceCents) : ''}</div>
    ${sizes.length ? `
      <div class="comp-group">
        <h4>Escolha o tamanho</h4>
        <p class="hint">Escolha 1 opção</p>
        ${sizes.map(s => `
          <div class="comp-item${s.unavailable ? ' is-unavailable' : ''}">
            <span class="comp-left">${esc(s.name)}${s.priceCents ? `<span class="comp-price">+ ${brl(s.priceCents)}</span>` : ''}${s.unavailable ? '<span class="unavail-tag">Indisponível</span>' : ''}</span>
            <span class="comp-qty"><button type="button" data-size="${s.id}" aria-label="${s.unavailable ? `${esc(s.name)} indisponível` : `Escolher ${esc(s.name)}`}" ${s.unavailable || (firstSize && s.id === firstSize.id) ? 'disabled' : ''}>${firstSize && s.id === firstSize.id ? '✓' : '+'}</button></span>
          </div>`).join('')}
        ${firstSize ? '' : '<p class="group-error" role="alert">Todos os tamanhos estão indisponíveis no momento.</p>'}
      </div>` : ''}
    ${pmGroups.map(g => `
      <div class="comp-group choice-group" data-gid="${g.id}" role="group" aria-labelledby="gt-${g.id}">
        <div class="group-head"><h4 id="gt-${g.id}">${esc(g.label)}</h4><span class="group-count" data-gcount aria-live="polite">0/${g.max}</span></div>
        <p class="hint">${g.min ? `Escolha ${g.min === g.max ? g.max : `de ${g.min} a ${g.max}`}` : `Escolha até ${g.max}`}</p>
        <p class="group-error" data-gerr role="alert" hidden></p>
        <div class="chips">
          ${g.opts.map(o => `
            <label class="chip${o.unavailable ? ' is-unavailable' : ''}">
              <input type="checkbox" data-opt="${o.id}" data-opt-group="${g.id}" aria-disabled="${o.unavailable ? 'true' : 'false'}" ${o.unavailable ? 'disabled' : ''}>
              <span class="chip-text"><span class="chip-name">${esc(stripPrefix(o.name))}</span>${o.unavailable ? '<span class="unavail-tag">Indisponível</span>' : priceTag(o)}</span>
            </label>`).join('')}
        </div>
      </div>`).join('')}
    ${loose.length ? `
      <div class="comp-group">
        <h4>${pmGroups.length ? 'Outros complementos' : 'Complementos'}</h4>
        <p class="hint">Opcional — até ${Math.max(1, ...loose.filter(x => !x.unavailable).map(x => x.maxQuantity))} por item</p>
        ${loose.map(x => `
          <div class="comp-item${x.unavailable ? ' is-unavailable' : ''}">
            <span class="comp-left">${esc(stripPrefix(x.name))}${x.unavailable ? '<span class="unavail-tag">Indisponível</span>' : priceTag(x)}</span>
            <span class="comp-qty">
              <button type="button" data-minus="${x.id}" aria-label="Menos ${esc(x.name)}" disabled>−</button>
              <span class="n" data-count="${x.id}">0</span>
              <button type="button" data-plus="${x.id}" aria-label="${x.unavailable ? `${esc(x.name)} indisponível` : `Mais ${esc(x.name)}`}" ${x.unavailable ? 'disabled' : ''}>+</button>
            </span>
          </div>`).join('')}
      </div>` : ''}
    <div class="pm-total-row"><span>Total</span><span id="pm-total"></span></div>
    <button type="button" class="button primary full" id="pm-add" ${sizes.length && !firstSize ? 'disabled' : ''}>Adicionar ao carrinho</button>`;
  updatePmTotal();
  openModal('#product-modal', { opener });
}

// Só exibição: dentro dos grupos o título já diz "Fruta"/"Topping". Carrinho e pedido seguem por id (e nome completo).
const stripPrefix = n => String(n).replace(/^(Fruta|Topping) - /, '');
const priceTag = c => c.priceCents ? `<span class="comp-price">+ ${brl(c.priceCents)}</span>` : '<span class="comp-price free">sem custo</span>';
const groupCount = g => g.opts.reduce((n, o) => n + (sel.extras[o.id] ? 1 : 0), 0);
function groupRoot(g) { return document.querySelector(`[data-gid="${g.id}"]`); }
function refreshGroup(g) {
  const root = groupRoot(g);
  if (!root) return;
  const n = groupCount(g);
  const full = n >= g.max;
  root.querySelector('[data-gcount]').textContent = `${n}/${g.max}`;
  root.classList.toggle('is-full', full);
  root.classList.remove('invalid');
  const err = root.querySelector('[data-gerr]');
  err.hidden = true;
  err.textContent = '';
  root.querySelectorAll('[data-opt]').forEach(i => i.setAttribute('aria-disabled', String(full && !i.checked)));
}

function pmTotalCents() {
  let total = activeProduct?.priceCents || 0;
  if (sel.size) total += sel.size.priceCents;
  for (const [cid, q] of Object.entries(sel.extras)) {
    const c = activeProduct.complements.find(x => x.id === Number(cid));
    if (c) total += c.priceCents * q;
  }
  return total;
}
function updatePmTotal() {
  const el = document.querySelector('#pm-total');
  if (el && activeProduct) el.textContent = brl(pmTotalCents());
}

document.addEventListener('click', e => {
  if (!activeProduct || !e.target.closest('#product-modal')) return;
  const comps = activeProduct.complements || [];
  const sizeBtn = e.target.closest('[data-size]');
  if (sizeBtn) {
    if (sizeBtn.disabled) return;
    sel.size = comps.find(c => c.id === Number(sizeBtn.dataset.size));
    document.querySelectorAll('[data-size]').forEach(b => { b.textContent = b === sizeBtn ? '✓' : '+'; b.disabled = b === sizeBtn || !!b.closest('.is-unavailable'); });
    updatePmTotal();
    return;
  }
  const opt = e.target.closest('[data-opt]');
  if (opt) {
    if (opt.disabled) { e.preventDefault(); return; }
    const g = pmGroups.find(x => x.id === Number(opt.dataset.optGroup));
    if (!g) return;
    // opt.checked já é o NOVO estado; groupCount ainda não conta esta opção
    if (opt.checked && groupCount(g) >= g.max) { e.preventDefault(); return; } // limite do grupo
    if (opt.checked) sel.extras[Number(opt.dataset.opt)] = 1; else delete sel.extras[Number(opt.dataset.opt)];
    refreshGroup(g);
    updatePmTotal();
    return;
  }
  const plus = e.target.closest('[data-plus]');
  const minus = e.target.closest('[data-minus]');
  if (plus || minus) {
    const cid = Number((plus || minus).dataset.plus || (plus || minus).dataset.minus);
    const comp = comps.find(c => c.id === cid);
    if (!comp || comp.unavailable) return;
    const q = sel.extras[cid] || 0;
    const next = Math.max(0, Math.min(comp.maxQuantity, q + (plus ? 1 : -1)));
    if (next) sel.extras[cid] = next; else delete sel.extras[cid];
    document.querySelector(`[data-count="${cid}"]`).textContent = next;
    document.querySelector(`[data-minus="${cid}"]`).disabled = next === 0;
    document.querySelector(`[data-plus="${cid}"]`).disabled = next >= comp.maxQuantity;
    updatePmTotal();
    return;
  }
  if (e.target.closest('#pm-add')) {
    if (closing.has('#product-modal')) return; // toque duplo durante o fechamento não adiciona duas vezes
    const missing = pmGroups.find(g => groupCount(g) < g.min);
    if (missing) { // minChoices não atendido: não adiciona
      const root = groupRoot(missing);
      const msg = `Escolha ${missing.min === 1 ? 'pelo menos 1' : `pelo menos ${missing.min}`} em "${missing.label}" para continuar.`;
      root.classList.add('invalid');
      const err = root.querySelector('[data-gerr]');
      err.textContent = msg;
      err.hidden = false;
      root.scrollIntoView({ block: 'center', behavior: REDUCED.matches ? 'auto' : 'smooth' });
      toast(msg, 2600);
      return;
    }
    addToCart(activeProduct, sel);
    requestClose('#product-modal');
    toast('Adicionado ao carrinho ✓');
  }
});

// O carrinho guarda ids (enviados ao servidor, que recalcula o preço) e nomes/preços só para exibição.
function addToCart(product, sel2) {
  if (product.unavailable) { toast('Este produto está indisponível no momento.'); return; }
  if ((product.complements || []).some(c => c.kind === 'size') && !sel2.size) { toast('Escolha um tamanho disponível.'); return; }
  const extras = Object.entries(sel2.extras).map(([cid, q]) => {
    const c = (product.complements || []).find(x => x.id === Number(cid));
    return { id: c.id, name: c.name, qty: q, priceCents: c.priceCents };
  });
  const size = sel2.size ? { id: sel2.size.id, name: sel2.size.name, priceCents: sel2.size.priceCents } : null;
  const item = { productId: product.id, name: product.name, size, extras, unitTotal: pmTotalCents(), qty: 1 };
  const key = cartKey(item);
  const existing = cart.find(i => i.key === key);
  if (existing) existing.qty += 1;
  else cart.push({ key, ...item });
  save();
}

function cartTotal() { return cart.reduce((s, i) => s + i.unitTotal * i.qty, 0); }
function cartCount() { return cart.reduce((s, i) => s + i.qty, 0); }

let lastFabCount = cartCount();
function renderCartFab() {
  const n = cartCount();
  cartFab.hidden = n === 0;
  cartFabCount.textContent = n;
  if (n > lastFabCount && !REDUCED.matches) { // contador "salta" ao adicionar
    cartFabCount.classList.remove('bump');
    void cartFabCount.offsetWidth;
    cartFabCount.classList.add('bump');
  }
  lastFabCount = n;
}

cartFab.addEventListener('click', () => { confirmRmKey = null; renderCart(); openModal('#cart-modal', { opener: cartFab }); });

// Tira do carrinho o que saiu do ar (produto pausado, tamanho ou complemento que não existe mais). Devolve os nomes removidos.
function pruneCart() {
  if (!menu.length) return [];
  const removed = [];
  cart = cart.filter(i => {
    const p = findProduct(i.productId);
    if (!p) return true; // não está no cardápio carregado: o servidor decide
    const comps = p.complements || [];
    const ok = !p.unavailable
      && (!i.size || comps.some(c => c.id === i.size.id && !c.unavailable))
      && i.extras.every(x => comps.some(c => c.id === x.id && !c.unavailable));
    if (!ok) removed.push(i.name);
    return ok;
  });
  if (removed.length) save();
  return removed;
}

let confirmRmKey = null; // item do carrinho esperando a confirmação de remover
const CART_QTY_MAX = 50;
function renderCart() {
  const removed = pruneCart();
  const noticeEl = document.querySelector('#cart-notice');
  noticeEl.hidden = !removed.length;
  noticeEl.textContent = removed.length
    ? (removed.length === 1 ? `O item "${removed[0]}" ficou indisponível e foi removido do carrinho.` : `Estes itens ficaram indisponíveis e foram removidos do carrinho: ${removed.join(', ')}.`)
    : '';
  const itemsEl = document.querySelector('#cart-items');
  if (!cart.length) {
    itemsEl.innerHTML = '<div class="cart-empty">Seu carrinho está vazio. Escolha um docinho no cardápio!</div>';
    document.querySelector('#checkout-btn').hidden = true;
    document.querySelector('#cart-total').innerHTML = '';
    return;
  }
  document.querySelector('#checkout-btn').hidden = false;
  itemsEl.innerHTML = cart.map((i, idx) => {
    const comps = [i.size && i.size.name, ...i.extras.map(x => x.qty > 1 ? `${x.name} ×${x.qty}` : x.name)].filter(Boolean).map(esc).join(' • ');
    return `
    <div class="cart-item">
      <div class="ci-info">
        <div class="ci-name">${esc(i.name)}</div>
        ${comps ? `<div class="ci-comps">${comps}</div>` : ''}
      </div>
      <span class="ci-price">${brl(i.unitTotal * i.qty)}</span>
      ${confirmRmKey === i.key ? `<div class="ci-confirm" role="alertdialog" aria-label="Remover ${esc(i.name)} do carrinho?"><span>Remover do carrinho?</span><button type="button" class="button primary" data-rm-yes="${idx}">Remover</button><button type="button" class="button secondary" data-rm-no>Manter</button></div>` : `<div class="ci-qty" role="group" aria-label="Quantidade de ${esc(i.name)}">
        <button type="button" class="ci-dec" data-dec="${idx}" aria-label="${i.qty === 1 ? `Remover ${esc(i.name)}` : `Diminuir quantidade de ${esc(i.name)}`}">${i.qty === 1 ? '🗑' : '−'}</button>
        <span class="n" aria-live="polite">${i.qty}</span>
        <button type="button" class="ci-inc" data-inc="${idx}" aria-label="Aumentar quantidade de ${esc(i.name)}" ${i.qty >= CART_QTY_MAX ? 'disabled' : ''}>+</button>
      </div>`}
    </div>`;
  }).join('');
  document.querySelector('#cart-total').innerHTML = `<span>Total</span><span>${brl(cartTotal())}</span>`;
}

document.addEventListener('click', e => {
  if (!e.target.closest('#cart-modal')) return;
  const dec = e.target.closest('[data-dec]'), inc = e.target.closest('[data-inc]');
  const yes = e.target.closest('[data-rm-yes]'), no = e.target.closest('[data-rm-no]');
  if (dec) {
    const it = cart[Number(dec.dataset.dec)];
    if (!it) return;
    if (it.qty > 1) it.qty -= 1; else { confirmRmKey = it.key; renderCart(); return; }
    save(); renderCart();
  } else if (inc) {
    const it = cart[Number(inc.dataset.inc)];
    if (it && it.qty < CART_QTY_MAX) { it.qty += 1; save(); renderCart(); }
  } else if (yes) {
    const it = cart[Number(yes.dataset.rmYes)];
    if (it && it.key === confirmRmKey) { cart.splice(Number(yes.dataset.rmYes), 1); confirmRmKey = null; save(); renderCart(); }
  } else if (no) { confirmRmKey = null; renderCart(); }
});

/* ---------- Pedidos recentes (C7): lista no navegador, só public_code + token de acompanhamento + data ---------- */
const RECENT_MAX = 10;
function loadRecent() {
  const raw = readStore(RECENT_KEY);
  // Só código público, token e data: qualquer outro campo (versões antigas) é descartado.
  return Array.isArray(raw) ? raw.filter(r => r && typeof r.token === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(r.token))
    .map(r => ({ public_code: typeof r.public_code === 'string' ? r.public_code.slice(0, 20) : '', token: r.token, date: typeof r.date === 'string' ? r.date : '' })) : [];
}
function addRecent(order) {
  if (!order.token) return;
  const list = loadRecent().filter(r => r.token !== order.token);
  list.unshift({ public_code: order.public_code || '', token: order.token, date: new Date().toISOString() });
  writeStore(RECENT_KEY, list.slice(0, RECENT_MAX));
  renderRecentBtn();
  refreshTrack();
}
const recentBtn = document.querySelector('#recent-btn');
const recentCountEl = document.querySelector('#recent-count');
function renderRecentBtn() {
  const n = loadRecent().length;
  recentBtn.hidden = n === 0;
  recentCountEl.textContent = String(n);
  recentBtn.setAttribute('aria-label', n > 1 ? `Pedidos recentes (${n})` : 'Pedidos recentes');
}
const dateTimeFmt = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
recentBtn.addEventListener('click', () => {
  const list = document.querySelector('#recent-list');
  list.replaceChildren();
  for (const r of loadRecent()) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = '/pedido.html?t=' + encodeURIComponent(r.token);
    const code = document.createElement('strong');
    code.textContent = r.public_code || 'Pedido';
    const when = document.createElement('span');
    const d = new Date(r.date);
    when.textContent = isNaN(d) ? '' : dateTimeFmt.format(d).replace(',', ' às');
    a.append(code, when);
    li.append(a);
    list.append(li);
  }
  openModal('#recent-modal', { opener: recentBtn });
});
renderRecentBtn();

/* ---------- Loja aberta/fechada (C3): fechada só impede finalizar ---------- */
const SP_TZ = 'America/Sao_Paulo';
const dayKey = d => new Intl.DateTimeFormat('en-CA', { timeZone: SP_TZ }).format(d);
function fmtWhen(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('pt-BR', { timeZone: SP_TZ, weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d).map(p => [p.type, p.value]));
  const time = `${parts.hour}:${parts.minute}`;
  const now = new Date();
  if (dayKey(d) === dayKey(now)) return `hoje (${parts.day}/${parts.month}) às ${time}`;
  if (dayKey(d) === dayKey(new Date(now.getTime() + 864e5))) return `amanhã (${parts.day}/${parts.month}) às ${time}`;
  return `${parts.weekday} (${parts.day}/${parts.month}) às ${time}`;
}
// Texto de loja fechada: horário de abertura (next_open_at), previsão de reabertura (reopens_at) ou a mensagem do servidor.
function closedMessage(st) {
  const base = String(st.message || '').replace(/\s*Previsão de reabertura:.*$/i, '').trim() || 'Estamos fechados no momento.';
  let when = '';
  if (st.reopens_at && (st.reason === 'manual' || !st.next_open_at)) when = `Previsão de reabertura: ${fmtWhen(st.reopens_at)}.`;
  else if (st.next_open_at) when = `Abrimos ${fmtWhen(st.next_open_at)}.`;
  return [base, when].filter(Boolean).join(' ');
}
let store = null; // { open, reason, reopens_at, next_open_at, message }
const storeBadgeEl = document.querySelector('#store-badge');
const closedNoteEl = document.querySelector('#store-closed-note');
function setStoreState(st) {
  store = st && typeof st === 'object' && typeof st.open === 'boolean' ? st : null;
  storeBadgeEl.hidden = !store;
  if (store) {
    storeBadgeEl.className = 'store-badge ' + (store.open ? 'open' : 'closed');
    // V6: texto curto abaixo de 380 px (CSS escolhe qual aparece); o curto fica fora da leitura de tela para não repetir
    const longT = document.createElement('span'), shortT = document.createElement('span');
    longT.className = 'sb-long'; longT.textContent = store.open ? 'Loja aberta' : 'Loja fechada';
    shortT.className = 'sb-short'; shortT.textContent = store.open ? 'Aberta' : 'Fechada'; shortT.setAttribute('aria-hidden', 'true');
    storeBadgeEl.replaceChildren(longT, shortT);
    storeBadgeEl.title = store.open ? '' : closedMessage(store);
  }
  const closed = !!store && !store.open;
  closedNoteEl.hidden = !closed;
  closedNoteEl.textContent = closed ? closedMessage(store) + ' Você pode montar o carrinho, mas só conseguimos receber o pedido com a loja aberta.' : '';
  syncSubmitState();
}
async function refreshStore() {
  try {
    const r = await fetch('/api/store?a=state', { cache: 'no-store' });
    if (r.ok) setStoreState(await r.json());
  } catch { /* mantém o último estado */ }
}
setInterval(() => { if (!document.hidden) refreshStore(); }, 60000);

/* ---------- Conta do cliente (C8, contrato do A10): sem a rota ou sem login = deslogado ---------- */
let account = null; // { name, points: { balance, locked_until } }
const accountAreaEl = document.querySelector('#account-area');
function topLink(text, href, cls) {
  const a = document.createElement('a');
  a.className = 'topbar-btn' + (cls ? ' ' + cls : '');
  a.href = href;
  a.textContent = text;
  return a;
}
function renderAccount() {
  accountAreaEl.replaceChildren();
  if (!account) {
    // V6: visitante só vê "Entrar"; "Criar conta" fica na tela de entrada (/conta/) e no convite de pontos do checkout
    accountAreaEl.append(topLink('Entrar', '/conta/', 'primary'));
    return;
  }
  const bal = Number(account.points && account.points.balance) || 0;
  const first = String(account.name || '').trim().split(/\s+/)[0] || 'Conta';
  const pts = topLink('', '/conta/#pontos', 'points');
  const n = document.createElement('span'); n.textContent = String(bal);
  const word = document.createElement('span'); word.className = 'pts-word'; word.textContent = ' pontos';
  pts.append(n, word);
  pts.setAttribute('aria-label', `${bal} pontos`);
  const acc = topLink('', '/conta/#pedidos', 'account');
  const av = document.createElement('span'); av.className = 'acc-av'; av.setAttribute('aria-hidden', 'true'); av.textContent = first.charAt(0).toUpperCase();
  const nm = document.createElement('span'); nm.className = 'acc-name'; nm.textContent = first;
  acc.append(av, nm);
  acc.setAttribute('aria-label', `Minha conta: ${first}`);
  accountAreaEl.append(pts, acc);
}
async function loadAccount() {
  try {
    const r = await fetch('/api/customer?a=me', { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) account = null;
    else { const d = await r.json(); account = d && d.logged_in && d.customer ? d.customer : null; }
  } catch { account = null; }
  renderAccount();
  renderPoints();
  renderSummary();
  refreshTrack();
}

/* ---------- V5: botão flutuante "Acompanhe" ----------
   Aparece quando há pedido não concluído: dos recentes no aparelho (dg-recent-orders, status consultado em /api/order-status)
   ou do cliente logado (/api/customer?a=orders). Um pedido: abre direto o acompanhamento. Mais de um: lista. */
const TRACK_DONE = new Set(['completed', 'delivered', 'cancelled']);
const TRACK_PAY_DEAD = new Set(['rejected', 'cancelled', 'refunded', 'charged_back']);
const TRACK_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const TRACK_CHECKS = 5;      // no máximo 5 consultas de status por rodada (limite do servidor: 300 em 10 min por IP)
const TRACK_EVERY_MS = 60000;
let trackItems = [];
let trackSeq = 0;
let trackLastAt = 0;
const trackActive = o => !!o && !TRACK_DONE.has(o.fulfillment_status) && !TRACK_PAY_DEAD.has(o.payment_status);
const trackFresh = iso => { const t = Date.parse(iso); return !isNaN(t) && Date.now() - t < TRACK_MAX_AGE_MS; };
async function trackStatusOf(r) {
  try {
    const res = await fetch('/api/order-status?t=' + encodeURIComponent(r.token), { cache: 'no-store' });
    if (res.status === 404) return null;        // pedido não existe mais
    if (!res.ok) return { unknown: true };      // 429 ou erro: mantém visível, sem status
    return await res.json();
  } catch { return { unknown: true }; }
}
async function trackMyOrders() {
  if (!account) return [];
  try {
    const res = await fetch('/api/customer?a=orders&limit=10', { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) return [];
    const d = await res.json();
    return Array.isArray(d.orders) ? d.orders : [];
  } catch { return []; }
}
async function refreshTrack() {
  const my = ++trackSeq;
  trackLastAt = Date.now();
  const recents = loadRecent().filter(r => trackFresh(r.date)).slice(0, TRACK_CHECKS);
  const [statuses, mine] = await Promise.all([Promise.all(recents.map(trackStatusOf)), trackMyOrders()]);
  if (my !== trackSeq) return; // chegou uma rodada mais nova
  const items = [];
  const seen = new Set();
  recents.forEach((r, i) => {
    const s = statuses[i];
    if (s === null || (!s.unknown && !trackActive(s))) return;
    const code = (s && s.public_code) || r.public_code || '';
    if (code) seen.add(code);
    items.push({ code, href: '/pedido.html?t=' + encodeURIComponent(r.token), label: s.unknown ? '' : String(s.fulfillment_label || ''), date: r.date });
  });
  for (const o of mine) {
    if (!trackActive(o) || !trackFresh(o.created_at) || (o.public_code && seen.has(o.public_code))) continue;
    items.push({ code: o.public_code || '', href: '/conta/#pedidos', label: String(o.fulfillment_label || ''), date: o.created_at });
  }
  items.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  trackItems = items;
  renderTrackFab();
}
function renderTrackFab() {
  const n = trackItems.length;
  trackFab.hidden = n === 0;
  trackFabCount.hidden = n < 2;
  trackFabCount.textContent = n < 2 ? '' : String(n);
  trackFab.setAttribute('aria-label', n > 1 ? `Acompanhar meus ${n} pedidos` : 'Acompanhar meu pedido');
}
trackFab.addEventListener('click', () => {
  if (trackItems.length === 1) { location.href = trackItems[0].href; return; }
  const list = document.querySelector('#track-list');
  list.replaceChildren();
  for (const it of trackItems) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = it.href;
    const code = document.createElement('strong');
    code.textContent = it.code || 'Pedido';
    const info = document.createElement('span');
    const d = new Date(it.date);
    info.textContent = [it.label, isNaN(d) ? '' : dateTimeFmt.format(d).replace(',', ' às')].filter(Boolean).join(' · ');
    a.append(code, info);
    li.append(a);
    list.append(li);
  }
  openModal('#track-modal', { opener: trackFab });
});
setInterval(() => { if (!document.hidden && (loadRecent().length || account)) refreshTrack(); }, TRACK_EVERY_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - trackLastAt > 20000) refreshTrack(); });

/* ---------- Checkout ---------- */
const checkoutFormEl = document.querySelector('#checkout-form');
const paymentStepEl = document.querySelector('#payment-step');
const checkoutTitleEl = document.querySelector('#checkout-title');
const addressFieldEl = document.querySelector('#address-field');
const pickupInfoEl = document.querySelector('#pickup-info');
const quoteBtnEl = document.querySelector('#quote-btn');
const quoteBoxEl = document.querySelector('#quote-box');
const submitBtnEl = checkoutFormEl.querySelector('button[type="submit"]');
const pointsBoxEl = document.querySelector('#points-box');
const field = n => checkoutFormEl.elements[n];
const digitsOf = v => String(v || '').replace(/\D/g, '');
const isPickup = () => field('delivery').value === 'pickup';
document.querySelector('#store-address').textContent = STORE_ADDRESS;

let submitting = false;
function syncSubmitState() { submitBtnEl.disabled = submitting || (!!store && !store.open); }

// Retirada: some o endereço do cliente (sem required nem envio) e mostra o endereço da loja.
function syncDelivery() {
  const pickup = isPickup();
  addressFieldEl.hidden = pickup;
  addressFieldEl.querySelectorAll('input').forEach(i => { i.disabled = pickup; i.required = !pickup && !['complement', 'district', 'city'].includes(i.name); });
  pickupInfoEl.hidden = !pickup;
  renderPoints();
  renderSummary();
}
checkoutFormEl.addEventListener('change', e => { if (e.target.name === 'delivery') syncDelivery(); });

/* Frete (C4): a cotação só informa; o pedido é recalculado no servidor */
let quote = null; // { key, km, fee_cents, band }
let quoteSeq = 0;
const fullAddress = () => {
  const num = field('address_number').value.trim();
  const comp = field('complement').value.trim();
  const area = [field('district').value.trim(), field('city').value.trim()].filter(Boolean).join(', ');
  return `${field('address').value.trim()}, ${num}${comp ? ' - ' + comp : ''}${area ? ' - ' + area : ''}`.slice(0, 200);
};
const quoteKey = () => [digitsOf(field('cep').value), fullAddress()].join('|');
const kmText = n => Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
function showQuote(msg, kind) {
  quoteBoxEl.textContent = msg;
  quoteBoxEl.className = 'quote-box' + (kind ? ' ' + kind : '');
  quoteBoxEl.hidden = !msg;
}
function quoteErrorText(status, d) {
  const code = d && d.code;
  if (code === 'invalid_cep') return 'CEP inválido. Informe os 8 números do CEP.';
  if (code === 'invalid_address') return 'Endereço inválido. Confira a rua e o número.';
  if (code === 'cep_not_found') return 'CEP não encontrado. Confira o CEP digitado.';
  if (code === 'address_not_found') return 'Não encontramos esse endereço. Confira a rua, o número e o CEP.';
  if (code === 'out_of_area') return `Esse endereço fica fora da nossa área de entrega${d.max_km ? ` (até ${kmText(d.max_km)} km)` : ''}. Você pode escolher retirada.`;
  if (code === 'origin_unavailable' || status === 503) return 'O cálculo do frete está indisponível agora. Tente de novo em instantes ou escolha retirada.';
  if (status === 429) return 'Muitas consultas de frete. Aguarde um instante e tente de novo.';
  return 'Não foi possível calcular o frete agora. Tente de novo em instantes.';
}
function invalidateQuote() {
  if (quote && quote.key !== quoteKey()) { quote = null; showQuote('', ''); renderPoints(); renderSummary(); }
}
async function runQuote() {
  const cep = digitsOf(field('cep').value);
  if (cep.length !== 8) { showQuote('Informe o CEP com 8 números.', 'warn'); return null; }
  if (field('address').value.trim().length < 3) { showQuote('Informe a rua.', 'warn'); return null; }
  if (!field('address_number').value.trim()) { showQuote('Informe o número da casa (ou s/n).', 'warn'); return null; }
  const key = quoteKey();
  const mine = ++quoteSeq;
  quoteBtnEl.disabled = true;
  showQuote('Calculando o frete...', '');
  try {
    const qs = new URLSearchParams({ a: 'quote', cep, address: fullAddress(), number: field('address_number').value.trim() });
    const r = await fetch('/api/store?' + qs, { cache: 'no-store' });
    let d = {};
    try { d = await r.json(); } catch { /* corpo não-JSON */ }
    if (mine !== quoteSeq || key !== quoteKey()) return null; // o endereço mudou no meio do caminho
    if (!r.ok || !Number.isInteger(d.fee_cents)) { quote = null; showQuote(quoteErrorText(r.status, d), 'warn'); renderPoints(); renderSummary(); return null; }
    quote = { key, km: Number(d.km), fee_cents: d.fee_cents, band: d.faixa || null };
    const faixa = quote.band && quote.band.max_km ? ` · faixa até ${kmText(quote.band.max_km)} km` : '';
    showQuote(`Distância: ${kmText(quote.km)} km${faixa} · Frete: ${brl(quote.fee_cents)}`, 'ok');
    renderPoints();
    renderSummary();
    return quote;
  } catch {
    if (mine === quoteSeq) { quote = null; showQuote('Sem conexão para calcular o frete. Confira a internet e tente de novo.', 'warn'); }
    return null;
  } finally {
    if (mine === quoteSeq) quoteBtnEl.disabled = false;
  }
}
quoteBtnEl.addEventListener('click', runQuote);
const cepInput = field('cep');
/* L3: ao completar os 8 números, busca rua, bairro e cidade (GET /api/store?a=cep). Os campos continuam editáveis,
   e se o CEP falhar o cliente preenche à mão. Uma consulta por CEP (o servidor limita por IP): o resultado fica em memória. */
const cepStatusEl = document.querySelector('#cep-status');
const cepCache = new Map(); // cep -> { ok, data } | { ok:false, msg }
let cepSeq = 0;
function showCepStatus(msg, kind) {
  cepStatusEl.textContent = msg;
  cepStatusEl.className = 'cep-status' + (kind ? ' ' + kind : '');
  cepStatusEl.hidden = !msg;
}
function applyCep(r) {
  const set = (name, v) => { if (v) field(name).value = v; };
  set('address', r.data.street); set('district', r.data.district); set('city', r.data.city);
  quote = null; showQuote('', ''); renderPoints(); renderSummary();
  showCepStatus(r.data.street || r.data.district || r.data.city ? 'Endereço preenchido pelo CEP. Confira e complete o número.' : 'CEP sem rua cadastrada. Preencha o endereço à mão.', r.data.street ? 'ok' : 'warn');
  if (r.data.street && !field('address_number').value) field('address_number').focus({ preventScroll: true });
}
async function lookupCep() {
  const cep = digitsOf(cepInput.value);
  if (cep.length !== 8) { cepSeq++; showCepStatus('', ''); return; }
  const cached = cepCache.get(cep);
  if (cached) { if (cached.ok) applyCep(cached); else showCepStatus(cached.msg, 'warn'); return; }
  const mine = ++cepSeq;
  showCepStatus('Buscando o endereço...', '');
  try {
    const r = await fetch('/api/store?a=cep&cep=' + cep, { cache: 'no-store' });
    let d = {};
    try { d = await r.json(); } catch { /* corpo não-JSON */ }
    if (mine !== cepSeq) return; // o CEP mudou no meio do caminho
    if (r.ok && d && typeof d === 'object') { const res = { ok: true, data: d }; cepCache.set(cep, res); applyCep(res); return; }
    const msg = r.status === 404 ? 'CEP não encontrado. Confira o número ou preencha o endereço à mão.'
      : r.status === 429 ? 'Muitas consultas de CEP agora. Preencha o endereço à mão.'
      : 'Não foi possível buscar o CEP agora. Preencha o endereço à mão.';
    if (r.status === 404) cepCache.set(cep, { ok: false, msg });
    showCepStatus(msg, 'warn');
  } catch {
    if (mine === cepSeq) showCepStatus('Sem conexão para buscar o CEP. Preencha o endereço à mão.', 'warn');
  }
}
cepInput.addEventListener('input', () => {
  const d = digitsOf(cepInput.value).slice(0, 8);
  cepInput.value = d.length > 5 ? d.slice(0, 5) + '-' + d.slice(5) : d;
  lookupCep();
});
addressFieldEl.addEventListener('input', invalidateQuote);
// ao terminar de preencher (sai do campo), calcula sozinho se estiver tudo pronto
addressFieldEl.addEventListener('change', e => {
  if (e.target.name === 'complement') return;
  if (digitsOf(cepInput.value).length === 8 && field('address').value.trim().length >= 3 && field('address_number').value.trim() && (!quote || quote.key !== quoteKey())) runQuote();
});

/* Resumo: subtotal, frete, desconto e total. Antes do pedido, frete da cotação; depois, os valores da resposta do servidor. */
function fillSummary(el, v) {
  el.replaceChildren();
  const row = (label, value, cls) => {
    const d = document.createElement('div');
    d.className = 'sum-row' + (cls ? ' ' + cls : '');
    const a = document.createElement('span'); a.textContent = label;
    const b = document.createElement('span'); b.textContent = value;
    d.append(a, b);
    el.append(d);
  };
  row('Subtotal', brl(v.subtotal));
  row('Frete', v.fee == null ? 'calcule acima' : v.pickup ? 'R$ 0,00 (retirada)' : brl(v.fee));
  if (v.discount > 0) row('Desconto com pontos', '− ' + brl(v.discount), 'sum-discount');
  row(v.fee == null ? 'Total (sem frete)' : 'Total', brl(v.total), 'sum-total');
}
let usePoints = 0;
function currentFee() { return isPickup() ? 0 : (quote && quote.key === quoteKey() ? quote.fee_cents : null); }
function renderSummary() {
  const sub = cartTotal();
  const fee = currentFee();
  const discount = usePoints / pointsRules.blockPoints * pointsRules.blockValueCents;
  fillSummary(document.querySelector('#payment-summary'), { subtotal: sub, fee, pickup: isPickup(), discount, total: sub + (fee || 0) - discount });
}

/* Pontos (C8/U5): só logado, em blocos (padrão 100 pontos = R$ 10), limitado pelo subtotal; o servidor confere tudo.
   A regra vem de /api/menu (Ajustes do painel); aqui só serve para montar a lista e o resumo. */
let pointsRules = { enabled: true, pointsPerReal: 1, blockPoints: 100, blockValueCents: 1000 };
function setPointsRules(r) {
  const ok = n => Number.isInteger(n) && n > 0;
  if (!r || typeof r.enabled !== 'boolean' || !ok(r.pointsPerReal) || !ok(r.blockPoints) || !ok(r.blockValueCents)) return;
  pointsRules = { enabled: r.enabled, pointsPerReal: r.pointsPerReal, blockPoints: r.blockPoints, blockValueCents: r.blockValueCents };
  renderPoints();
  renderSummary();
}
// Recarrega a regra (ex.: o pedido foi recusado porque a regra mudou depois que a página abriu).
function refreshPointsRules() {
  fetch('/api/menu', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).then(d => { if (d) setPointsRules(d.points); }).catch(() => {});
}
function maxPointBlocks() {
  if (!account) return 0;
  const bal = Number(account.points && account.points.balance) || 0;
  const fee = currentFee() || 0;
  const maxDiscount = Math.min(cartTotal(), cartTotal() + fee - 100); // não passa do subtotal; sobra pelo menos R$ 1,00
  return Math.max(0, Math.min(Math.floor(bal / pointsRules.blockPoints), Math.floor(maxDiscount / pointsRules.blockValueCents)));
}
/* L6: quantos pontos este pedido rende (POST /api/customer?a=points_preview). Só exibição: o servidor decide na hora do pedido. */
let pointsPreview = { points: 0, enabled: true };
let previewKey = '', previewSeq = 0, previewTimer = null;
const ptsText = n => `${n} ${n === 1 ? 'ponto' : 'pontos'}`;
function loadPointsPreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    if (!cart.length) { pointsPreview = { points: 0, enabled: true }; previewKey = ''; renderPoints(); return; }
    const items = cart.map(i => ({ product_id: i.productId, qty: i.qty, size_id: i.size ? i.size.id : undefined, extras: i.extras.map(x => ({ id: x.id, qty: x.qty })) }));
    const body = { items };
    if (usePoints > 0) body.use_points = usePoints;
    const key = JSON.stringify(body);
    if (key === previewKey) return;
    const mine = ++previewSeq;
    try {
      const r = await fetch('/api/customer?a=points_preview', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: key });
      if (mine !== previewSeq) return;
      if (!r.ok) { pointsPreview = { points: 0, enabled: true }; previewKey = ''; renderPoints(); return; }
      const d = await r.json();
      previewKey = key;
      pointsPreview = { points: Number.isInteger(d.points) && d.points > 0 ? d.points : 0, enabled: d.enabled !== false };
    } catch { if (mine !== previewSeq) return; pointsPreview = { points: 0, enabled: true }; previewKey = ''; }
    renderPoints();
  }, 150);
}
// Visitante: convite para entrar (volta ao checkout, o carrinho fica no aparelho). Logado: aviso de quantos pontos o pedido gera.
function renderPoints() {
  const earn = pointsRules.enabled && pointsPreview.enabled ? pointsPreview.points : 0;
  if (!account && pointsRules.enabled) {
    usePoints = 0;
    pointsBoxEl.replaceChildren();
    pointsBoxEl.hidden = !(earn > 0);
    if (earn > 0) {
      const note = document.createElement('p');
      note.className = 'points-note points-earn';
      note.textContent = `Entre na sua conta e ganhe ${ptsText(earn)} com este pedido.`;
      const a = document.createElement('a');
      a.className = 'button secondary points-login';
      a.href = '/conta/?voltar=checkout#entrar';
      a.textContent = 'Entrar na minha conta';
      pointsBoxEl.append(note, a);
    }
    return;
  }
  renderPointsInner();
  if (account && earn > 0 && !pointsBoxEl.hidden) {
    const e = document.createElement('p');
    e.className = 'points-note points-earn';
    e.textContent = `Este pedido vai gerar ${ptsText(earn)}.`;
    pointsBoxEl.append(e);
  }
}
function renderPointsInner() {
  pointsBoxEl.replaceChildren();
  const p = (text, cls) => { const e = document.createElement('p'); e.className = 'points-note' + (cls ? ' ' + cls : ''); e.textContent = text; return e; };
  const BP = pointsRules.blockPoints, BV = brl(pointsRules.blockValueCents);
  if (!pointsRules.enabled) {
    usePoints = 0;
    pointsBoxEl.hidden = !account;
    if (account) pointsBoxEl.append(p('O programa de pontos está pausado no momento. Você pode comprar normalmente; seu saldo continua guardado.'));
    return;
  }
  if (!account) {
    usePoints = 0;
    const note = p(`Tem conta? Entre para usar seus pontos (${BP} pontos = ${BV}). `);
    const a = document.createElement('a'); a.href = '/conta/'; a.textContent = 'Entrar';
    note.append(a);
    pointsBoxEl.append(note);
    pointsBoxEl.hidden = false;
    return;
  }
  const bal = Number(account.points && account.points.balance) || 0;
  const lockedUntil = account.points && account.points.locked_until;
  pointsBoxEl.hidden = false;
  if (lockedUntil && Date.parse(lockedUntil) > Date.now()) {
    usePoints = 0;
    pointsBoxEl.append(p(`Seus pontos estão bloqueados por segurança até ${fmtWhen(lockedUntil)} (depois da recuperação da conta). Você pode comprar normalmente, sem usar pontos.`, 'warn'));
    return;
  }
  if (bal < BP) {
    usePoints = 0;
    pointsBoxEl.append(p(`Você tem ${bal} pontos. A partir de ${BP} pontos você troca por ${BV} de desconto.`));
    return;
  }
  const max = maxPointBlocks();
  if (max < 1) {
    usePoints = 0;
    pointsBoxEl.append(p(`Você tem ${bal} pontos, mas este pedido é pequeno para usar um bloco de ${BP} pontos (o desconto não pode passar do valor dos itens e o total mínimo é R$ 1,00).`));
    return;
  }
  if (usePoints % BP !== 0) usePoints = 0; // a regra mudou: escolhe de novo
  if (usePoints / BP > max) usePoints = max * BP;
  const label = document.createElement('label');
  label.textContent = `Usar pontos (você tem ${bal})`;
  const sel = document.createElement('select');
  sel.id = 'use-points';
  sel.name = 'use_points_ui';
  for (let b = 0; b <= max; b++) {
    const o = document.createElement('option');
    o.value = String(b * BP);
    o.textContent = b === 0 ? 'Não usar pontos' : `${b * BP} pontos (− ${brl(b * pointsRules.blockValueCents)})`;
    sel.append(o);
  }
  sel.value = String(usePoints);
  sel.addEventListener('change', () => { usePoints = Number(sel.value) || 0; renderSummary(); loadPointsPreview(); });
  label.append(sel);
  pointsBoxEl.append(label);
}

/* ---------- Etapa pós-pedido: cartão (link), Pix (QR no site) ou sem pagamento. O botão do WhatsApp só vem depois de aprovado (C6). ---------- */
const payEls = {
  codeRow: document.querySelector('#payment-code-row'),
  code: document.querySelector('#payment-code'),
  text: document.querySelector('#payment-text'),
  summary: document.querySelector('#pay-summary'),
  track: document.querySelector('#pay-track'),
  trackLink: document.querySelector('#pay-track-link'),
  status: document.querySelector('#pay-status'),
  pixBox: document.querySelector('#pix-box'),
  qr: document.querySelector('#pix-qr'),
  pixCode: document.querySelector('#pix-code'),
  copyBtn: document.querySelector('#pix-copy'),
  copyStatus: document.querySelector('#pix-copy-status'),
  timer: document.querySelector('#pix-timer'),
  card: document.querySelector('#pay-mp'),
  support: document.querySelector('#pay-support'),
  retry: document.querySelector('#pay-retry'),
  wa: document.querySelector('#pay-wa'),
  help: document.querySelector('#pay-help')
};
const PIX_DEFAULT_MS = 30 * 60 * 1000;
const POLL_MS = 5000;
const PREP_TEXT = 'Estamos preparando seu pedido e vamos avisar por aqui e pelo WhatsApp.';
const watch = { token: 0, poll: null, tick: null, pollNow: null };
let lastCartCopy = null; // cópia do carrinho do último pedido, para "refazer" se o Pix expirar ou falhar
let copyTimer = null;

// Para contagem e polling (fechar o modal, expirar, aprovar, recusar, refazer). O token invalida respostas em voo.
function stopPayWatch() {
  watch.token++;
  clearInterval(watch.poll);
  clearInterval(watch.tick);
  watch.poll = watch.tick = watch.pollNow = null;
}
/* L4: cliente logado abre o checkout já com nome, telefone e endereço (GET /api/customer?a=prefill).
   Só preenche campo que a pessoa ainda não mexeu e que está vazio; tudo continua editável. */
const PREFILL_FIELDS = ['name', 'phone', 'cep', 'address', 'address_number', 'complement', 'district', 'city'];
checkoutFormEl.addEventListener('input', e => { if (e.target && e.target.name) e.target.dataset.touched = '1'; });
const maskPhoneBR = v => {
  let d = digitsOf(v);
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  d = d.slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
};
async function loadPrefill() {
  try {
    const r = await fetch('/api/customer?a=prefill', { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    if (!d || !d.logged_in) return;
    const put = (name, v) => { const el = field(name); if (el && v && !el.dataset.touched && !el.value) el.value = v; };
    put('name', d.name);
    put('phone', maskPhoneBR(d.phone_national || d.phone));
    const ad = d.address;
    if (ad && typeof ad === 'object') {
      const cep = digitsOf(ad.cep);
      if (cep.length === 8 && !field('cep').dataset.touched && !field('cep').value) {
        field('cep').value = cep.slice(0, 5) + '-' + cep.slice(5);
        cepCache.set(cep, { ok: true, data: { street: ad.street, district: ad.district, city: ad.city } }); // não gasta consulta de CEP
      }
      put('address', ad.street); put('address_number', ad.number); put('complement', ad.complement); put('district', ad.district); put('city', ad.city);
    }
  } catch { /* sem pré-preenchimento: segue à mão */ }
}
modalHooks['#checkout-modal'] = { open() { refreshStore(); loadAccount(); loadPrefill(); loadPointsPreview(); }, close: stopPayWatch };

function normalizePayment(p) {
  if (!p || typeof p !== 'object') return null;
  if (p.type === 'pix') {
    const qr = typeof p.qr_code === 'string' ? p.qr_code.trim() : '';
    const b64 = typeof p.qr_code_base64 === 'string' ? p.qr_code_base64.replace(/\s+/g, '') : '';
    if (!qr) return null;
    return { type: 'pix', id: p.id, qr_code: qr, qr_code_base64: /^[A-Za-z0-9+/]+=*$/.test(b64) ? b64 : '', expires_at: p.expires_at };
  }
  // type 'card' (ou resposta antiga só com url)
  if (typeof p.url === 'string' && /^https:\/\//i.test(p.url)) return { type: 'card', url: p.url, id: p.id };
  return null;
}

function setWhatsApp(text) {
  const ok = !!WHATSAPP_NUMBER && !!text;
  payEls.wa.hidden = !ok;
  if (ok) payEls.wa.href = waLink(text);
  payEls.wa.classList.add('primary');
  payEls.wa.classList.remove('secondary');
}
function setPayStatus(msg, kind) {
  payEls.status.textContent = msg;
  payEls.status.className = 'pay-status' + (kind ? ' ' + kind : '');
  payEls.status.hidden = !msg;
}
const trackUrl = token => '/pedido.html?t=' + encodeURIComponent(token);

function renderOrderStep(order, { title, text, watchNow } = {}) {
  stopPayWatch();
  const pay = order.payment;
  const type = pay ? pay.type : null;
  payEls.code.textContent = order.publicCode || order.code || '';
  payEls.codeRow.hidden = !(order.publicCode || order.code);
  payEls.track.hidden = !order.token;
  if (order.token) payEls.trackLink.href = trackUrl(order.token);
  payEls.summary.hidden = !order.summary;
  if (order.summary) fillSummary(payEls.summary, order.summary);
  setPayStatus('', '');
  payEls.pixBox.hidden = type !== 'pix';
  payEls.card.hidden = payEls.support.hidden = type !== 'card';
  payEls.retry.hidden = true;
  payEls.wa.hidden = true; // só depois do pagamento confirmado
  payEls.help.hidden = true;
  payEls.copyStatus.textContent = '';
  payEls.timer.textContent = '';
  let msg = text;
  if (msg == null) {
    msg = type === 'pix' ? 'Pedido registrado! Pague com o Pix abaixo. Esta tela confirma sozinha quando o pagamento cair.'
      : type === 'card' ? 'Pedido registrado! Pague com cartão no botão abaixo. Esta tela confirma sozinha quando o pagamento for aprovado.'
      : 'Pedido registrado! Não foi possível gerar o pagamento agora. Fale com a Gigi pelo WhatsApp para combinar o pagamento.';
  }
  payEls.text.textContent = msg;
  if (type === 'card') payEls.card.href = pay.url;
  if (type === 'pix') {
    payEls.pixCode.value = pay.qr_code;
    if (pay.qr_code_base64) { payEls.qr.src = 'data:image/png;base64,' + pay.qr_code_base64; payEls.qr.hidden = false; }
    else { payEls.qr.removeAttribute('src'); payEls.qr.hidden = true; }
  }
  if (!pay && !watchNow && WHATSAPP_NUMBER) {
    payEls.help.hidden = false;
    payEls.help.href = waLink(`Olá! Fiz o pedido ${order.publicCode || order.code} pelo site e o pagamento não foi gerado. Pode me ajudar?`);
  }
  checkoutFormEl.hidden = true;
  paymentStepEl.hidden = false;
  checkoutTitleEl.textContent = title || (type === 'pix' ? 'Pague com Pix' : type === 'card' ? 'Pagamento' : 'Pedido registrado');
  const panel = paymentStepEl.closest('.modal-panel');
  if (panel) panel.scrollTop = 0;
  (type === 'pix' ? payEls.copyBtn : type === 'card' ? payEls.card : payEls.help.hidden ? payEls.trackLink : payEls.help).focus({ preventScroll: true });
  if (type || watchNow) startPayWatch(order, pay, !!watchNow);
}

function startPayWatch(order, pay, immediate) {
  const token = watch.token;
  if (pay && pay.type === 'pix') {
    let expiresAt = Date.parse(pay.expires_at);
    if (!Number.isFinite(expiresAt)) expiresAt = Date.now() + PIX_DEFAULT_MS;
    const tick = () => {
      if (token !== watch.token) return;
      const left = expiresAt - Date.now();
      if (left <= 0) { onPayEnded(order, 'O Pix expirou (valia 30 minutos). Nenhum valor foi cobrado. Você pode refazer o pedido.'); return; }
      const s = Math.ceil(left / 1000);
      payEls.timer.textContent = `O Pix expira em ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    };
    tick();
    if (token !== watch.token) return; // já expirou ao abrir
    watch.tick = setInterval(tick, 1000);
  }
  let busy = false;
  const url = order.token ? '/api/order-status?t=' + encodeURIComponent(order.token) : '/api/order-status?code=' + encodeURIComponent(order.code);
  const poll = async () => {
    if (busy || token !== watch.token) return;
    busy = true;
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      if (token !== watch.token) return;
      if (d.payment_status === 'approved') onPayApproved(order);
      else if (d.payment_status === 'rejected') onPayEnded(order, 'O pagamento foi recusado. Você pode tentar de novo ou refazer o pedido.');
      else if (d.payment_status === 'cancelled') onPayEnded(order, 'O pagamento foi cancelado. Você pode refazer o pedido.');
    } catch { /* sem rede: tenta de novo no próximo ciclo */ } finally { busy = false; }
  };
  watch.pollNow = poll;
  watch.poll = setInterval(poll, POLL_MS);
  if (immediate) poll();
}

function onPayApproved(order) {
  stopPayWatch();
  payEls.pixBox.hidden = true;
  payEls.card.hidden = payEls.support.hidden = true;
  payEls.retry.hidden = true;
  payEls.help.hidden = true;
  setPayStatus('Pagamento confirmado!', 'ok');
  payEls.text.textContent = PREP_TEXT + (WHATSAPP_NUMBER ? ' Se quiser, envie o pedido também pelo WhatsApp.' : '');
  checkoutTitleEl.textContent = 'Pagamento confirmado';
  setWhatsApp(order.whatsappText ? order.whatsappText + '\nPagamento confirmado ✓'
    : `Olá! Fiz o pedido ${order.publicCode || order.code || ''} pelo site e o pagamento foi confirmado ✓` + (order.token ? `\nAcompanhar: ${location.origin}${trackUrl(order.token)}` : ''));
  (payEls.wa.hidden ? payEls.trackLink : payEls.wa).focus({ preventScroll: true });
  toast('Pagamento confirmado! ✓', 3000);
}

function onPayEnded(order, msg) {
  stopPayWatch();
  payEls.pixBox.hidden = true;
  setPayStatus(msg, 'warn');
  payEls.text.textContent = 'Se já pagou, fale com a Gigi pelo WhatsApp informando o número do pedido.';
  checkoutTitleEl.textContent = 'Pagamento não concluído';
  payEls.retry.hidden = !(lastCartCopy && lastCartCopy.length);
  if (WHATSAPP_NUMBER) {
    payEls.help.hidden = false;
    payEls.help.href = waLink(`Olá! Tive um problema com o pagamento do pedido ${order.publicCode || order.code}. Pode me ajudar?`);
  }
  (payEls.retry.hidden ? payEls.help : payEls.retry).focus({ preventScroll: true });
}

// Refazer: devolve os itens ao carrinho e volta ao formulário
payEls.retry.addEventListener('click', () => {
  if (!lastCartCopy || !lastCartCopy.length) return;
  cart = lastCartCopy.map(i => ({ ...i }));
  save();
  resetCheckoutView();
  pruneCart();
  renderPoints();
  renderSummary();
});

// Ao voltar para a aba, confere o pagamento na hora (o navegador atrasa timers em segundo plano)
document.addEventListener('visibilitychange', () => { if (!document.hidden && watch.pollNow) watch.pollNow(); });

async function copyPix() {
  const text = payEls.pixCode.value;
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); ok = true; }
  } catch { /* cai no plano B */ }
  if (!ok) {
    try {
      payEls.pixCode.focus({ preventScroll: true });
      payEls.pixCode.select();
      payEls.pixCode.setSelectionRange(0, text.length);
      ok = document.execCommand('copy');
    } catch { ok = false; }
  }
  clearTimeout(copyTimer);
  payEls.copyStatus.textContent = '';
  copyTimer = setTimeout(() => { // vazio -> texto, para o leitor de tela anunciar de novo
    payEls.copyStatus.textContent = ok ? 'Copiado!' : 'Não deu para copiar sozinho. Toque no código, selecione tudo e copie.';
    payEls.copyStatus.classList.toggle('err', !ok);
  }, 30);
}
payEls.copyBtn.addEventListener('click', copyPix);
payEls.pixCode.addEventListener('focus', () => payEls.pixCode.select());

function resetCheckoutView() {
  stopPayWatch();
  checkoutFormEl.hidden = false;
  paymentStepEl.hidden = true;
  checkoutTitleEl.textContent = 'Finalizar pedido';
}

document.querySelector('#checkout-btn').addEventListener('click', () => {
  const removed = pruneCart();
  if (removed.length) { renderCart(); toast('Um item ficou indisponível e saiu do carrinho. Confira antes de finalizar.', 4000); return; }
  if (!cart.length) return;
  resetCheckoutView();
  syncDelivery();
  // carrinho -> checkout substitui a entrada do histórico em vez de empilhar
  hideModal('#cart-modal');
  openModal('#checkout-modal', { replace: true, opener: cartFab });
});

function buildWhatsAppMessage(srv, cust) {
  const lines = [`*Novo pedido ${srv.public_code || srv.code}*`, ''];
  for (const i of srv.items) {
    let line = `• ${i.qty}x ${i.name}`;
    if (i.size) line += ` (${i.size})`;
    if (Array.isArray(i.extras) && i.extras.length) line += `\n   ${i.extras.join(', ')}`;
    if (Number.isInteger(i.unit_total_cents)) line += `\n   ${brl(i.unit_total_cents * i.qty)}`;
    lines.push(line);
  }
  lines.push('');
  if (Number.isInteger(srv.subtotal_cents)) lines.push(`Subtotal: ${brl(srv.subtotal_cents)}`);
  if (Number.isInteger(srv.delivery_fee_cents)) lines.push(`Frete: ${brl(srv.delivery_fee_cents)}`);
  if (srv.discount_cents > 0) lines.push(`Desconto (pontos): − ${brl(srv.discount_cents)}`);
  lines.push(`*Total: ${brl(srv.total_cents)}*`);
  lines.push('', `Nome: ${cust.customer_name}`);
  lines.push(`WhatsApp: ${cust.customer_phone}`);
  if (srv.delivery_method === 'pickup') lines.push(`Retirada em: ${STORE_ADDRESS}`);
  else lines.push(`Entrega: ${srv.address || cust.address || 'a combinar'}`);
  lines.push(`Pagamento: ${cust.payment_choice === 'card' ? 'Cartão de crédito ou débito' : 'Pix'}`);
  if (cust.notes) lines.push(`Obs.: ${cust.notes}`);
  if (srv.tracking_token) lines.push(`Acompanhar: ${location.origin}${trackUrl(srv.tracking_token)}`);
  return lines.join('\n');
}

// Erros do POST /api/order, em português claro (contrato seção 3)
function handleOrderError(status, d) {
  const code = d && d.code;
  if (code === 'store_closed') { setStoreState(d.store || { open: false, reason: null, message: d.error }); toast('A loja está fechada agora. ' + closedMessage(store || {}), 7000); return; }
  if (code === 'login_required') { account = null; usePoints = 0; renderAccount(); renderPoints(); renderSummary(); toast('Sua sessão acabou. Entre na sua conta para usar pontos, ou faça o pedido sem pontos.', 6000); return; }
  if (code === 'insufficient_points') { usePoints = 0; loadAccount(); toast('Você não tem pontos suficientes. Atualizamos seu saldo; confira e tente de novo.', 6000); return; }
  if (code === 'points_locked') { usePoints = 0; loadAccount(); toast('Seus pontos estão bloqueados por segurança após a recuperação da conta. Faça o pedido sem usar pontos.', 6000); return; }
  // F5 (A1-05): origem/tipo barrados pelo servidor. O site manda os dois certos; isso só acontece com página antiga, extensão ou proxy.
  if (code === 'forbidden_origin' || status === 403 && !code) { toast('Não conseguimos confirmar de onde veio o pedido. Atualize a página e tente de novo. Seu carrinho foi mantido.', 7000); return; }
  if (code === 'unsupported_type' || status === 415) { toast('O pedido chegou num formato que não reconhecemos. Atualize a página e tente de novo. Seu carrinho foi mantido.', 7000); return; }
  if (status === 429) { toast('Recebemos muitos pedidos seguidos desta conexão ou deste telefone. Aguarde uns 10 minutos e tente de novo, ou chame a gente no WhatsApp.', 8000); return; }
  // Regra de pontos pode ter mudado depois que a página abriu: recarrega a regra e mostra a mensagem do servidor.
  if (code === 'points_disabled') { usePoints = 0; refreshPointsRules(); toast('O programa de pontos está pausado no momento. Faça o pedido sem usar pontos.', 6000); return; }
  if (code === 'invalid_block') { usePoints = 0; refreshPointsRules(); toast((d && d.error) || 'Quantidade de pontos fora da regra. Escolha de novo.', 6000); return; }
  if (code === 'invalid_points') { toast('Quantidade de pontos inválida. Escolha de novo.', 5000); return; }
  if (code === 'discount_too_big') { refreshPointsRules(); toast('O desconto não pode ser maior que o valor dos itens. Use menos pontos.', 5000); return; }
  if (['out_of_area', 'cep_not_found', 'address_not_found', 'origin_unavailable', 'invalid_cep', 'invalid_address'].includes(code)) {
    quote = null;
    const msg = quoteErrorText(status, d);
    showQuote(msg, 'warn');
    renderPoints(); renderSummary();
    toast(msg, 6000);
    return;
  }
  toast(typeof (d && d.error) === 'string' && d.error ? d.error : 'Não foi possível enviar o pedido. Tente de novo.', 5000);
}

checkoutFormEl.addEventListener('submit', async e => {
  e.preventDefault();
  if (submitting) return;
  if (store && !store.open) { toast(closedMessage(store), 6000); return; }
  const removed = pruneCart();
  if (removed.length) { renderSummary(); toast('Um item ficou indisponível e saiu do carrinho. Confira o resumo.', 5000); return; }
  if (!cart.length) { toast('Seu carrinho está vazio.'); return; }
  const form = new FormData(e.target);
  const pickup = form.get('delivery') === 'pickup';
  submitting = true;
  syncSubmitState();
  submitBtnEl.textContent = 'Enviando...';
  try {
    if (!pickup && !(quote && quote.key === quoteKey())) { // sem frete calculado para este endereço: calcula e deixa a pessoa conferir
      const q = await runQuote();
      if (q) toast('Confira o frete no resumo e toque em Enviar pedido de novo.', 5000);
      return;
    }
    const order = {
      customer_name: String(form.get('name') || '').trim(),
      customer_phone: String(form.get('phone') || '').trim(),
      delivery_method: pickup ? 'pickup' : 'delivery',
      notes: String(form.get('notes') || '').trim(),
      payment_choice: form.get('payment_choice') === 'card' ? 'card' : 'pix',
      // só ids e quantidades: o servidor calcula nomes, preços, frete e desconto
      items: cart.map(i => ({ product_id: i.productId, size_id: i.size ? i.size.id : null, extras: i.extras.map(x => ({ id: x.id, qty: x.qty })), qty: i.qty }))
    };
    if (!pickup) {
      order.cep = digitsOf(form.get('cep'));
      order.address = fullAddress();
      order.address_number = String(form.get('address_number') || '').trim();
    } else {
      order.address = '';
    }
    if (usePoints > 0) order.use_points = usePoints;
    const res = await fetch('/api/order', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order)
    });
    let data = {};
    try { data = await res.json(); } catch { /* corpo não-JSON */ }
    if (!res.ok) { handleOrderError(res.status, data); return; } // carrinho preservado
    const srv = { ...data, items: Array.isArray(data.items) ? data.items : [] };
    const whatsappText = buildWhatsAppMessage(srv, order);
    const payment = normalizePayment(data.payment);
    const summary = { subtotal: srv.subtotal_cents, fee: srv.delivery_fee_cents, pickup: srv.delivery_method === 'pickup', discount: srv.discount_cents || 0, total: srv.total_cents };
    // pedido criado com sucesso: só agora o carrinho é limpo (cópia guardada para "refazer")
    lastCartCopy = cart.map(i => ({ ...i }));
    cart = [];
    save();
    usePoints = 0;
    quote = null;
    addRecent({ public_code: data.public_code, code: data.code, token: data.tracking_token });
    const card = payment && payment.type === 'card';
    saveLastOrder({ public_code: data.public_code, token: data.tracking_token, status: payment ? 'awaiting_payment' : 'registered', summary, payment_choice: order.payment_choice,
      ...(card ? { paymentUrl: payment.url, whatsappText } : {}) });
    renderOrderStep({ code: data.code, publicCode: data.public_code, token: data.tracking_token, whatsappText, payment, summary });
    toast(payment ? 'Pedido registrado! Agora é só pagar.' : 'Pedido registrado!');
    if (account) loadAccount(); // saldo mudou (pontos reservados)
  } catch {
    toast('Sem conexão com o servidor. Confira a internet e tente de novo.', 4000);
  } finally {
    submitting = false;
    syncSubmitState();
    submitBtnEl.textContent = 'Enviar pedido';
  }
});

/* ---------- Retorno do Mercado Pago: ?pagamento=ok|erro|pendente ---------- */
function handlePaymentReturn() {
  const params = new URLSearchParams(location.search);
  const status = params.get('pagamento');
  if (!status) return;
  params.delete('pagamento');
  const qs = params.toString();
  history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  const msgs = {
    ok: 'Voltamos do pagamento. Estamos confirmando com o Mercado Pago ✓',
    erro: 'O pagamento não foi concluído. Você pode tentar novamente.',
    pendente: 'Pagamento pendente. Avisaremos quando for confirmado.'
  };
  if (!msgs[status]) return;
  toast(msgs[status], 6000);
  const last = readLastOrder();
  if (!last) return;
  const texts = {
    ok: 'Estamos confirmando o seu pagamento. Esta tela atualiza sozinha e mostra o botão do WhatsApp assim que for aprovado.',
    pendente: 'Pagamento pendente. Esta tela atualiza sozinha quando for aprovado. Você também pode acompanhar pelo link do pedido.',
    erro: 'O pagamento não foi concluído. Tente pagar de novo pelo botão abaixo.'
  };
  openModal('#checkout-modal', { opener: document.body });
  const retryPay = status === 'erro' && typeof last.paymentUrl === 'string' ? normalizePayment({ type: 'card', url: last.paymentUrl }) : null;
  renderOrderStep({ publicCode: last.public_code, token: last.token, whatsappText: typeof last.whatsappText === 'string' ? last.whatsappText : '', payment: retryPay, summary: last.summary },
    { title: status === 'erro' ? 'Pagamento não concluído' : 'Pedido registrado', text: texts[status], watchNow: status !== 'erro' });
}

payEls.wa.addEventListener('click', forgetWhatsAppText); // texto enviado: não fica mais guardado no aparelho
readLastOrder(); // apaga o último pedido vencido (24 h) ou no formato antigo
syncDelivery();
renderCartFab();
renderAccount();
loadAccount();
handlePaymentReturn();

/* L6: voltar da página de entrar/criar conta (/?checkout=1) reabre o checkout com o carrinho que ficou no aparelho. */
(function reopenCheckout() {
  const params = new URLSearchParams(location.search);
  if (params.get('checkout') !== '1') return;
  params.delete('checkout');
  const qs = params.toString();
  history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  if (!cart.length || modalStack.length) return;
  resetCheckoutView();
  syncDelivery();
  openModal('#checkout-modal', { replace: true, opener: cartFab });
})();
