const statusEl = document.querySelector('#status');
const menuEl = document.querySelector('#menu');
const catsEl = document.querySelector('#categorias');
const cartFab = document.querySelector('#cart-fab');
const cartFabCount = document.querySelector('#cart-fab-count');
const catFab = document.querySelector('#cat-fab');
const catList = document.querySelector('#cat-list');
const toastEl = document.createElement('div');
toastEl.id = 'toast';
document.body.appendChild(toastEl);

// Vêm de /config.js (futuramente, do painel admin)
const WHATSAPP_NUMBER = String(window.WHATSAPP_NUMBER || '').replace(/\D/g, '');
const STORE_ADDRESS = String(window.STORE_ADDRESS || '').trim();
const CART_KEY = 'dg-cart';
const LAST_ORDER_KEY = 'dg-last-order';
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');
const MODAL_MS = 300; // um pouco acima da transição de 280ms do CSS

let menu = [];
let activeProduct = null;
let sel = { size: null, extras: {} };
let pmGroups = []; // grupos de escolha do produto aberto: { id, label, min, max, opts[] }

const brl = cents => 'R$ ' + (cents / 100).toFixed(2).replace('.', ',');
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
  if (opts.replace) history.replaceState({ dgModal: id }, ''); else history.pushState({ dgModal: id }, '');
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
  if (history.state && history.state.dgModal === id) {
    closing.add(id);
    history.back();
    // rede de segurança: se o popstate não chegar, fecha mesmo assim
    setTimeout(() => { if (closing.has(id)) hideModal(id); }, 800);
  } else {
    hideModal(id);
  }
}

window.addEventListener('popstate', () => {
  const want = history.state && history.state.dgModal;
  while (modalStack.length && modalStack[modalStack.length - 1] !== want) hideModal(modalStack[modalStack.length - 1]);
  // "avançar" para uma entrada de modal que não está aberto: neutraliza a entrada
  if (want && !modalStack.includes(want)) history.replaceState(null, '');
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
  renderCats();
  renderMenu();
  observeCats();
}).catch(() => { statusEl.textContent = 'Cardápio indisponível no momento.'; });

/* ---------- Navegação entre categorias ---------- */
let activeCat = null;
let navLockUntil = 0;
const scrollBehavior = () => (REDUCED.matches ? 'auto' : 'smooth');

