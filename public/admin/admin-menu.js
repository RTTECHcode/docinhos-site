'use strict';
/* Aba Cardápio: categorias, produtos e complementos (CRUD). O editor de produto fica em admin-product.js. */
(function () {
  const DG = window.DG;
  const { el } = DG;
  const st = { sub: 'products', search: '', catFilter: '' };

  function initials(name) { return String(name).trim().slice(0, 1).toUpperCase() || '?'; }

  function productRow(p, catalog, reload) {
    const thumb = p.image_path ? el('img', { class: 'thumb', src: p.image_path, alt: '', loading: 'lazy' }) : el('div', { class: 'thumb empty', text: initials(p.name), 'aria-hidden': 'true' });
    return el('div', { class: 'card' }, el('div', { class: 'row' },
      el('button', { class: 'item-btn grow row', type: 'button', on: { click: () => DG.openProduct(p, catalog, null, reload) } },
        thumb,
        el('span', { class: 'grow' }, el('strong', { class: 'wrap', text: p.name }), el('p', { class: 'muted small', text: DG.money(p.price_cents) + (p.active ? '' : ' - pausado') }))),
      DG.switchEl(p.active, 'Produto ' + p.name + ' ativo', async next => !!(await DG.run(() => DG.api('product_toggle', { body: { id: p.id, active: next } }))) && ((p.active = next), true))));
  }

  function productsView(box, catalog, reload) {
    const search = el('input', { class: 'search', type: 'search', placeholder: 'Buscar produto', maxlength: 60, value: st.search, 'aria-label': 'Buscar produto' });
    const chips = el('div', { class: 'chips', role: 'group', 'aria-label': 'Filtrar por categoria' });
    const list = el('div', {});
    const paint = () => {
      const term = st.search.trim().toLowerCase();
      chips.replaceChildren(...[{ id: '', name: 'Todas' }, ...catalog.categories].map(c => el('button', {
        class: 'chip', type: 'button', text: c.name, 'aria-pressed': String(String(c.id) === st.catFilter),
        on: { click: () => { st.catFilter = String(c.id); paint(); } }
      })));
      const items = catalog.products.filter(p => (!st.catFilter || String(p.category_id) === st.catFilter) && (!term || p.name.toLowerCase().includes(term)));
      const out = [];
      for (const c of catalog.categories) {
        const inCat = items.filter(p => p.category_id === c.id);
        if (!inCat.length) continue;
        out.push(el('h3', { class: 'section-title', text: c.name + (c.active ? '' : ' (pausada)') }), ...inCat.map(p => productRow(p, catalog, reload)));
      }
      list.replaceChildren(...(out.length ? out : [el('p', { class: 'muted', text: 'Nenhum produto encontrado.' })]));
    };
    search.addEventListener('input', () => { st.search = search.value; paint(); });
    paint();
    box.replaceChildren(search, chips, list,
      el('button', { class: 'btn primary block', type: 'button', text: 'Novo produto', on: { click: () => DG.openProduct(null, catalog, st.catFilter ? Number(st.catFilter) : null, reload) } }));
  }

  function editCategory(c, reload) {
    DG.sheet(c ? 'Editar categoria' : 'Nova categoria', (body, close) => {
      const name = el('input', { type: 'text', maxlength: 60, value: c ? c.name : '' });
      const order = el('input', { type: 'number', inputmode: 'numeric', min: 0, value: String(c ? c.sort_order : 0) });
      const state = { active: c ? c.active : true };
      body.append(
        el('label', { class: 'field' }, el('span', { text: 'Nome' }), name),
        el('label', { class: 'field' }, el('span', { text: 'Ordem (menor aparece primeiro)' }), order),
        el('div', { class: 'card row between' }, el('strong', { text: 'Visível no cardápio' }), DG.switchEl(state.active, 'Categoria visível', async next => { state.active = next; return true; })),
        el('button', { class: 'btn primary block', type: 'button', text: 'Salvar', on: { click: async () => {
          const payload = { name: name.value, sort_order: Number(order.value) || 0, active: state.active };
          if (c) payload.id = c.id;
          if (await DG.run(() => DG.api('category_save', { body: payload }), 'Categoria salva.')) { close(); reload(); }
        } } }));
    });
  }

  function categoriesView(box, catalog, reload) {
    box.replaceChildren(...catalog.categories.map(c => {
      const count = catalog.products.filter(p => p.category_id === c.id).length;
      return el('div', { class: 'card' }, el('div', { class: 'row' },
        el('button', { class: 'item-btn grow', type: 'button', on: { click: () => editCategory(c, reload) } },
          el('strong', { class: 'wrap', text: c.name }), el('p', { class: 'muted small', text: count + ' produto(s) - ordem ' + c.sort_order + (c.active ? '' : ' - pausada') })),
        DG.switchEl(c.active, 'Categoria ' + c.name + ' visível', async next => !!(await DG.run(() => DG.api('category_save', { body: { id: c.id, active: next } }))) && ((c.active = next), true))));
    }), el('button', { class: 'btn primary block', type: 'button', text: 'Nova categoria', on: { click: () => editCategory(null, reload) } }));
  }

  function editComplement(c, reload) {
    DG.sheet(c ? 'Editar complemento' : 'Novo complemento', (body, close) => {
      const name = el('input', { type: 'text', maxlength: 80, value: c ? c.name : '' });
      const price = el('input', { type: 'text', inputmode: 'decimal', placeholder: '0,00', value: DG.moneyInput(c ? c.price_cents : 0) });
      const kind = el('select', {}, el('option', { value: 'additional', text: 'Adicional' }), el('option', { value: 'size', text: 'Tamanho' }));
      kind.value = c ? c.kind : 'additional';
      const state = { active: c ? c.active : true };
      body.append(
        el('label', { class: 'field' }, el('span', { text: 'Nome' }), name),
        el('div', { class: 'grid2' }, el('label', { class: 'field' }, el('span', { text: 'Preço (R$)' }), price), el('label', { class: 'field' }, el('span', { text: 'Tipo' }), kind)),
        el('div', { class: 'card row between' }, el('strong', { text: 'Disponível' }), DG.switchEl(state.active, 'Complemento disponível', async next => { state.active = next; return true; })),
        el('button', { class: 'btn primary block', type: 'button', text: 'Salvar', on: { click: async () => {
          const cents = DG.parseMoney(price.value);
          if (Number.isNaN(cents)) { DG.toast('Preço inválido. Use o formato 2,50.', true); return; }
          const payload = { name: name.value, price_cents: cents === null ? 0 : cents, kind: kind.value, active: state.active };
          if (c) payload.id = c.id;
          if (await DG.run(() => DG.api('complement_save', { body: payload }), 'Complemento salvo.')) { close(); reload(); }
        } } }),
        c ? el('button', { class: 'btn danger block', type: 'button', text: 'Excluir complemento', on: { click: async () => {
          if (!(await DG.confirm('Excluir "' + c.name + '" de todos os produtos?', 'Excluir', true))) return;
          if (await DG.run(() => DG.api('complement_delete', { body: { id: c.id } }), 'Complemento excluído.')) { close(); reload(); }
        } } }) : null);
    });
  }

  function complementsView(box, catalog, reload) {
    const search = el('input', { class: 'search', type: 'search', placeholder: 'Buscar complemento', maxlength: 60, 'aria-label': 'Buscar complemento' });
    const list = el('div', {});
    const paint = () => {
      const term = search.value.trim().toLowerCase();
      const items = catalog.complements.filter(c => !term || c.name.toLowerCase().includes(term));
      list.replaceChildren(...(items.length ? items.map(c => el('div', { class: 'card' }, el('div', { class: 'row' },
        el('button', { class: 'item-btn grow', type: 'button', on: { click: () => editComplement(c, reload) } },
          el('strong', { class: 'wrap', text: c.name }), el('p', { class: 'muted small', text: (c.kind === 'size' ? 'Tamanho' : 'Adicional') + ' - ' + DG.money(c.price_cents) + ' - em ' + c.uses + ' produto(s)' })),
        DG.switchEl(c.active, 'Complemento ' + c.name + ' disponível', async next => !!(await DG.run(() => DG.api('complement_toggle', { body: { id: c.id, active: next } }))) && ((c.active = next), true))))) : [el('p', { class: 'muted', text: 'Nenhum complemento.' })]));
    };
    search.addEventListener('input', paint);
    paint();
    box.replaceChildren(search, list, el('button', { class: 'btn primary block', type: 'button', text: 'Novo complemento', on: { click: () => editComplement(null, reload) } }));
  }

  DG.tabs.menu = {
    async render(view) {
      const catalog = await DG.loadCatalog();
      DG.setStoreBadge(catalog.settings.storePaused);
      const box = el('div', {});
      const seg = el('div', { class: 'chips', role: 'group', 'aria-label': 'Seção do cardápio' });
      const reload = () => DG.reload();
      const paint = () => {
        seg.replaceChildren(...[['products', 'Produtos'], ['categories', 'Categorias'], ['complements', 'Complementos']].map(([k, label]) => el('button', {
          class: 'chip', type: 'button', text: label, 'aria-pressed': String(st.sub === k), on: { click: () => { st.sub = k; paint(); } }
        })));
        if (st.sub === 'products') productsView(box, catalog, reload);
        else if (st.sub === 'categories') categoriesView(box, catalog, reload);
        else complementsView(box, catalog, reload);
      };
      view.replaceChildren(seg, box);
      paint();
    }
  };
})();
