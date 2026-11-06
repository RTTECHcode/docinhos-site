const statusEl = document.querySelector('#status');
const menuEl = document.querySelector('#menu');
const catsEl = document.querySelector('#categorias');
const cartFab = document.querySelector('#cart-fab');
const cartFabCount = document.querySelector('#cart-fab-count');
const toastEl = document.createElement('div');
toastEl.id = 'toast';
document.body.appendChild(toastEl);

const WHATSAPP_NUMBER = window.WHATSAPP_NUMBER || '5511999999999';
let menu = [];
let cart = JSON.parse(sessionStorage.getItem('dg-cart') || '[]');
let activeProduct = null;
let sel = { size: null, extras: {} };

const brl = cents => 'R$ ' + (cents / 100).toFixed(2).replace('.', ',');
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' };
const esc = s => String(s ?? '').replace(/[&<>'"]/g, c => ESC_MAP[c]);
const save = () => { sessionStorage.setItem('dg-cart', JSON.stringify(cart)); renderCartFab(); };

toastEl.setAttribute('role', 'status');
toastEl.setAttribute('aria-live', 'polite');
function toast(msg, ms = 1800) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => toastEl.classList.remove('show'), ms);
}

function openModal(id) {
  const modal = document.querySelector(id);
  modal._opener = document.activeElement;
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  const close = modal.querySelector('.modal-close');
  if (close) close.focus({ preventScroll: true });
}
function closeModal(el) {
  const modal = el.closest('.modal');
  if (!modal) return;
  modal.hidden = true;
  if (!document.querySelector('.modal:not([hidden])')) document.body.style.overflow = '';
  if (modal._opener && modal._opener.focus) modal._opener.focus({ preventScroll: true });
}
document.addEventListener('click', e => { if (e.target.matches('[data-close]') || e.target.closest('[data-close]')) closeModal(e.target); });

fetch('/api/menu').then(r => { if (!r.ok) throw 0; return r.json(); }).then(data => {
  statusEl.remove();
  menu = data.categories;
  renderCats();
  renderMenu();
  observeCats();
}).catch(() => { statusEl.textContent = 'Cardápio indisponível no momento.'; });

/* ---------- Navegação entre categorias ---------- */
const catFab = document.querySelector('#cat-fab');
const catSheet = document.querySelector('#cat-sheet');
const catList = document.querySelector('#cat-list');
let activeCat = null;
let navLockUntil = 0;

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
  if (chip) catsEl.scrollTo({ left: chip.offsetLeft - (catsEl.clientWidth - chip.offsetWidth) / 2, behavior: 'smooth' });
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

function goToCat(id) {
  const target = document.getElementById('cat-' + id);
  if (!target) return;
  navLockUntil = Date.now() + 1200;
  setActiveCat(id);
  target.scrollIntoView({ block: 'start' }); // suavidade vem do CSS (respeita prefers-reduced-motion)
  history.replaceState(null, '', '#cat-' + id);
}

function openCatSheet() {
  catSheet.hidden = false;
  document.body.style.overflow = 'hidden';
  catFab.setAttribute('aria-expanded', 'true');
  (catList.querySelector('.cat-item.active') || catList.querySelector('.cat-item') || catSheet.querySelector('.modal-close')).focus({ preventScroll: true });
}
function closeCatSheet() {
  catSheet.hidden = true;
  catFab.setAttribute('aria-expanded', 'false');
  if (!document.querySelector('.modal:not([hidden])')) document.body.style.overflow = '';
  catFab.focus({ preventScroll: true });
}
catFab.addEventListener('click', openCatSheet);
catSheet.addEventListener('click', e => { if (e.target.closest('[data-sheet-close]')) closeCatSheet(); });

document.addEventListener('click', e => {
  const link = e.target.closest('a[data-cat]');
  if (!link) return;
  e.preventDefault();
  if (link.classList.contains('cat-item')) closeCatSheet();
  goToCat(link.dataset.cat);
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
  const open = [...document.querySelectorAll('.modal:not([hidden])')].pop();
  if (!open) return;
  if (e.key === 'Escape') {
    if (open === catSheet) closeCatSheet(); else closeModal(open.querySelector('.modal-panel'));
  } else if (e.key === 'Tab') trapFocus(e, open);
});

function renderMenu() {
  menuEl.innerHTML = menu.map(c => `
    <section class="category" id="cat-${c.id}">
      <h2>${esc(c.name)}</h2>
      <div class="grid">${c.products.map(p => `
        <button type="button" class="card" data-pid="${p.id}">
          ${p.imagePath ? `<img src="${encodeURI(p.imagePath)}" alt="" width="88" height="88" loading="lazy" decoding="async">` : '<span class="placeholder" aria-hidden="true">🍬</span>'}
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
  if (card) openProduct(Number(card.dataset.pid));
});