function renderCats() {
  catsEl.innerHTML = menu.map(c =>
    `<a class="cat-chip" href="#cat-${c.id}" data-cat="${c.id}">${esc(c.name)}</a>`).join('');
  catList.innerHTML = menu.map(c =>
    `<li><a class="cat-item" href="#cat-${c.id}" data-cat="${c.id}"><span>${esc(c.name)}</span><span class="cat-count">${c.products.length}</span></a></li>`).join('');
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
      <h2>${esc(c.name)}</h2>
      <div class="grid">${c.products.map(p => `
        <button type="button" class="card" data-pid="${p.id}">
          ${p.imagePath ? `<img src="${esc(encodeURI(p.imagePath))}" alt="" width="88" height="88" loading="lazy" decoding="async">` : '<span class="placeholder" aria-hidden="true">🍬</span>'}
          <span class="body">
            <span class="name">${esc(p.name)}</span>
            ${p.description ? `<span class="desc">${esc(p.description)}</span>` : ''}
            <span class="price-row">
              <span class="price">${p.priceCents != null ? (p.complements?.some(x => x.kind === 'size') ? `<span class="from">a partir de</span> ${brl(p.priceCents)}` : brl(p.priceCents)) : 'Consulte'}</span>
            </span>
          </span>
          <span class="add-hint" aria-hidden="true">+</span>
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
  const comps = activeProduct.complements || [];
  const sizes = comps.filter(c => c.kind === 'size');
  const extras = comps.filter(c => c.kind !== 'size');
  sel = { size: sizes.length ? sizes[0] : null, extras: {} };
  // Grupos de escolha: a API pode não enviar `groups` (ainda); sem eles tudo segue como complemento com +/−.
  pmGroups = (Array.isArray(activeProduct.groups) ? activeProduct.groups : []).map(g => {
    const opts = extras.filter(c => c.groupId != null && Number(c.groupId) === Number(g.id));
    const max = Number(g.maxChoices) > 0 ? Math.min(Number(g.maxChoices), opts.length) : opts.length;
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
        ${sizes.map((s, i) => `
          <div class="comp-item">
            <span class="comp-left">${esc(s.name)}${s.priceCents ? `<span class="comp-price">+ ${brl(s.priceCents)}</span>` : ''}</span>
            <span class="comp-qty"><button type="button" data-size="${s.id}" aria-label="Escolher ${esc(s.name)}" ${i === 0 ? 'disabled' : ''}>${i === 0 ? '✓' : '+'}</button></span>
          </div>`).join('')}
      </div>` : ''}
    ${pmGroups.map(g => `
      <div class="comp-group choice-group" data-gid="${g.id}" role="group" aria-labelledby="gt-${g.id}">
        <div class="group-head"><h4 id="gt-${g.id}">${esc(g.label)}</h4><span class="group-count" data-gcount aria-live="polite">0/${g.max}</span></div>
        <p class="hint">${g.min ? `Escolha ${g.min === g.max ? g.max : `de ${g.min} a ${g.max}`}` : `Escolha até ${g.max}`}</p>
        <p class="group-error" data-gerr role="alert" hidden></p>
        <div class="chips">
          ${g.opts.map(o => `
            <label class="chip">
              <input type="checkbox" data-opt="${o.id}" data-opt-group="${g.id}" aria-disabled="false">
              <span class="chip-text"><span class="chip-name">${esc(stripPrefix(o.name))}</span>${priceTag(o)}</span>
            </label>`).join('')}
        </div>
      </div>`).join('')}
    ${loose.length ? `
      <div class="comp-group">
        <h4>${pmGroups.length ? 'Outros complementos' : 'Complementos'}</h4>
        <p class="hint">Opcional — até ${Math.max(...loose.map(x => x.maxQuantity))} por item</p>
        ${loose.map(x => `
          <div class="comp-item">
            <span class="comp-left">${esc(stripPrefix(x.name))}${priceTag(x)}</span>
            <span class="comp-qty">
              <button type="button" data-minus="${x.id}" aria-label="Menos ${esc(x.name)}" disabled>−</button>
              <span class="n" data-count="${x.id}">0</span>
              <button type="button" data-plus="${x.id}" aria-label="Mais ${esc(x.name)}">+</button>
            </span>
          </div>`).join('')}
      </div>` : ''}
    <div class="pm-total-row"><span>Total</span><span id="pm-total"></span></div>
    <button type="button" class="button primary full" id="pm-add">Adicionar ao carrinho</button>`;
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
    sel.size = comps.find(c => c.id === Number(sizeBtn.dataset.size));
    document.querySelectorAll('[data-size]').forEach(b => { b.textContent = b === sizeBtn ? '✓' : '+'; b.disabled = b === sizeBtn; });
    updatePmTotal();
    return;
  }
  const opt = e.target.closest('[data-opt]');
  if (opt) {
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

cartFab.addEventListener('click', () => { renderCart(); openModal('#cart-modal', { opener: cartFab }); });

function renderCart() {
  const itemsEl = document.querySelector('#cart-items');
  if (!cart.length) {
    itemsEl.innerHTML = '<div class="cart-empty">Seu carrinho está vazio 🍬</div>';
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
        <div class="ci-name">${esc(i.name)}${i.qty > 1 ? ` × ${i.qty}` : ''}</div>
        ${comps ? `<div class="ci-comps">${comps}</div>` : ''}
      </div>
      <span class="ci-price">${brl(i.unitTotal * i.qty)}</span>
      <button type="button" class="ci-remove" data-rm="${idx}" aria-label="Remover ${esc(i.name)}">×</button>
    </div>`;
  }).join('');
  document.querySelector('#cart-total').innerHTML = `<span>Total</span><span>${brl(cartTotal())}</span>`;
}

document.addEventListener('click', e => {
  const rm = e.target.closest('[data-rm]');
  if (rm) { cart.splice(Number(rm.dataset.rm), 1); save(); renderCart(); }
});

/* ---------- Checkout ---------- */
const checkoutFormEl = document.querySelector('#checkout-form');
const paymentStepEl = document.querySelector('#payment-step');
const checkoutTitleEl = document.querySelector('#checkout-title');
const addressFieldEl = document.querySelector('#address-field');
const addressInputEl = addressFieldEl.querySelector('input');
const pickupInfoEl = document.querySelector('#pickup-info');
document.querySelector('#store-address').textContent = STORE_ADDRESS;

