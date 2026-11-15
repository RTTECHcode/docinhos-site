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
  if (id === '#checkout-modal' && pixPending() && !confirmPixClose()) return; // v4 U-01
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
  // v4 U-01: botão voltar com o Pix ainda em aberto pergunta antes; se a pessoa ficar, devolve a entrada do modal ao histórico.
  const topId = modalStack[modalStack.length - 1];
  if (topId === '#checkout-modal' && !closing.has(topId) && (modalEl(topId)._seq || 0) > wantSeq && pixPending() && !confirmPixClose()) {
    history.pushState({ dgModal: topId, dgSeq: modalEl(topId)._seq }, '');
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
  setClubInfo(data.club);
  setEta(data.delivery_eta_min, data.delivery_eta_max);
  setScheduling(data.scheduling);
  setShipping(data.shipping);
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
  let imgN = 0; // P-06: as primeiras fotos (acima da dobra) carregam já; as outras, sob demanda
  menuEl.innerHTML = menu.map(c => `
    <section class="category" id="cat-${c.id}">
      <h2>${brigIcon(c)}${esc(c.name)}</h2>
      <div class="grid">${c.products.map(p => `
        <button type="button" class="card${p.unavailable ? ' is-unavailable' : ''}${p.paused ? ' is-paused' : ''}" ${p.unavailable && !p.paused ? 'disabled aria-disabled="true"' : `data-pid="${p.id}"`}>
          ${p.imagePath ? `<img src="${esc(encodeURI(p.imagePath))}" alt="" width="104" height="104" ${imgN++ < 4 ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async">` : '<span class="placeholder" aria-hidden="true"></span>'}
          <span class="body">
            ${p.best_seller === true ? '<span class="best-tag">Mais pedido</span>' : ''}
            <span class="name">${esc(p.name)}</span>
            ${p.description ? `<span class="desc">${esc(p.description)}</span>` : ''}
            ${p.unavailable && !p.paused ? '<span class="unavail-tag">Indisponível no momento</span>' : ''}
            <span class="price-row">
              <span class="price">${p.priceCents != null ? (p.complements?.some(x => x.kind === 'size') ? `<span class="from">a partir de</span> ${brl(p.priceCents)}` : brl(p.priceCents)) : 'Consulte'}</span>
            </span>
          </span>
          ${p.unavailable ? '' : '<span class="add-hint" aria-hidden="true">+</span>'}
          ${p.paused ? '<span class="pause-clip"><span class="pause-band">Volto logo</span></span><span class="sr-only">Volto logo: indisponível agora. Toque para ver os detalhes.</span>' : ''}
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
  // v4 N2: "Volto logo" (paused) abre para ver detalhes e complementos, mas não entra no carrinho (o servidor também recusa).
  const paused = !!activeProduct.paused;
  if (activeProduct.unavailable && !paused) { activeProduct = null; toast('Este produto está indisponível no momento.'); return; }
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
    <div class="pm-photo">${activeProduct.imagePath ? `<img src="${esc(encodeURI(activeProduct.imagePath))}" alt="${esc(activeProduct.name)}" width="200" height="200" decoding="async">` : ''}</div>
    <h3 class="pm-name" id="pm-name">${esc(activeProduct.name)}</h3>
    ${activeProduct.best_seller === true ? '<p class="best-tag pm-best">Mais pedido</p>' : ''}
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
    ${paused ? '<p class="pm-paused-note" id="pm-paused-note">Volto logo! Este doce está pausado agora e não pode ser pedido. Dá uma olhada nos outros do cardápio.</p>' : ''}
    <button type="button" class="button primary full" id="pm-add" ${paused ? 'disabled aria-describedby="pm-paused-note"' : sizes.length && !firstSize ? 'disabled' : ''}>${paused ? 'Indisponível no momento' : 'Adicionar ao carrinho'}</button>`;
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
    if (closing.has('#product-modal') || activeProduct.paused) return; // toque duplo durante o fechamento não adiciona duas vezes
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
    renderInfo();
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
  renderInfo();
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
  if (store && Array.isArray(store.hours)) storeHours = store.hours;
  syncSubmitState();
  renderWhen();
  renderInfo();
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
  loadClub();
}

/* ---------- V5: botão flutuante "Acompanhe" ----------
   Aparece quando há pedido não concluído: dos recentes no aparelho (dg-recent-orders, status consultado em /api/order-status)
   ou do cliente logado (/api/customer?a=orders). Um pedido: abre direto o acompanhamento. Mais de um: lista. */
// v4 N1: situação do pedido pelo status_key do servidor; estes não aparecem mais no "Acompanhe".
const TRACK_ENDED = new Set(['completed', 'cancelled', 'payment_failed', 'refunded']);
const TRACK_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const TRACK_CHECKS = 5;      // no máximo 5 consultas de status por rodada (limite do servidor: 300 em 10 min por IP)
const TRACK_EVERY_MS = 60000;
let trackItems = [];
let trackSeq = 0;
let trackLastAt = 0;
const trackActive = o => !!o && typeof o.status_key === 'string' && !TRACK_ENDED.has(o.status_key);
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
    items.push({ code, href: '/pedido.html?t=' + encodeURIComponent(r.token), label: s.unknown ? '' : String(s.status_label || ''), sched: s.unknown ? '' : String(s.scheduled_label || ''), date: r.date });
  });
  for (const o of mine) {
    if (!trackActive(o) || !trackFresh(o.created_at) || (o.public_code && seen.has(o.public_code))) continue;
    const href = typeof o.tracking_url === 'string' && /^\/pedido\.html\?o=[0-9]{1,12}$/.test(o.tracking_url) ? o.tracking_url : '/conta/#pedidos'; // v4 F3
    items.push({ code: o.public_code || '', href, label: String(o.status_label || ''), sched: String(o.scheduled_label || ''), date: o.created_at });
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
    info.textContent = [it.label, it.sched, isNaN(d) ? '' : dateTimeFmt.format(d).replace(',', ' às')].filter(Boolean).join(' · ');
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
// Loja fechada: só dá para enviar pedido agendado (v4 N10).
function syncSubmitState() { submitBtnEl.disabled = submitting || (!!store && !store.open && !wantsSchedule()); }

// Retirada: some o endereço do cliente (sem required nem envio) e mostra o endereço da loja.
function syncDelivery() {
  const pickup = isPickup();
  addressFieldEl.hidden = pickup;
  addressFieldEl.querySelectorAll('input').forEach(i => { i.disabled = pickup; i.required = !pickup && !['complement', 'district', 'city'].includes(i.name); });
  pickupInfoEl.hidden = !pickup;
  renderPoints();
  renderSummary();
  renderInfo();
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
  for (const r of v.rewards || []) row(`Prêmio do Clube: ${r.qty}x ${rewardName(r)}`, `grátis (${ptsText(r.points)})`, 'sum-reward');
  if (v.discount > 0) row(v.couponCode ? `Cupom ${v.couponCode}` : 'Desconto', '− ' + brl(v.discount), 'sum-discount');
  row(v.fee == null ? 'Total (sem frete)' : 'Total', brl(v.total), 'sum-total');
}
function currentFee() { return isPickup() ? 0 : (quote && quote.key === quoteKey() ? quote.fee_cents : null); }
/* Subtotal: o calculado pelo servidor para este carrinho (prévia de pontos ou do cupom) assim que chega; antes disso, a soma dos
   preços do cardápio (que também vêm do servidor). O pedido é sempre recalculado no servidor. */
let serverSubtotal = null; // { key, cents }
const itemsPayload = () => cart.map(i => ({ product_id: i.productId, qty: i.qty, size_id: i.size ? i.size.id : null, extras: i.extras.map(x => ({ id: x.id, qty: x.qty })) }));
const cartSig = () => JSON.stringify(itemsPayload());
function setServerSubtotal(key, cents) { if (Number.isInteger(cents) && cents >= 0) serverSubtotal = { key, cents }; }
function currentSubtotal() { return serverSubtotal && serverSubtotal.key === cartSig() ? serverSubtotal.cents : cartTotal(); }
function currentDiscount() { return couponValid() ? coupon.discount_cents : 0; }
function renderSummary() {
  const sub = currentSubtotal();
  const fee = currentFee();
  const discount = currentDiscount();
  fillSummary(document.querySelector('#payment-summary'), { subtotal: sub, fee, pickup: isPickup(), discount, total: sub + (fee || 0) - discount, couponCode: discount > 0 ? coupon.code : null, rewards: chosenRewardList() });
}

/* v4 N3: Clube da Gigi. Os pontos viram prêmios (doces) escolhidos no checkout; o desconto em reais (use_points) acabou.
   Vitrine pública em /api/menu (club); saldo, bloqueio e quanto falta em /api/customer?a=club (só logado).
   Aqui só se monta a escolha: o servidor confere login, saldo, bloqueio e disponibilidade no pedido. */
let clubInfo = null;  // /api/menu club: { enabled, points_per_real, rewards[] }
let clubMine = null;  // ?a=club: { balance, reserved, locked_until, enabled, rewards[ + missing_points, can_redeem ] }
const chosenRewards = new Map(); // reward_id -> qty
function setClubInfo(c) {
  clubInfo = c && typeof c === 'object' && typeof c.enabled === 'boolean' && Array.isArray(c.rewards) ? c : null;
  renderPoints();
  renderSummary();
}
// Recarrega a vitrine (ex.: o pedido foi recusado porque um prêmio saiu do ar depois que a página abriu).
function refreshClubInfo() {
  fetch('/api/menu', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).then(d => { if (d) setClubInfo(d.club); }).catch(() => {});
}
async function loadClub() {
  if (!account) { clubMine = null; chosenRewards.clear(); renderPoints(); renderSummary(); return; }
  try {
    const r = await fetch('/api/customer?a=club', { credentials: 'same-origin', cache: 'no-store' });
    const d = r.ok ? await r.json() : null;
    clubMine = d && d.club && typeof d.club === 'object' && Array.isArray(d.club.rewards) ? d.club : null;
  } catch { clubMine = null; }
  pruneRewards();
  renderPoints();
  renderSummary();
  onRewardsChanged();
}
const clubLocked = () => !!(clubMine && clubMine.locked_until && Date.parse(clubMine.locked_until) > Date.now());
const rewardById = id => (clubMine && clubMine.rewards.find(r => r.id === id)) || null;
const rewardName = r => String(r.name || '') + (r.size_name ? ` (${r.size_name})` : '');
// Escolhas que não valem mais (prêmio saiu do ar, saldo não cobre, Clube pausado ou bloqueado) saem sozinhas.
function pruneRewards() {
  if (!account || !clubMine || !clubMine.enabled || clubLocked()) { chosenRewards.clear(); return; }
  let left = Math.max(0, Number(clubMine.balance) || 0);
  for (const [id, qty] of [...chosenRewards]) {
    const r = rewardById(id);
    const q = r && r.can_redeem ? Math.min(qty, r.max_per_order, Math.floor(left / r.points_cost)) : 0;
    if (q < 1) { chosenRewards.delete(id); continue; }
    chosenRewards.set(id, q);
    left -= q * r.points_cost;
  }
}
function chosenRewardList() {
  return [...chosenRewards].map(([id, qty]) => {
    const r = rewardById(id);
    return r ? { id, qty, name: r.name, size_name: r.size_name, points: r.points_cost * qty } : null;
  }).filter(Boolean);
}
const chosenPoints = () => chosenRewardList().reduce((s, r) => s + r.points, 0);
const rewardsPayload = () => [...chosenRewards].map(([reward_id, qty]) => ({ reward_id, qty }));
// Hook para quem depende dos prêmios escolhidos (o cupom confere de novo; v4 N6).
function onRewardsChanged() {}

/* L6: quantos pontos este pedido rende (POST /api/customer?a=points_preview). Só exibição: o servidor decide na hora do pedido. */
let pointsPreview = { points: 0, enabled: true };
let previewKey = '', previewSeq = 0, previewTimer = null;
const ptsText = n => `${n} ${n === 1 ? 'ponto' : 'pontos'}`;
function loadPointsPreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    if (!cart.length) { pointsPreview = { points: 0, enabled: true }; previewKey = ''; renderPoints(); return; }
    const key = cartSig();
    if (key === previewKey) return;
    const mine = ++previewSeq;
    try {
      const r = await fetch('/api/customer?a=points_preview', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: itemsPayload() }) });
      if (mine !== previewSeq) return;
      if (!r.ok) { pointsPreview = { points: 0, enabled: true }; previewKey = ''; renderPoints(); return; }
      const d = await r.json();
      previewKey = key;
      pointsPreview = { points: Number.isInteger(d.points) && d.points > 0 ? d.points : 0, enabled: d.enabled !== false };
      setServerSubtotal(key, d.subtotal_cents);
    } catch { if (mine !== previewSeq) return; pointsPreview = { points: 0, enabled: true }; previewKey = ''; }
    renderPoints();
    renderSummary();
  }, 150);
}

// Caixa do Clube no checkout. Visitante: convite para entrar e a vitrine. Logado: prêmios que dá para trocar, o que falta e avisos.
function renderPoints() {
  const box = pointsBoxEl;
  const focusId = box.contains(document.activeElement) ? document.activeElement.id : '';
  box.replaceChildren();
  const p = (text, cls) => { const e = document.createElement('p'); e.className = 'points-note' + (cls ? ' ' + cls : ''); e.textContent = text; return e; };
  const title = () => { const h = document.createElement('h3'); h.className = 'club-title'; h.textContent = 'Clube da Gigi'; return h; };
  const enabled = clubMine ? !!clubMine.enabled : !!(clubInfo && clubInfo.enabled);
  const earn = enabled && pointsPreview.enabled ? pointsPreview.points : 0;
  const earnNote = () => { if (earn > 0) box.append(p(account ? `Este pedido vai gerar ${ptsText(earn)}.` : `Entre na sua conta e ganhe ${ptsText(earn)} com este pedido.`, 'points-earn')); };
  if (!account) {
    chosenRewards.clear();
    const shown = clubInfo && clubInfo.enabled ? clubInfo.rewards.filter(r => r.available) : [];
    box.hidden = !enabled || (!earn && !shown.length);
    if (box.hidden) return;
    box.append(title());
    earnNote();
    if (shown.length) {
      const names = shown.slice(0, 3).map(r => `${rewardName(r)} por ${ptsText(r.points_cost)}`).join('; ');
      box.append(p(`No Clube, seus pontos viram doces: ${names}${shown.length > 3 ? ' e mais' : ''}.`));
    }
    const a = document.createElement('a');
    a.className = 'button secondary points-login';
    a.href = '/conta/?voltar=checkout#entrar';
    a.textContent = 'Entrar para juntar e trocar pontos';
    box.append(a);
    return;
  }
  if (!clubMine) { box.hidden = !enabled || !earn; if (!box.hidden) { box.append(title()); earnNote(); } return; }
  box.hidden = false;
  box.append(title());
  if (!clubMine.enabled) { box.append(p('O Clube está pausado no momento. Você pode comprar normalmente; seu saldo continua guardado.')); return; }
  const bal = Math.max(0, Number(clubMine.balance) || 0);
  if (clubLocked()) {
    box.append(p(`A troca de pontos está bloqueada por segurança até ${fmtWhen(clubMine.locked_until)} (depois da recuperação da conta). Você pode comprar normalmente, sem prêmio.`, 'warn'));
    earnNote();
    return;
  }
  if (!clubMine.rewards.length) { box.append(p(`Você tem ${ptsText(bal)}. Ainda não há prêmios para trocar.`)); earnNote(); return; }
  const fs = document.createElement('fieldset');
  fs.className = 'club-rewards';
  const lg = document.createElement('legend');
  lg.textContent = `Trocar pontos por um prêmio (você tem ${ptsText(bal)})`;
  fs.append(lg);
  const used = chosenPoints();
  for (const r of clubMine.rewards) {
    const qty = chosenRewards.get(r.id) || 0;
    const left = bal - used + qty * r.points_cost; // saldo livre para este prêmio
    const max = r.can_redeem ? Math.min(r.max_per_order, Math.floor(left / r.points_cost)) : 0;
    const row = document.createElement('div');
    row.className = 'club-reward';
    const nm = document.createElement('span'); nm.className = 'cr-name'; nm.textContent = rewardName(r);
    const cost = document.createElement('span'); cost.className = 'cr-cost'; cost.textContent = ptsText(r.points_cost) + (r.max_per_order > 1 ? ' cada' : '');
    const id = 'rw-' + r.id;
    if (max >= 1 || qty > 0) {
      if (r.max_per_order === 1) {
        const lb = document.createElement('label'); lb.className = 'cr-pick';
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.id = id; cb.checked = qty > 0; cb.dataset.reward = String(r.id);
        lb.append(cb, nm, cost);
        row.append(lb);
      } else {
        const lb = document.createElement('label'); lb.className = 'cr-label'; lb.htmlFor = id;
        lb.append(nm, cost);
        const sl = document.createElement('select'); sl.id = id; sl.dataset.reward = String(r.id);
        for (let n = 0; n <= Math.max(max, qty); n++) {
          const o = document.createElement('option');
          o.value = String(n);
          o.textContent = n === 0 ? 'Não trocar' : `${n} (${ptsText(n * r.points_cost)})`;
          sl.append(o);
        }
        sl.value = String(qty);
        row.append(lb, sl);
      }
    } else {
      row.classList.add('is-off');
      const miss = document.createElement('span'); miss.className = 'cr-miss';
      miss.textContent = !r.available ? 'Indisponível agora' : r.missing_points > 0 ? `Faltam ${ptsText(r.missing_points)}` : 'Seu saldo já está no outro prêmio';
      row.append(nm, cost, miss);
    }
    fs.append(row);
  }
  box.append(fs);
  box.append(p('O prêmio sai de graça. O pedido precisa ter pelo menos R$ 1,00 em outros produtos.', 'club-rule'));
  earnNote();
  if (focusId) { const el = document.getElementById(focusId); if (el) el.focus({ preventScroll: true }); }
}
pointsBoxEl.addEventListener('change', e => {
  const t = e.target;
  const id = Number(t && t.dataset.reward);
  if (!id) return;
  const n = t.type === 'checkbox' ? (t.checked ? 1 : 0) : Number(t.value) || 0;
  if (n > 0) chosenRewards.set(id, n); else chosenRewards.delete(id);
  pruneRewards();
  renderPoints();
  renderSummary();
  onRewardsChanged();
});

/* v4 N10: "Quando?" O quanto antes ou agendado (dia + janela de 30 min de /api/store?a=slots). O servidor confere janela,
   antecedência e vaga no pedido; com a loja fechada só dá para agendar. */
let scheduling = null;  // /api/menu scheduling: { enabled, min_lead_min, max_days, slot_minutes } (só quando ligado)
let deliveryEta = null; // { min, max } em minutos (/api/menu delivery_eta_min/max)
const whenFieldEl = document.querySelector('#when-field');
const whenSchedEl = document.querySelector('#when-schedule');
const whenDayEl = document.querySelector('#when-day');
const whenSlotEl = document.querySelector('#when-slot');
const whenStatusEl = document.querySelector('#when-status');
const whenAsapEl = document.querySelector('#when-asap');
const whenAsapTextEl = document.querySelector('#when-asap-text');
const SCHEDULE_ERRORS = new Set(['invalid_schedule', 'schedule_too_soon', 'schedule_too_far', 'schedule_closed', 'slot_full']);
const SLOT_CACHE_MS = 60000;
const slotCache = new Map(); // "AAAA-MM-DD|mode" -> { at, slots }
let slotSeq = 0;
const etaText = () => (deliveryEta ? `${deliveryEta.min} a ${deliveryEta.max} min` : '');
function setEta(min, max) {
  deliveryEta = Number.isInteger(min) && Number.isInteger(max) && min > 0 && max >= min ? { min, max } : null;
}
function setScheduling(s) {
  scheduling = s && typeof s === 'object' && s.enabled === true && Number.isInteger(s.max_days) ? s : null;
  renderWhen();
}
const wantsSchedule = () => !!scheduling && field('when').value === 'schedule';
const scheduledFor = () => (wantsSchedule() && whenSlotEl.value ? whenSlotEl.value : null);
function showWhenStatus(msg, kind) {
  whenStatusEl.textContent = msg;
  whenStatusEl.className = 'when-status' + (kind ? ' ' + kind : '');
  whenStatusEl.hidden = !msg;
}
const option = (value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = text; return o; };
// Dias de hoje até max_days (horário de São Paulo).
function fillDays() {
  const prev = whenDayEl.value;
  whenDayEl.replaceChildren();
  const fmt = new Intl.DateTimeFormat('pt-BR', { timeZone: SP_TZ, weekday: 'long', day: '2-digit', month: '2-digit' });
  const now = Date.now();
  for (let i = 0; i <= scheduling.max_days; i++) {
    const d = new Date(now + i * 864e5);
    const key = dayKey(d);
    const parts = Object.fromEntries(fmt.formatToParts(d).map(p => [p.type, p.value]));
    const dm = `${parts.day}/${parts.month}`;
    whenDayEl.append(option(key, i === 0 ? `Hoje (${dm})` : i === 1 ? `Amanhã (${dm})` : `${parts.weekday} (${dm})`));
  }
  if (prev && [...whenDayEl.options].some(o => o.value === prev)) whenDayEl.value = prev;
}
function renderWhen() {
  whenFieldEl.hidden = !scheduling;
  const closed = !!store && !store.open;
  whenAsapEl.disabled = closed && !!scheduling;
  const sub = document.createElement('small');
  sub.className = 'when-eta';
  sub.textContent = closed ? 'loja fechada agora' : etaText() ? `${isPickup() ? 'pronto em' : 'chega em'} ${etaText()}` : '';
  whenAsapTextEl.replaceChildren('O quanto antes', ...(sub.textContent ? [sub] : []));
  if (!scheduling) { field('when').value = 'asap'; whenSchedEl.hidden = true; syncSubmitState(); return; }
  if (closed && field('when').value !== 'schedule') field('when').value = 'schedule';
  const sched = field('when').value === 'schedule';
  whenSchedEl.hidden = !sched;
  if (sched && !whenDayEl.options.length) fillDays();
  syncSubmitState();
}
async function loadSlots(force) {
  if (!wantsSchedule()) return;
  if (!whenDayEl.options.length) fillDays();
  const date = whenDayEl.value;
  const mode = isPickup() ? 'pickup' : 'delivery';
  const ck = date + '|' + mode;
  const cached = slotCache.get(ck);
  if (!force && cached && Date.now() - cached.at < SLOT_CACHE_MS) { fillSlots(cached.slots); return; }
  const mine = ++slotSeq;
  whenSlotEl.disabled = true;
  whenSlotEl.replaceChildren(option('', 'Carregando horários...'));
  showWhenStatus('', '');
  try {
    const r = await fetch(`/api/store?a=slots&date=${encodeURIComponent(date)}&mode=${mode}`, { cache: 'no-store' });
    let d = {};
    try { d = await r.json(); } catch { /* corpo não-JSON */ }
    if (mine !== slotSeq) return;
    if (!r.ok) { fillSlots([]); showWhenStatus((d && d.error) || 'Não foi possível carregar os horários agora. Tente de novo.', 'warn'); return; }
    if (d.enabled === false) { setScheduling(null); toast('O agendamento foi desligado agora. Faça o pedido para o quanto antes.', 6000); return; }
    const slots = Array.isArray(d.slots) ? d.slots.filter(s => s && typeof s.start === 'string' && typeof s.label === 'string') : [];
    slotCache.set(ck, { at: Date.now(), slots });
    fillSlots(slots);
  } catch {
    if (mine === slotSeq) { fillSlots([]); showWhenStatus('Sem conexão para carregar os horários. Tente de novo.', 'warn'); }
  }
}
// Mostra as janelas livres; as lotadas aparecem desativadas (as que já passaram ou estão em cima da hora ficam de fora).
function fillSlots(slots) {
  const prev = whenSlotEl.value;
  whenSlotEl.replaceChildren();
  const free = slots.filter(s => s.available);
  if (!free.length) {
    whenSlotEl.append(option('', 'Sem horários livres'));
    whenSlotEl.disabled = true;
    showWhenStatus(slots.some(s => s.reason === 'full') ? 'Todos os horários deste dia lotaram. Escolha outro dia.' : 'Não há horários livres neste dia. Escolha outro dia.', 'warn');
    return;
  }
  whenSlotEl.append(option('', 'Escolha o horário'));
  for (const s of slots) {
    if (!s.available && s.reason !== 'full') continue;
    const o = option(s.start, s.available ? s.label : `${s.label} (lotado)`);
    o.disabled = !s.available;
    whenSlotEl.append(o);
  }
  whenSlotEl.disabled = false;
  if (prev && free.some(s => s.start === prev)) whenSlotEl.value = prev;
  showWhenStatus('', '');
}
// Texto curto do agendamento escolhido (antes da resposta do servidor), ex.: "Amanhã (15/11), 14:00-14:30".
function chosenWhenText() {
  if (!scheduledFor()) return '';
  const day = whenDayEl.selectedOptions[0], slot = whenSlotEl.selectedOptions[0];
  return day && slot ? `${day.textContent}, ${slot.textContent}` : '';
}
checkoutFormEl.addEventListener('change', e => {
  const n = e.target && e.target.name;
  if (n === 'when') { renderWhen(); loadSlots(); }
  else if (n === 'when_day') loadSlots();
  else if (n === 'delivery') { renderWhen(); loadSlots(); }
});

/* v4 N6: cupom de desconto. O servidor confere o código e calcula o desconto (POST /api/customer?a=coupon_check); aqui só se
   mostra o valor que ele devolveu. O link /?cupom=CODIGO guarda o código neste aparelho e ele é conferido ao abrir o checkout. */
const COUPON_KEY = 'dg-coupon';
const COUPON_RE = /^[A-Z0-9-]{3,20}$/;
const COUPON_DROP = new Set(['invalid_coupon', 'coupon_exhausted']); // códigos que não adianta guardar
const COUPON_ERRORS = new Set(['invalid_coupon', 'coupon_min_order', 'coupon_not_stackable', 'coupon_no_discount', 'coupon_exhausted', 'coupon_customer_limit']);
const couponInputEl = document.querySelector('#coupon-code');
const couponBtnEl = document.querySelector('#coupon-apply');
const couponRemoveEl = document.querySelector('#coupon-remove');
const couponStatusEl = document.querySelector('#coupon-status');
let coupon = null; // { code, key, discount_cents }
let couponSeq = 0, couponTimer = null;
const normCoupon = v => String(v || '').trim().toUpperCase();
const couponKeyNow = () => JSON.stringify([cartSig(), rewardsPayload()]);
const couponValid = () => !!coupon && coupon.key === couponKeyNow();
function savedCoupon() { const c = readStore(COUPON_KEY); const code = normCoupon(c && c.code); return COUPON_RE.test(code) ? code : ''; }
function showCouponStatus(msg, kind) {
  couponStatusEl.textContent = msg;
  couponStatusEl.className = 'coupon-status' + (kind ? ' ' + kind : '');
  couponStatusEl.hidden = !msg;
}
function syncCouponUi() { couponRemoveEl.hidden = !(coupon || couponInputEl.value.trim()); }
async function checkCoupon(raw) {
  const code = normCoupon(raw);
  clearTimeout(couponTimer);
  if (!code) { coupon = null; showCouponStatus('', ''); syncCouponUi(); renderSummary(); return false; }
  if (!COUPON_RE.test(code)) { coupon = null; showCouponStatus('Código inválido: use de 3 a 20 letras, números ou hífen.', 'warn'); syncCouponUi(); renderSummary(); return false; }
  if (!cart.length) return false;
  const key = couponKeyNow();
  const mine = ++couponSeq;
  couponBtnEl.disabled = true;
  showCouponStatus('Conferindo o cupom...', '');
  try {
    const body = { code, items: itemsPayload() };
    const rw = rewardsPayload();
    if (rw.length) body.rewards = rw;
    const r = await fetch('/api/customer?a=coupon_check', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let d = {};
    try { d = await r.json(); } catch { /* corpo não-JSON */ }
    if (mine !== couponSeq) return false;
    if (r.ok && d && d.ok && d.coupon && Number.isInteger(d.discount_cents)) {
      coupon = { code: normCoupon(d.coupon.code) || code, key, discount_cents: d.discount_cents };
      setServerSubtotal(JSON.parse(key)[0], d.subtotal_cents);
      writeStore(COUPON_KEY, { code: coupon.code });
      couponInputEl.value = coupon.code;
      showCouponStatus(`Cupom ${coupon.code} aplicado: − ${brl(d.discount_cents)} nos produtos.`, 'ok');
      syncCouponUi();
      renderSummary();
      return true;
    }
    coupon = null;
    if (COUPON_DROP.has(d && d.code)) removeStore(COUPON_KEY);
    showCouponStatus((d && typeof d.error === 'string' && d.error) || 'Não foi possível conferir o cupom agora. Tente de novo.', 'warn');
    syncCouponUi();
    renderSummary();
    return false;
  } catch {
    if (mine === couponSeq) showCouponStatus('Sem conexão para conferir o cupom. Tente de novo.', 'warn');
    return false;
  } finally {
    if (mine === couponSeq) couponBtnEl.disabled = false;
  }
}
// Carrinho ou prêmio mudou: o desconto precisa ser conferido de novo (o servidor recalcula).
function recheckCoupon(delay = 600) {
  clearTimeout(couponTimer);
  const code = coupon ? coupon.code : '';
  if (!code || couponValid() || !cart.length) return;
  showCouponStatus('Conferindo o cupom de novo...', '');
  couponTimer = setTimeout(() => checkCoupon(code), delay);
}
onRewardsChanged = () => recheckCoupon();
couponBtnEl.addEventListener('click', () => checkCoupon(couponInputEl.value));
couponInputEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); checkCoupon(couponInputEl.value); } });
couponInputEl.addEventListener('input', () => {
  if (coupon && normCoupon(couponInputEl.value) !== coupon.code) { coupon = null; showCouponStatus('', ''); renderSummary(); }
  syncCouponUi();
});
couponRemoveEl.addEventListener('click', () => {
  clearTimeout(couponTimer);
  couponSeq++;
  coupon = null;
  removeStore(COUPON_KEY);
  couponInputEl.value = '';
  couponBtnEl.disabled = false;
  showCouponStatus('Cupom removido.', '');
  syncCouponUi();
  renderSummary();
  couponInputEl.focus();
});
// Ao abrir o checkout: aplica o cupom guardado (link /?cupom=) ou confere de novo o que já estava aplicado.
function couponOnOpen() {
  if (coupon) { recheckCoupon(0); return; }
  const saved = savedCoupon();
  if (saved && !couponInputEl.value.trim()) couponInputEl.value = saved;
  syncCouponUi();
  if (saved && couponInputEl.value.trim() === saved) checkCoupon(saved);
}
// Link de campanha: /?cupom=CODIGO. Guarda no aparelho, tira da barra de endereço e avisa.
(function takeCouponFromUrl() {
  const params = new URLSearchParams(location.search);
  if (!params.has('cupom')) return;
  const code = normCoupon(params.get('cupom'));
  params.delete('cupom');
  const qs = params.toString();
  history.replaceState(history.state, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  if (!COUPON_RE.test(code)) { toast('Este link de cupom não é válido.', 4000); return; }
  writeStore(COUPON_KEY, { code });
  toast(`Cupom ${code} guardado! Ele é conferido quando você finalizar o pedido.`, 5000);
})();

/* ---------- v4 U-03/X-06, U-04, U-05, N11: loja fechada no topo, faixa de confiança, prazo e frete ----------
   Tudo vem do servidor (/api/menu e /api/store?a=state); aqui só se monta o texto. */
let shipping = null;  // { bands: [{ max_km, fee_cents }], maxKm, pickupFeeCents }
let storeHours = null; // [{ weekday, opens, closes }]
const closedStripEl = document.querySelector('#closed-strip');
const closedStripTextEl = document.querySelector('#closed-strip-text');
const closedStripBtnEl = document.querySelector('#closed-strip-btn');
const cartClosedEl = document.querySelector('#cart-closed');
const cartInfoEl = document.querySelector('#cart-info');
const checkoutEtaEl = document.querySelector('#checkout-eta');
function setShipping(s) {
  const ok = s && Array.isArray(s.bands) && s.bands.length && s.bands.every(b => b && Number.isFinite(Number(b.max_km)) && Number.isInteger(b.fee_cents));
  shipping = ok ? s : null;
  renderInfo();
}
const brlShort = c => (c % 100 ? brl(c) : 'R$ ' + c / 100);
// "até 10 km: de R$ 6 a R$ 14"
function shipText() {
  if (!shipping) return '';
  const fees = shipping.bands.map(b => b.fee_cents);
  const min = Math.min(...fees), max = Math.max(...fees);
  const km = kmText(Number(shipping.maxKm) || shipping.bands[shipping.bands.length - 1].max_km);
  return `até ${km} km: ${min === max ? brlShort(min) : `de ${brlShort(min)} a ${brlShort(max)}`}`;
}
const pickupText = () => (shipping && shipping.pickupFeeCents > 0 ? `Retirada: ${brlShort(shipping.pickupFeeCents)}` : 'Retirada grátis');
// Horário de hoje (São Paulo): "10:00 às 22:00" ou "fechado hoje".
function todayHoursText() {
  if (!Array.isArray(storeHours)) return '';
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(new Intl.DateTimeFormat('en-US', { timeZone: SP_TZ, weekday: 'short' }).format(new Date()));
  const rows = storeHours.filter(h => h && h.weekday === wd && /^\d{2}:\d{2}$/.test(h.opens) && /^\d{2}:\d{2}$/.test(h.closes));
  return rows.length ? rows.map(h => `${h.opens} às ${h.closes}`).join(' e ') : 'fechado hoje';
}
function closedText(where) {
  const base = closedMessage(store || {});
  if (scheduling) return base + (where === 'checkout' ? ' Você pode agendar o pedido em "Quando?", logo abaixo.' : ' Você já pode agendar o seu pedido.');
  return base + ' Você pode montar o carrinho, mas só conseguimos receber o pedido com a loja aberta.';
}
function renderInfo() {
  const closed = !!store && !store.open;
  // faixa de loja fechada (topo), no carrinho e no checkout
  closedStripEl.hidden = !closed;
  closedStripTextEl.textContent = closed ? closedText('top') : '';
  closedStripBtnEl.hidden = !(closed && scheduling);
  cartClosedEl.hidden = !closed;
  cartClosedEl.textContent = closed ? closedText('cart') : '';
  closedNoteEl.hidden = !closed;
  closedNoteEl.textContent = closed ? closedText('checkout') : '';
  // faixa de confiança
  const hours = todayHoursText();
  document.querySelector('#trust-hours').hidden = !hours;
  document.querySelector('#trust-hours-text').textContent = hours;
  document.querySelector('#trust-eta').hidden = !etaText();
  document.querySelector('#trust-eta-text').textContent = etaText() ? `chega em ${etaText()}` : '';
  document.querySelector('#trust-ship').hidden = !shipText();
  document.querySelector('#trust-ship-text').textContent = shipText() ? `${shipText()} · ${pickupText().toLowerCase()}` : '';
  balanceTrust();
  // carrinho: prazo e frete
  const parts = [etaText() && `Entrega em ${etaText()}`, shipText() && `frete ${shipText()}`, shipping && pickupText()].filter(Boolean);
  cartInfoEl.hidden = !parts.length || !cart.length;
  cartInfoEl.textContent = parts.length ? parts.join(' · ') + '. O frete exato aparece no checkout.' : '';
  // checkout: prazo quando "Quando?" não aparece
  checkoutEtaEl.hidden = !etaText() || !!scheduling;
  checkoutEtaEl.textContent = etaText() ? `${isPickup() ? 'Pronto para retirar' : 'Entrega'} em ${etaText()}, depois da confirmação do pagamento.` : '';
}
// Achado do A5 (F4): na grade de 2 colunas do celular, o último cartão visível ficava sozinho. Com número ímpar de cartões, o último ocupa a linha toda.
function balanceTrust() {
  const items = [...document.querySelectorAll('#trust > li')];
  items.forEach(li => li.classList.remove('trust-wide'));
  const shown = items.filter(li => !li.hidden);
  if (shown.length % 2) shown[shown.length - 1].classList.add('trust-wide');
}
closedStripBtnEl.addEventListener('click', () => {
  if (cart.length) { confirmRmKey = null; renderCart(); openModal('#cart-modal', { opener: closedStripBtnEl }); return; }
  scrollToEl(document.getElementById('cardapio'), '#cardapio');
  toast('Escolha seus doces. No checkout, em "Quando?", escolha o dia e o horário.', 5000);
});

/* ---------- Etapa pós-pedido: cartão (link), Pix (QR no site) ou sem pagamento. O botão do WhatsApp só vem depois de aprovado (C6). ---------- */
const payEls = {
  codeRow: document.querySelector('#payment-code-row'),
  code: document.querySelector('#payment-code'),
  sched: document.querySelector('#pay-sched'),
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
  amountRow: document.querySelector('#pix-amount-row'),
  amount: document.querySelector('#pix-amount'),
  qrBox: document.querySelector('#pix-qr-box'),
  thanks: document.querySelector('#pay-thanks'),
  review: document.querySelector('#pay-review'),
  insta: document.querySelector('#pay-insta'),
  thanksClose: document.querySelector('#pay-thanks-close'),
  card: document.querySelector('#pay-mp'),
  support: document.querySelector('#pay-support'),
  retry: document.querySelector('#pay-retry'),
  again: document.querySelector('#pay-again'),
  againBtn: document.querySelector('#pay-again-btn'),
  againStatus: document.querySelector('#pay-again-status'),
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
modalHooks['#checkout-modal'] = { open() { refreshStore(); loadAccount(); loadPrefill(); loadPointsPreview(); couponOnOpen(); if (scheduling) { fillDays(); renderWhen(); loadSlots(); } }, close() { stopPayWatch(); closeThanks(); } };

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
  payEls.sched.hidden = !order.scheduledLabel;
  payEls.sched.textContent = order.scheduledLabel || '';
  payEls.summary.hidden = !order.summary;
  if (order.summary) fillSummary(payEls.summary, order.summary);
  setPayStatus('', '');
  payEls.pixBox.hidden = type !== 'pix';
  payEls.card.hidden = payEls.support.hidden = type !== 'card';
  payEls.retry.hidden = true;
  payEls.wa.hidden = true; // só depois do pagamento confirmado
  payEls.help.hidden = true;
  payEls.thanks.hidden = true;
  payEls.copyStatus.textContent = '';
  payEls.timer.textContent = '';
  currentOrder = order;
  const failed = !pay && !watchNow; // v4 U-08: pedido registrado, mas o pagamento não foi gerado
  showPayAgain(failed && !!order.token, order);
  let msg = text;
  if (msg == null) {
    msg = type === 'pix' ? 'Pedido registrado! Esta tela confirma sozinha quando o Pix cair.'
      : type === 'card' ? 'Pedido registrado! Pague com cartão no botão abaixo. Esta tela confirma sozinha quando o pagamento for aprovado.'
      : 'Pedido registrado, mas não foi possível gerar o pagamento agora.' + (order.token ? ' Toque em "Gerar novo pagamento" para tentar de novo' + (WHATSAPP_NUMBER ? ', ou fale com a Gigi pelo WhatsApp com o código do pedido.' : '.') : ' Fale com a Gigi pelo WhatsApp para combinar o pagamento.');
  }
  payEls.text.textContent = msg;
  if (type === 'card') payEls.card.href = pay.url;
  if (type === 'pix') {
    payEls.pixCode.value = pay.qr_code;
    // v4 U-02: valor em destaque (total do servidor) e QR recolhido em "Pagar por outro aparelho".
    const total = Number.isInteger(order.total) ? order.total : order.summary && Number.isInteger(order.summary.total) ? order.summary.total : null;
    payEls.amountRow.hidden = total === null;
    payEls.amount.textContent = total === null ? '' : brl(total);
    payEls.qrBox.open = false;
    if (pay.qr_code_base64) { payEls.qr.src = 'data:image/png;base64,' + pay.qr_code_base64; payEls.qrBox.hidden = false; }
    else { payEls.qr.removeAttribute('src'); payEls.qrBox.hidden = true; }
  }
  if (failed && WHATSAPP_NUMBER) {
    payEls.help.hidden = false;
    payEls.help.href = waLink(`Olá! Fiz o pedido ${order.publicCode || order.code} pelo site e o pagamento não foi gerado. Pode me ajudar?`);
  }
  checkoutFormEl.hidden = true;
  paymentStepEl.hidden = false;
  checkoutTitleEl.textContent = title || (type === 'pix' ? 'Falta só pagar o Pix' : type === 'card' ? 'Pagamento' : 'Pedido registrado');
  const panel = paymentStepEl.closest('.modal-panel');
  if (panel) panel.scrollTop = 0;
  (type === 'pix' ? payEls.copyBtn : type === 'card' ? payEls.card : !payEls.again.hidden ? payEls.againBtn : payEls.help.hidden ? payEls.trackLink : payEls.help).focus({ preventScroll: true });
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
      if (d.payment_status === 'approved') onPayApproved(order, d.post_payment);
      else if (d.payment_status === 'rejected') onPayEnded(order, 'O pagamento foi recusado. Você pode tentar de novo ou refazer o pedido.');
      else if (d.payment_status === 'cancelled') onPayEnded(order, 'O pagamento foi cancelado. Você pode refazer o pedido.');
      else if (d.status_key === 'cancelled') onPayEnded(order, 'O pedido foi cancelado. Se tiver dúvida, fale com a Gigi pelo WhatsApp.');
    } catch { /* sem rede: tenta de novo no próximo ciclo */ } finally { busy = false; }
  };
  watch.pollNow = poll;
  watch.poll = setInterval(poll, POLL_MS);
  if (immediate) poll();
}

function onPayApproved(order, postPayment) {
  stopPayWatch();
  markLastOrder(order.token, { status: 'approved' });
  showPayAgain(false);
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
  showThanks(order.publicCode || order.code, postPayment);
}

function onPayEnded(order, msg) {
  stopPayWatch();
  markLastOrder(order.token, { status: 'ended' });
  payEls.pixBox.hidden = true;
  setPayStatus(msg, 'warn');
  payEls.text.textContent = 'Se já pagou, fale com a Gigi pelo WhatsApp informando o número do pedido.';
  checkoutTitleEl.textContent = 'Pagamento não concluído';
  payEls.retry.textContent = 'Refazer pedido';
  showPayAgain(!!order.token, order);
  payEls.retry.hidden = !!order.token || !(lastCartCopy && lastCartCopy.length); // com novo pagamento possível, refazer só se o servidor recusar
  if (WHATSAPP_NUMBER) {
    payEls.help.hidden = false;
    payEls.help.href = waLink(`Olá! Tive um problema com o pagamento do pedido ${order.publicCode || order.code}. Pode me ajudar?`);
  }
  (!payEls.again.hidden ? payEls.againBtn : payEls.retry.hidden ? payEls.help : payEls.retry).focus({ preventScroll: true });
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

/* v4 U-01: Pix em aberto. Ao recarregar a loja, o último pedido com Pix pendente reabre a tela de pagamento (o código vem
   de /api/order-status, só enquanto pendente e não vencido). Fechar com o Pix em aberto pede confirmação. */
const PIX_CLOSE_MSG = 'O Pix ainda não foi pago. Se fechar agora, você volta a ele pelo botão "Acompanhe" ou pelo link do pedido. Fechar mesmo assim?';
const pixPending = () => modalStack.includes('#checkout-modal') && !paymentStepEl.hidden && !payEls.pixBox.hidden && watch.tick !== null;
function markLastOrder(token, patch) {
  const last = readLastOrder();
  if (last && token && last.token === token) writeStore(LAST_ORDER_KEY, { ...last, ...patch });
}
function confirmPixClose() {
  if (!window.confirm(PIX_CLOSE_MSG)) return false;
  const last = readLastOrder();
  if (last) markLastOrder(last.token, { pix_dismissed: true }); // não reabre sozinho de novo; segue no "Acompanhe"
  return true;
}
async function resumePix() {
  const last = readLastOrder();
  if (!last || last.status !== 'awaiting_payment' || last.payment_choice !== 'pix' || last.pix_dismissed) return;
  if (!(Date.parse(last.pix_expires_at) > Date.now())) return;
  try {
    const r = await fetch('/api/order-status?t=' + encodeURIComponent(last.token), { cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    const pay = d && d.pix && typeof d.pix === 'object' ? normalizePayment({ type: 'pix', ...d.pix }) : null;
    if (!pay) { markLastOrder(last.token, { status: d && d.payment_status === 'approved' ? 'approved' : 'ended' }); return; }
    if (modalStack.length) return; // a pessoa já abriu outra coisa
    openModal('#checkout-modal', { opener: document.body });
    renderOrderStep({ publicCode: d.public_code || last.public_code, token: last.token, payment: pay, summary: last.summary,
      total: Number.isInteger(d.total_cents) ? d.total_cents : undefined, scheduledLabel: d.scheduled_label || last.scheduled_label || null, paymentChoice: 'pix' });
    toast('Seu Pix ainda está esperando o pagamento.', 4000);
  } catch { /* sem rede: o "Acompanhe" continua levando ao pedido */ }
}

/* v4 F3: "Gerar novo pagamento" do mesmo pedido (POST /api/order?a=retry_payment com { t } e payment_choice). O servidor não
   recalcula nada; pode recusar com 409 (pedido novo necessário, cartão em análise...) ou 429. */
let currentOrder = null;
const RETRY_MSGS = {
  already_paid: 'Este pedido já está pago. Não precisa pagar de novo.',
  order_cancelled: 'Este pedido foi cancelado. Se quiser, faça um pedido novo.',
  retry_expired: 'Passou o prazo de 24 horas para pagar este pedido. Faça um pedido novo.',
  payment_in_process: 'O pagamento com cartão ainda está em análise. Espere a resposta antes de tentar de novo, para não cobrar duas vezes.',
  schedule_passed: 'O horário agendado deste pedido já passou. Faça um pedido novo com outro horário.',
  reservation_released: 'O prêmio do Clube ou o cupom deste pedido já foi liberado. Faça um pedido novo.',
  slot_full: 'O horário agendado lotou enquanto o pagamento estava pendente. Faça um pedido novo com outro horário.',
  rate_limited: 'Muitas tentativas em pouco tempo. Espere alguns minutos e tente de novo.',
  login_required: 'Entre na sua conta para pagar este pedido.',
  order_not_found: 'Não encontramos este pedido.',
  payment_unavailable: 'O pagamento on-line não respondeu agora. Tente de novo em instantes ou fale com a Gigi pelo WhatsApp.'
};
const RETRY_NEW_ORDER = new Set(['order_cancelled', 'retry_expired', 'schedule_passed', 'reservation_released', 'slot_full']);
function setAgainStatus(msg, kind) {
  payEls.againStatus.textContent = msg;
  payEls.againStatus.className = 'pay-again-status' + (kind ? ' ' + kind : '');
}
function showPayAgain(on, order) {
  payEls.again.hidden = !on;
  payEls.againBtn.disabled = false;
  payEls.againBtn.textContent = 'Gerar novo pagamento';
  setAgainStatus('', '');
  if (on) {
    const choice = order && order.paymentChoice === 'card' ? 'card' : 'pix';
    const r = paymentStepEl.querySelector(`input[name="again_choice"][value="${choice}"]`);
    if (r) r.checked = true;
  }
}
payEls.againBtn.addEventListener('click', async () => {
  const order = currentOrder;
  if (!order || !order.token || payEls.againBtn.disabled) return;
  const pick = paymentStepEl.querySelector('input[name="again_choice"]:checked');
  const choice = pick && pick.value === 'card' ? 'card' : 'pix';
  payEls.againBtn.disabled = true;
  payEls.againBtn.textContent = 'Gerando...';
  setAgainStatus('', '');
  let r, d = {};
  try {
    r = await fetch('/api/order?a=retry_payment', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t: order.token, payment_choice: choice }) });
    try { d = await r.json(); } catch { /* corpo não-JSON */ }
  } catch {
    payEls.againBtn.disabled = false; payEls.againBtn.textContent = 'Gerar novo pagamento';
    setAgainStatus('Sem conexão com o servidor. Confira a internet e tente de novo.', 'warn');
    return;
  }
  const payment = r.ok ? normalizePayment(d.payment) : null;
  if (payment) {
    if (payment.type === 'card') {
      markLastOrder(order.token, { status: 'awaiting_payment', payment_choice: 'card', paymentUrl: payment.url });
      setAgainStatus('Abrindo o pagamento com cartão...', '');
      location.href = payment.url;
      return;
    }
    markLastOrder(order.token, { status: 'awaiting_payment', payment_choice: 'pix', pix_expires_at: Number.isFinite(Date.parse(payment.expires_at)) ? new Date(Date.parse(payment.expires_at)).toISOString() : new Date(Date.now() + PIX_DEFAULT_MS).toISOString(), pix_dismissed: false });
    renderOrderStep({ ...order, payment, paymentChoice: 'pix', total: Number.isInteger(d.total_cents) ? d.total_cents : order.total });
    toast('Novo Pix gerado! Agora é só pagar.', 4000);
    return;
  }
  payEls.againBtn.disabled = false;
  payEls.againBtn.textContent = 'Gerar novo pagamento';
  const code = d && d.code;
  const msg = (r.ok && 'Não foi possível gerar o pagamento agora. Tente de novo.') || RETRY_MSGS[code] || (r.status === 429 ? RETRY_MSGS.rate_limited : (d && d.error) || 'Não foi possível gerar o pagamento agora. Tente de novo.');
  setAgainStatus(msg, 'warn');
  if (code === 'already_paid') { payEls.again.hidden = true; startPayWatch(order, null, true); return; }
  if (RETRY_NEW_ORDER.has(code)) {
    payEls.again.hidden = true;
    setPayStatus(msg, 'warn');
    payEls.retry.textContent = 'Refazer pedido';
    payEls.retry.hidden = !(lastCartCopy && lastCartCopy.length);
    (payEls.retry.hidden ? payEls.trackLink : payEls.retry).focus({ preventScroll: true });
  }
});

/* v4 N8: depois do pagamento aprovado, convite para avaliar no Google e seguir no Instagram. Só aparece se o servidor
   mandar post_payment e uma vez por pedido (marcado no aparelho ao fechar ou ao tocar num dos links). */
const POST_SEEN_KEY = 'dg-post-payment-seen';
const httpsUrl = u => { if (typeof u !== 'string' || u.length > 500) return ''; try { const x = new URL(u); return x.protocol === 'https:' ? x.href : ''; } catch { return ''; } };
const postSeen = () => { const v = readStore(POST_SEEN_KEY); return Array.isArray(v) ? v.filter(c => typeof c === 'string') : []; };
function markPostSeen(code) {
  if (!code) return;
  writeStore(POST_SEEN_KEY, [code, ...postSeen().filter(c => c !== code)].slice(0, 30));
}
function showThanks(code, pp) {
  if (!pp || typeof pp !== 'object' || !code || postSeen().includes(code)) return;
  const review = httpsUrl(pp.review_url), insta = httpsUrl(pp.instagram_url);
  if (!review && !insta) return;
  payEls.review.hidden = !review;
  payEls.insta.hidden = !insta;
  if (review) payEls.review.href = review;
  if (insta) payEls.insta.href = insta;
  payEls.thanks.dataset.code = code;
  payEls.thanks.hidden = false;
}
function closeThanks() {
  if (payEls.thanks.hidden) return;
  markPostSeen(payEls.thanks.dataset.code);
  payEls.thanks.hidden = true;
}
payEls.thanksClose.addEventListener('click', () => { closeThanks(); (payEls.wa.hidden ? payEls.trackLink : payEls.wa).focus({ preventScroll: true }); });
payEls.review.addEventListener('click', () => markPostSeen(payEls.thanks.dataset.code));
payEls.insta.addEventListener('click', () => markPostSeen(payEls.thanks.dataset.code));

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
    if (i.reward) line += '\n   prêmio do Clube (grátis)';
    else if (Number.isInteger(i.unit_total_cents)) line += `\n   ${brl(i.unit_total_cents * i.qty)}`;
    lines.push(line);
  }
  lines.push('');
  if (Number.isInteger(srv.subtotal_cents)) lines.push(`Subtotal: ${brl(srv.subtotal_cents)}`);
  if (Number.isInteger(srv.delivery_fee_cents)) lines.push(`Frete: ${brl(srv.delivery_fee_cents)}`);
  if (srv.discount_cents > 0) lines.push(`${srv.coupon_code ? `Cupom ${srv.coupon_code}` : 'Desconto'}: − ${brl(srv.discount_cents)}`);
  if (srv.club_points > 0) lines.push(`Prêmio do Clube: ${srv.club_points} pontos`);
  lines.push(`*Total: ${brl(srv.total_cents)}*`);
  lines.push('', `Nome: ${cust.customer_name}`);
  lines.push(`WhatsApp: ${cust.customer_phone}`);
  if (srv.scheduled_label) lines.push(srv.scheduled_label);
  if (srv.delivery_method === 'pickup') lines.push(`Retirada em: ${STORE_ADDRESS}`);
  else lines.push(`Entrega: ${srv.address || cust.address || 'a combinar'}`);
  lines.push(`Pagamento: ${cust.payment_choice === 'card' ? 'Cartão de crédito ou débito' : 'Pix'}`);
  if (cust.notes) lines.push(`Obs.: ${cust.notes}`);
  if (srv.tracking_token) lines.push(`Acompanhar: ${location.origin}${trackUrl(srv.tracking_token)}`);
  return lines.join('\n');
}

// Erros do POST /api/order, em português claro (contrato seção 3)
const CLUB_ERRORS = new Set(['login_required', 'insufficient_points', 'points_locked', 'points_disabled', 'reward_unavailable', 'reward_max_per_order', 'reward_min_subtotal', 'invalid_rewards', 'points_discount_ended']);
function handleOrderError(status, d) {
  const code = d && d.code;
  if (code === 'store_closed') { setStoreState(d.store || { open: false, reason: null, message: d.error }); toast('A loja está fechada agora. ' + closedMessage(store || {}) + (scheduling ? ' Você pode agendar o pedido em "Quando?".' : ''), 7000); return; }
  // v4 N10: janela recusada (lotou, ficou em cima da hora...): recarrega os horários e mostra o motivo.
  if (SCHEDULE_ERRORS.has(code)) {
    slotCache.clear();
    loadSlots(true).then(() => { showWhenStatus((d && d.error) || 'Escolha outro horário.', 'warn'); });
    toast((d && d.error) || 'Esse horário não está mais disponível. Escolha outro.', 7000);
    whenSlotEl.focus({ preventScroll: false });
    return;
  }
  if (code === 'scheduling_disabled') { setScheduling(null); toast((d && d.error) || 'O agendamento está desligado. Faça o pedido para o quanto antes.', 7000); return; }
  // v4 N3: prêmios do Clube. Mostra a mensagem do servidor e atualiza saldo e vitrine.
  if (CLUB_ERRORS.has(code)) {
    if (code === 'login_required') { account = null; clubMine = null; chosenRewards.clear(); renderAccount(); }
    else if (code !== 'reward_min_subtotal') { loadClub(); refreshClubInfo(); }
    renderPoints(); renderSummary();
    toast((d && d.error) || 'Confira os prêmios do Clube e tente de novo.', 7000);
    return;
  }
  // v4 N6: cupom recusado na hora do pedido (esgotou, mudou o carrinho...): tira o desconto e mostra o motivo.
  if (COUPON_ERRORS.has(code)) {
    coupon = null;
    if (COUPON_DROP.has(code)) removeStore(COUPON_KEY);
    showCouponStatus((d && d.error) || 'O cupom não pôde ser usado.', 'warn');
    syncCouponUi(); renderSummary();
    toast(((d && d.error) || 'O cupom não pôde ser usado.') + ' Remova o cupom para seguir sem desconto.', 7000);
    return;
  }
  // F5 (A1-05): origem/tipo barrados pelo servidor. O site manda os dois certos; isso só acontece com página antiga, extensão ou proxy.
  if (code === 'forbidden_origin' || status === 403 && !code) { toast('Não conseguimos confirmar de onde veio o pedido. Atualize a página e tente de novo. Seu carrinho foi mantido.', 7000); return; }
  if (code === 'unsupported_type' || status === 415) { toast('O pedido chegou num formato que não reconhecemos. Atualize a página e tente de novo. Seu carrinho foi mantido.', 7000); return; }
  if (status === 429) { toast('Recebemos muitos pedidos seguidos desta conexão ou deste telefone. Aguarde uns 10 minutos e tente de novo, ou chame a gente no WhatsApp.', 8000); return; }
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
  if (store && !store.open && !wantsSchedule()) { toast(closedMessage(store) + (scheduling ? ' Você pode agendar o pedido em "Quando?".' : ''), 6000); return; }
  if (wantsSchedule() && !scheduledFor()) { toast('Escolha o dia e o horário do agendamento.', 5000); (whenSlotEl.disabled ? whenDayEl : whenSlotEl).focus(); return; }
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
    const rw = rewardsPayload();
    if (rw.length) order.rewards = rw;
    // v4 N6: código digitado e ainda não conferido para este carrinho: confere antes e deixa a pessoa ver o novo total.
    const typedCoupon = normCoupon(couponInputEl.value);
    if (typedCoupon && !(couponValid() && coupon.code === typedCoupon)) {
      const ok = await checkCoupon(typedCoupon);
      toast(ok ? 'Cupom aplicado! Confira o total e toque em Enviar pedido de novo.' : 'Confira o cupom acima: corrija o código ou remova para seguir sem desconto.', 6000);
      return;
    }
    if (couponValid()) order.coupon_code = coupon.code;
    if (scheduledFor()) order.scheduled_for = scheduledFor();
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
    const rewardsDone = srv.items.filter(i => i && i.reward).map(i => ({ qty: i.qty, name: i.name, size_name: i.size, points: (Number(i.points_cost) || 0) * i.qty }));
    const summary = { subtotal: srv.subtotal_cents, fee: srv.delivery_fee_cents, pickup: srv.delivery_method === 'pickup', discount: srv.discount_cents || 0, couponCode: srv.coupon_code || null, total: srv.total_cents, rewards: rewardsDone };
    // pedido criado com sucesso: só agora o carrinho é limpo (cópia guardada para "refazer")
    lastCartCopy = cart.map(i => ({ ...i }));
    cart = [];
    save();
    chosenRewards.clear();
    quote = null;
    if (srv.coupon_code) { removeStore(COUPON_KEY); coupon = null; couponInputEl.value = ''; showCouponStatus('', ''); syncCouponUi(); }
    addRecent({ public_code: data.public_code, code: data.code, token: data.tracking_token });
    const card = payment && payment.type === 'card';
    // v4 U-01: com Pix, guarda só o prazo; o código volta do servidor (/api/order-status pix) ao reabrir.
    const pixUntil = payment && payment.type === 'pix' ? (Number.isFinite(Date.parse(payment.expires_at)) ? new Date(Date.parse(payment.expires_at)).toISOString() : new Date(Date.now() + PIX_DEFAULT_MS).toISOString()) : null;
    saveLastOrder({ public_code: data.public_code, token: data.tracking_token, status: payment ? 'awaiting_payment' : 'registered', summary, payment_choice: order.payment_choice, scheduled_label: srv.scheduled_label || null,
      ...(card ? { paymentUrl: payment.url, whatsappText } : {}), ...(pixUntil ? { pix_expires_at: pixUntil } : {}) });
    slotCache.clear();
    renderOrderStep({ code: data.code, publicCode: data.public_code, token: data.tracking_token, whatsappText, payment, summary, scheduledLabel: srv.scheduled_label || null, paymentChoice: order.payment_choice });
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
  renderOrderStep({ publicCode: last.public_code, token: last.token, whatsappText: typeof last.whatsappText === 'string' ? last.whatsappText : '', payment: retryPay, summary: last.summary, paymentChoice: last.payment_choice },
    { title: status === 'erro' ? 'Pagamento não concluído' : 'Pedido registrado', text: texts[status], watchNow: status !== 'erro' });
}

payEls.wa.addEventListener('click', forgetWhatsAppText); // texto enviado: não fica mais guardado no aparelho
readLastOrder(); // apaga o último pedido vencido (24 h) ou no formato antigo
const resumeOnLoad = !new URLSearchParams(location.search).has('pagamento');
syncDelivery();
renderCartFab();
renderAccount();
loadAccount();
refreshStore(); // horário de hoje (a=state traz hours)
handlePaymentReturn();
if (resumeOnLoad) resumePix();

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