function openProduct(id) {
  activeProduct = findProduct(id);
  if (!activeProduct) return;
  const comps = activeProduct.complements || [];
  const sizes = comps.filter(c => c.kind === 'size');
  const extras = comps.filter(c => c.kind !== 'size');
  sel = { size: sizes.length ? sizes[0] : null, extras: {} };

  document.querySelector('#product-modal-body').innerHTML = `
    <div class="pm-photo">${activeProduct.imagePath ? `<img src="${encodeURI(activeProduct.imagePath)}" alt="${esc(activeProduct.name)}">` : ''}</div>
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
            <span class="comp-qty"><button data-size="${s.id}" ${i === 0 ? 'disabled' : ''}>${i === 0 ? '✓' : '+'}</button></span>
          </div>`).join('')}
      </div>` : ''}
    ${extras.length ? `
      <div class="comp-group">
        <h4>Complementos</h4>
        <p class="hint">Opcional — até ${Math.max(...extras.map(x => x.maxQuantity))} por item</p>
        ${extras.map(x => `
          <div class="comp-item">
            <span class="comp-left">${esc(x.name)}${x.priceCents ? `<span class="comp-price">+ ${brl(x.priceCents)}</span>` : ''}</span>
            <span class="comp-qty">
              <button data-minus="${x.id}" disabled>−</button>
              <span class="n" data-count="${x.id}">0</span>
              <button data-plus="${x.id}">+</button>
            </span>
          </div>`).join('')}
      </div>` : ''}
    <div class="pm-total-row"><span>Total</span><span id="pm-total"></span></div>
    <button class="button primary full" id="pm-add">Adicionar ao carrinho</button>`;
  updatePmTotal();
  openModal('#product-modal');
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
  if (!activeProduct) return;
  const comps = activeProduct.complements || [];
  const sizeBtn = e.target.closest('[data-size]');
  if (sizeBtn) {
    sel.size = comps.find(c => c.id === Number(sizeBtn.dataset.size));
    document.querySelectorAll('[data-size]').forEach(b => { b.textContent = b === sizeBtn ? '✓' : '+'; b.disabled = b === sizeBtn; });
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
    addToCart(activeProduct, sel);
    closeModal(e.target);
    toast('Adicionado ao carrinho ✓');
  }
});

function addToCart(product, sel2) {
  const extras = Object.entries(sel2.extras).map(([cid, q]) => {
    const c = (product.complements || []).find(x => x.id === Number(cid));
    return { name: c.name, qty: q, priceCents: c.priceCents };
  });
  const size = sel2.size ? { name: sel2.size.name, qty: 1, priceCents: sel2.size.priceCents } : null;
  const key = product.id + '|' + (size ? size.name : '') + '|' + extras.map(x => `${x.name}x${x.qty}`).join(',');
  const totalCents = pmTotalCents();
  const existing = cart.find(i => i.key === key);
  if (existing) existing.qty += 1;
  else cart.push({ key, productId: product.id, name: product.name, size, extras, unitTotal: totalCents, qty: 1 });
  save();
}

function cartTotal() { return cart.reduce((s, i) => s + i.unitTotal * i.qty, 0); }
function cartCount() { return cart.reduce((s, i) => s + i.qty, 0); }

function renderCartFab() {
  const n = cartCount();
  cartFab.hidden = n === 0;
  cartFabCount.textContent = n;
}
renderCartFab();

cartFab.addEventListener('click', () => { renderCart(); openModal('#cart-modal'); });

function renderCart() {
  const itemsEl = document.querySelector('#cart-items');
  if (!cart.length) {
    itemsEl.innerHTML = '<div class="cart-empty">Seu carrinho está vazio 🍬</div>';
    document.querySelector('#checkout-btn').hidden = true;
    document.querySelector('#cart-total').innerHTML = '';
    return;
  }
  document.querySelector('#checkout-btn').hidden = false;
  itemsEl.innerHTML = cart.map((i, idx) => `
    <div class="cart-item">
      <div class="ci-info">
        <div class="ci-name">${esc(i.name)}${i.qty > 1 ? ` × ${i.qty}` : ''}</div>
        ${(i.size || i.extras.length) ? `<div class="ci-comps">${[i.size && i.size.name, ...i.extras.map(x => x.qty > 1 ? `${x.name} ×${x.qty}` : x.name)].filter(Boolean).join(' • ')}</div>` : ''}
      </div>
      <span class="ci-price">${brl(i.unitTotal * i.qty)}</span>
      <button class="ci-remove" data-rm="${idx}" aria-label="Remover">×</button>
    </div>`).join('');
  document.querySelector('#cart-total').innerHTML = `<span>Total</span><span>${brl(cartTotal())}</span>`;
}