// Retirada: some o endereço do cliente (sem required nem envio) e mostra o endereço da loja.
function syncDelivery() {
  const pickup = checkoutFormEl.elements.delivery.value === 'pickup';
  addressFieldEl.hidden = pickup;
  addressInputEl.required = !pickup;
  addressInputEl.disabled = pickup;
  pickupInfoEl.hidden = !pickup;
}
checkoutFormEl.addEventListener('change', e => { if (e.target.name === 'delivery') syncDelivery(); });
syncDelivery();

/* ---------- Etapa pós-pedido: cartão (link), Pix (QR no site) ou só WhatsApp ----------
   Links são <a> reais (toque direto do usuário), sem window.open depois de await. */
const payEls = {
  codeRow: document.querySelector('#payment-code-row'),
  code: document.querySelector('#payment-code'),
  text: document.querySelector('#payment-text'),
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
  wa: document.querySelector('#pay-wa')
};
const PIX_DEFAULT_MS = 30 * 60 * 1000;
const POLL_MS = 5000;
const watch = { token: 0, poll: null, tick: null, pollNow: null };
let lastCartCopy = null; // cópia do carrinho do último pedido, para "refazer" se o Pix expirar ou falhar
let copyTimer = null;

// Para contagem e polling (fechar o modal, expirar, aprovar, refazer). O token invalida respostas em voo.
function stopPayWatch() {
  watch.token++;
  clearInterval(watch.poll);
  clearInterval(watch.tick);
  watch.poll = watch.tick = watch.pollNow = null;
}
modalHooks['#checkout-modal'] = { open() {}, close: stopPayWatch };

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

function setWhatsApp(text, primary) {
  const ok = !!WHATSAPP_NUMBER && !!text;
  payEls.wa.hidden = !ok;
  if (ok) payEls.wa.href = waLink(text);
  payEls.wa.classList.toggle('primary', primary);
  payEls.wa.classList.toggle('secondary', !primary);
}
function setPayStatus(msg, kind) {
  payEls.status.textContent = msg;
  payEls.status.className = 'pay-status' + (kind ? ' ' + kind : '');
  payEls.status.hidden = !msg;
}

function renderOrderStep(order, { title, text } = {}) {
  stopPayWatch();
  const pay = order.payment;
  const type = pay ? pay.type : null;
  payEls.code.textContent = order.code || '';
  payEls.codeRow.hidden = !order.code;
  setPayStatus('', '');
  payEls.pixBox.hidden = type !== 'pix';
  payEls.card.hidden = payEls.support.hidden = type !== 'card';
  payEls.retry.hidden = true;
  payEls.copyStatus.textContent = '';
  payEls.timer.textContent = '';
  let msg = text;
  if (msg == null) {
    msg = type === 'pix' ? 'Pedido registrado! Pague com o Pix abaixo e depois avise a Gigi pelo WhatsApp.'
      : type === 'card' ? 'Pedido registrado! Pague com cartão e depois envie o pedido pelo WhatsApp para a Gigi receber o aviso.'
      : 'Não foi possível gerar o pagamento agora. Seu pedido foi registrado: envie pelo WhatsApp para a Gigi combinar o pagamento.';
  }
  payEls.text.textContent = msg;
  if (type === 'card') payEls.card.href = pay.url;
  if (type === 'pix') {
    payEls.pixCode.value = pay.qr_code;
    if (pay.qr_code_base64) { payEls.qr.src = 'data:image/png;base64,' + pay.qr_code_base64; payEls.qr.hidden = false; }
    else { payEls.qr.removeAttribute('src'); payEls.qr.hidden = true; }
  }
  setWhatsApp(order.whatsappText, !pay);
  checkoutFormEl.hidden = true;
  paymentStepEl.hidden = false;
  checkoutTitleEl.textContent = title || (type === 'pix' ? 'Pague com Pix' : type === 'card' ? 'Pagamento' : 'Pedido registrado');
  const panel = paymentStepEl.closest('.modal-panel');
  if (panel) panel.scrollTop = 0;
  (type === 'pix' ? payEls.copyBtn : type === 'card' ? payEls.card : payEls.wa).focus({ preventScroll: true });
  if (type === 'pix') startPixWatch(order, pay);
}

