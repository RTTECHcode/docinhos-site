const statusEl = document.querySelector('#status');
const menuEl = document.querySelector('#menu');
const whatsapp = document.querySelector('#whatsapp');
const number = window.WHATSAPP_NUMBER || '';
whatsapp.href = number ? `https://wa.me/${number}` : '#';
fetch('/api/menu').then(response => { if (!response.ok) throw new Error(); return response.json(); }).then(({ categories }) => {
  statusEl.remove();
  menuEl.innerHTML = categories.map(category => `<section class="category"><h2>${escapeHtml(category.name)}</h2><div class="grid">${category.products.map(product => `<article class="card">${product.imagePath ? `<img src="${encodeURI(product.imagePath)}" alt="${escapeHtml(product.name)}" loading="lazy">` : '<div class="placeholder">🍬</div>'}<div class="body"><h3>${escapeHtml(product.name)}</h3>${product.description ? `<p>${escapeHtml(product.description)}</p>` : ''}${product.priceCents != null ? `<div class="price">R$ ${(product.priceCents / 100).toFixed(2).replace('.', ',')}</div>` : '<div class="price">Consulte o valor</div>'}</div></article>`).join('')}</div></section>`).join('');
}).catch(() => { statusEl.textContent = 'Cardápio indisponível no momento.'; });
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[character])); }