document.addEventListener('click', e => {
  const rm = e.target.closest('[data-rm]');
  if (rm) { cart.splice(Number(rm.dataset.rm), 1); save(); renderCart(); }
});

const checkoutFormEl = document.querySelector('#checkout-form');
const paymentStepEl = document.querySelector('#payment-step');
const checkoutTitleEl = document.querySelector('#checkout-title');

function showPaymentStep(code, payUrl, waUrl) {
  document.querySelector('#payment-code').textContent = code || '';
  document.querySelector('#pay-mp').href = payUrl;
  document.querySelector('#pay-wa').href = waUrl;
  checkoutFormEl.hidden = true;
  paymentStepEl.hidden = false;
  checkoutTitleEl.textContent = 'Pagamento';
  document.querySelector('#pay-mp').focus({ preventScroll: true });
}
function resetCheckoutView() {
  checkoutFormEl.hidden = false;
  paymentStepEl.hidden = true;
  checkoutTitleEl.textContent = 'Finalizar pedido';
}

document.querySelector('#checkout-btn').addEventListener('click', () => {
  closeModal(document.querySelector('#cart-modal .modal-close'));
  resetCheckoutView();
  document.querySelector('#payment-summary').innerHTML = `<span>Total</span><span>${brl(cartTotal())}</span>`;
  openModal('#checkout-modal');
});

// Retorno do Mercado Pago: ?pagamento=ok|erro|pendente
(function handlePaymentReturn() {
  const params = new URLSearchParams(location.search);
  const status = params.get('pagamento');
  if (!status) return;
  const msgs = {
    ok: 'Pagamento aprovado! Obrigada pelo pedido ✓',
    erro: 'O pagamento não foi concluído. Você pode tentar novamente.',
    pendente: 'Pagamento pendente. Avisaremos quando for confirmado.'
  };
  if (msgs[status]) toast(msgs[status], 6000);
  params.delete('pagamento');
  const qs = params.toString();
  history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
})();

document.querySelector('#checkout-form').addEventListener('submit', async e => {
  e.preventDefault();
  const form = new FormData(e.target);
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Enviando...';
  try {
    const order = {
      customer_name: form.get('name'),
      customer_phone: form.get('phone'),
      delivery_method: form.get('delivery'),
      address: form.get('address'),
      notes: form.get('notes'),
      items: cart.map(i => ({ name: i.name, size: i.size?.name, extras: i.extras.map(x => x.qty > 1 ? `${x.name} x${x.qty}` : x.name), qty: i.qty, unit_total_cents: i.unitTotal }))
    };
    const res = await fetch('/api/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro');
    const msg = buildWhatsAppMessage(data, order);
    const waUrl = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(msg)}`;
    cart = [];
    save();
    const payUrl = data.payment && data.payment.url;
    if (typeof payUrl === 'string' && /^https:\/\//i.test(payUrl)) {
      // Com pagamento online: etapa extra com os dois botões (cliques do usuário, sem bloqueio de popup)
      showPaymentStep(data.code, payUrl, waUrl);
      toast('Pedido registrado! Falta o pagamento ✓');
    } else {
      window.open(waUrl, '_blank');
      closeModal(e.target);
      toast('Pedido enviado! Confirme no WhatsApp ✓');
    }
  } catch (err) {
    toast('Erro ao enviar pedido. Tente de novo.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Enviar pedido';
  }
});

function buildWhatsAppMessage(order, order2) {
  const lines = [`*Novo pedido ${order.code}*`, ''];
  for (const i of order2.items) {
    let line = `• ${i.qty}x ${i.name}`;
    if (i.size) line += ` (${i.size})`;
    if (i.extras.length) line += `\n   ${i.extras.join(', ')}`;
    lines.push(line);
  }
  lines.push('', `*Total: ${brl(order.total_cents)}*`);
  lines.push('', `Nome: ${order2.customer_name}`);
  lines.push(`WhatsApp: ${order2.customer_phone}`);
  lines.push(order2.delivery_method === 'delivery' ? `Entrega: ${order2.address || 'a combinar'}` : 'Retirada no local');
  if (order2.notes) lines.push(`Obs.: ${order2.notes}`);
  return lines.join('\n');
}