function startPixWatch(order, pay) {
  const token = watch.token;
  let expiresAt = Date.parse(pay.expires_at);
  if (!Number.isFinite(expiresAt)) expiresAt = Date.now() + PIX_DEFAULT_MS;
  const tick = () => {
    if (token !== watch.token) return;
    const left = expiresAt - Date.now();
    if (left <= 0) { onPixEnded('O Pix expirou (valia 30 minutos). Nenhum valor foi cobrado. Você pode refazer o pedido.'); return; }
    const s = Math.ceil(left / 1000);
    payEls.timer.textContent = `O Pix expira em ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  tick();
  if (token !== watch.token) return; // já expirou ao abrir
  watch.tick = setInterval(tick, 1000);
  let busy = false;
  const poll = async () => {
    if (busy || token !== watch.token) return;
    busy = true;
    try {
      const r = await fetch('/api/order-status?code=' + encodeURIComponent(order.code), { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      if (token !== watch.token) return;
      if (d.payment_status === 'approved') onPixApproved(order);
      else if (d.payment_status === 'rejected') onPixEnded('O pagamento foi recusado. Você pode refazer o pedido.');
      else if (d.payment_status === 'cancelled') onPixEnded('O pagamento foi cancelado. Você pode refazer o pedido.');
    } catch { /* sem rede: tenta de novo no próximo ciclo */ } finally { busy = false; }
  };
  watch.pollNow = poll;
  watch.poll = setInterval(poll, POLL_MS);
}

function onPixApproved(order) {
  stopPayWatch();
  payEls.pixBox.hidden = true;
  payEls.retry.hidden = true;
  setPayStatus('Pagamento confirmado!', 'ok');
  payEls.text.textContent = 'Agora envie o pedido pelo WhatsApp para a Gigi receber o aviso.';
  checkoutTitleEl.textContent = 'Pagamento confirmado';
  const text = order.whatsappText + '\nPagamento Pix confirmado ✓';
  setWhatsApp(text, true);
  const last = readStore(LAST_ORDER_KEY);
  if (last && last.code === order.code) writeStore(LAST_ORDER_KEY, { ...last, whatsappText: text });
  payEls.wa.focus({ preventScroll: true });
  toast('Pagamento confirmado! ✓', 3000);
}

function onPixEnded(msg) {
  stopPayWatch();
  payEls.pixBox.hidden = true;
  setPayStatus(msg, 'warn');
  payEls.text.textContent = 'Se já pagou, fale com a Gigi pelo WhatsApp informando o número do pedido.';
  checkoutTitleEl.textContent = 'Pix não concluído';
  payEls.retry.hidden = !(lastCartCopy && lastCartCopy.length);
  (payEls.retry.hidden ? payEls.wa : payEls.retry).focus({ preventScroll: true });
}

// Refazer: devolve os itens ao carrinho e volta ao formulário
payEls.retry.addEventListener('click', () => {
  if (!lastCartCopy || !lastCartCopy.length) return;
  cart = lastCartCopy.map(i => ({ ...i }));
  save();
  resetCheckoutView();
  document.querySelector('#payment-summary').innerHTML = `<span>Total</span><span>${brl(cartTotal())}</span>`;
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
  resetCheckoutView();
  syncDelivery();
  document.querySelector('#payment-summary').innerHTML = `<span>Total</span><span>${brl(cartTotal())}</span>`;
  // carrinho -> checkout substitui a entrada do histórico em vez de empilhar
  hideModal('#cart-modal');
  openModal('#checkout-modal', { replace: true, opener: cartFab });
});

function buildWhatsAppMessage(srv, cust) {
  const lines = [`*Novo pedido ${srv.code}*`, ''];
  for (const i of srv.items) {
    let line = `• ${i.qty}x ${i.name}`;
    if (i.size) line += ` (${i.size})`;
    if (Array.isArray(i.extras) && i.extras.length) line += `\n   ${i.extras.join(', ')}`;
    if (Number.isInteger(i.unit_total_cents)) line += `\n   ${brl(i.unit_total_cents * i.qty)}`;
    lines.push(line);
  }
  lines.push('', `*Total: ${brl(srv.total_cents)}*`);
  lines.push('', `Nome: ${cust.customer_name}`);
  lines.push(`WhatsApp: ${cust.customer_phone}`);
  if (srv.delivery_method === 'pickup') lines.push(`Retirada em: ${STORE_ADDRESS}`);
  else lines.push(`Entrega: ${srv.address || cust.address || 'a combinar'}`);
  lines.push(`Pagamento: ${cust.payment_choice === 'card' ? 'Cartão de crédito ou débito' : 'Pix'}`);
  if (cust.notes) lines.push(`Obs.: ${cust.notes}`);
  return lines.join('\n');
}

checkoutFormEl.addEventListener('submit', async e => {
  e.preventDefault();
  if (!cart.length) { toast('Seu carrinho está vazio.'); return; }
  const form = new FormData(e.target);
  const pickup = form.get('delivery') === 'pickup';
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Enviando...';
  try {
    const order = {
      customer_name: String(form.get('name') || '').trim(),
      customer_phone: String(form.get('phone') || '').trim(),
      delivery_method: pickup ? 'pickup' : 'delivery',
      address: pickup ? '' : String(form.get('address') || '').trim(),
      notes: String(form.get('notes') || '').trim(),
      payment_choice: form.get('payment_choice') === 'card' ? 'card' : 'pix',
      // só ids e quantidades: o servidor calcula nomes e preços
      items: cart.map(i => ({ product_id: i.productId, size_id: i.size ? i.size.id : null, extras: i.extras.map(x => ({ id: x.id, qty: x.qty })), qty: i.qty }))
    };
    const res = await fetch('/api/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order)
    });
    let data = {};
    try { data = await res.json(); } catch { /* corpo não-JSON */ }
    if (!res.ok) {
      toast(typeof data.error === 'string' && data.error ? data.error : 'Não foi possível enviar o pedido. Tente de novo.', 5000);
      return; // carrinho preservado
    }
    const srv = { ...data, items: Array.isArray(data.items) ? data.items : [] };
    const whatsappText = buildWhatsAppMessage(srv, order);
    const payment = normalizePayment(data.payment);
    // pedido criado com sucesso: só agora o carrinho é limpo (cópia guardada para "refazer")
    lastCartCopy = cart.map(i => ({ ...i }));
    cart = [];
    save();
    writeStore(LAST_ORDER_KEY, { code: data.code, whatsappText, payment_choice: order.payment_choice, paymentUrl: payment && payment.type === 'card' ? payment.url : null });
    renderOrderStep({ code: data.code, whatsappText, payment });
    toast(payment ? 'Pedido registrado! Agora é só pagar' : 'Pedido registrado! Envie pelo WhatsApp');
  } catch {
    toast('Sem conexão com o servidor. Confira a internet e tente de novo.', 4000);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Enviar pedido';
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
    ok: 'Pagamento aprovado! Obrigada pelo pedido ✓',
    erro: 'O pagamento não foi concluído. Você pode tentar novamente.',
    pendente: 'Pagamento pendente. Avisaremos quando for confirmado.'
  };
  if (!msgs[status]) return;
  toast(msgs[status], 6000);
  const last = readStore(LAST_ORDER_KEY);
  if (!last || typeof last.whatsappText !== 'string') return;
  const texts = {
    ok: 'Pagamento aprovado! Envie o pedido pelo WhatsApp para a Gigi receber o aviso.',
    pendente: 'Pagamento pendente. Envie o pedido pelo WhatsApp para a Gigi acompanhar.',
    erro: 'O pagamento não foi concluído. Tente pagar de novo ou envie o pedido pelo WhatsApp.'
  };
  openModal('#checkout-modal', { opener: document.body });
  const retryPay = status === 'erro' && typeof last.paymentUrl === 'string' ? normalizePayment({ type: 'card', url: last.paymentUrl }) : null;
  renderOrderStep({ code: last.code, whatsappText: last.whatsappText, payment: retryPay }, { title: status === 'erro' ? 'Pagamento não concluído' : 'Pedido registrado', text: texts[status] });
  if (status === 'erro') payEls.wa.classList.toggle('primary', !retryPay);
}

renderCartFab();
handlePaymentReturn();
