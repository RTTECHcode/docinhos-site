'use strict';
/* Editor de produto (folha): dados, foto, complementos vinculados e grupos.
   CSP: img-src só permite 'self' e data:, então a prévia da foto usa data: URL (nunca blob:). */
(function () {
  const DG = window.DG;
  const { el } = DG;
  const MAX_SIDE = 1000;
  const MAX_BYTES = 2000000;

  function readAsDataUrl(blobOrFile) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error('Não foi possível ler a imagem.'));
      fr.readAsDataURL(blobOrFile);
    });
  }
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Esse arquivo não parece ser uma imagem válida.'));
      img.src = src;
    });
  }
  function toBlob(canvas, type, quality) {
    return new Promise(resolve => canvas.toBlob(resolve, type, quality));
  }
  // Redimensiona (lado maior 1000 px) e comprime: WebP, ou JPEG se o navegador não gerar WebP.
  DG.prepareImage = async function (file) {
    if (!file || !/^image\//.test(file.type)) throw new Error('Escolha um arquivo de imagem.');
    const img = await loadImage(await readAsDataUrl(file));
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    let blob = await toBlob(canvas, 'image/webp', 0.82);
    if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', 0.82);
    if (!blob) throw new Error('Não foi possível processar a imagem.');
    if (blob.size > MAX_BYTES) throw new Error('A imagem ficou maior que 2 MB. Escolha outra foto.');
    const dataUrl = await readAsDataUrl(blob);
    return { dataUrl, base64: dataUrl.slice(dataUrl.indexOf(',') + 1) };
  };

  function photoBox(product, onChange) {
    const box = el('div', { class: 'card stack' });
    const input = el('input', { type: 'file', accept: 'image/*', hidden: true });
    const paint = () => {
      const preview = product.image_path
        ? el('img', { class: 'preview', src: product.image_path, alt: 'Foto de ' + product.name })
        : el('p', { class: 'muted', text: 'Sem foto.' });
      box.replaceChildren(el('strong', { text: 'Foto' }), preview, input,
        el('div', { class: 'grid2' },
          el('button', { class: 'btn', type: 'button', text: product.image_path ? 'Trocar foto' : 'Enviar foto', on: { click: () => input.click() } }),
          product.image_path ? el('button', { class: 'btn danger', type: 'button', text: 'Remover foto', on: { click: async () => {
            if (!(await DG.confirm('Remover a foto deste produto?', 'Remover', true))) return;
            if (await DG.run(() => DG.api('product_image_remove', { body: { product_id: product.id } }), 'Foto removida.')) { product.image_path = null; paint(); onChange(); }
          } } }) : null));
    };
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.value = '';
      if (!file) return;
      const r = await DG.run(async () => {
        const prepared = await DG.prepareImage(file);
        const res = await DG.api('product_image', { body: { product_id: product.id, data: prepared.base64 } });
        return { res, prepared };
      }, 'Foto salva.');
      if (r) { product.image_path = r.res.image_path; paint(); onChange(); }
    });
    paint();
    return box;
  }

  function linksBox(product, catalog) {
    const box = el('div', { class: 'stack' });
    const paint = () => {
      const links = catalog.links.filter(l => l.product_id === product.id);
      const groups = catalog.groups.filter(g => g.product_id === product.id);
      const comp = id => catalog.complements.find(c => c.id === id);
      const rows = links.map(l => ({ l, c: comp(l.complement_id) })).filter(x => x.c);
      box.replaceChildren(
        el('h3', { class: 'section-title', text: 'Complementos deste produto' }),
        ...(rows.length ? rows.map(({ l, c }) => el('div', { class: 'card' }, el('div', { class: 'row between' },
          el('button', { class: 'item-btn grow', type: 'button', on: { click: () => editLink(l, c) } },
            el('strong', { class: 'wrap', text: c.name }),
            el('p', { class: 'muted small', text: (c.kind === 'size' ? 'Tamanho' : 'Adicional') + ' - ' + DG.money(c.price_cents) + (c.kind === 'additional' ? ' - até ' + l.max_quantity : '') + (l.group_id ? ' - ' + ((groups.find(g => g.id === l.group_id) || {}).label || 'grupo') : ''), })),
          DG.switchEl(!l.paused, 'Complemento ' + c.name + ' neste produto', async next => {
            return !!(await DG.run(() => DG.api('link_toggle', { body: { product_id: product.id, complement_id: c.id, paused: !next } }))) && ((l.paused = !next), true);
          })))) : [el('p', { class: 'muted', text: 'Nenhum complemento vinculado.' })]),
        el('button', { class: 'btn block', type: 'button', text: 'Vincular complemento', on: { click: addLink } }),
        el('h3', { class: 'section-title', text: 'Grupos de escolha' }),
        ...(groups.length ? groups.map(g => el('div', { class: 'card' }, el('div', { class: 'row between' },
          el('button', { class: 'item-btn grow', type: 'button', on: { click: () => editGroup(g) } },
            el('strong', { class: 'wrap', text: g.label }), el('p', { class: 'muted small', text: 'Escolher de ' + g.min_choices + ' a ' + g.max_choices + ' - chave: ' + g.key }))))) : [el('p', { class: 'muted', text: 'Sem grupos.' })]),
        el('button', { class: 'btn block', type: 'button', text: 'Novo grupo', on: { click: () => editGroup(null) } }));
    };
    const refresh = async () => { await DG.loadCatalog(); Object.assign(catalog, DG.state.catalog); paint(); };

    function addLink() {
      const linked = new Set(catalog.links.filter(l => l.product_id === product.id).map(l => l.complement_id));
      const free = catalog.complements.filter(c => !linked.has(c.id));
      DG.sheet('Vincular complemento', (body, close) => {
        const search = el('input', { class: 'search', type: 'search', placeholder: 'Buscar complemento', maxlength: 60, 'aria-label': 'Buscar complemento' });
        const list = el('div', { class: 'stack' });
        const paintList = () => {
          const term = search.value.trim().toLowerCase();
          const shown = free.filter(c => !term || c.name.toLowerCase().includes(term)).slice(0, 40);
          list.replaceChildren(...(shown.length ? shown.map(c => el('button', { class: 'card item-btn', type: 'button', on: { click: async () => {
            if (await DG.run(() => DG.api('link_save', { body: { product_id: product.id, complement_id: c.id, max_quantity: 1 } }), 'Vinculado.')) { close(); refresh(); }
          } } }, el('strong', { class: 'wrap', text: c.name }), el('p', { class: 'muted small', text: (c.kind === 'size' ? 'Tamanho' : 'Adicional') + ' - ' + DG.money(c.price_cents) }))) : [el('p', { class: 'muted', text: 'Nada encontrado.' })]));
        };
        search.addEventListener('input', paintList);
        paintList();
        body.append(search, list);
      });
    }

    function editLink(l, c) {
      const groups = catalog.groups.filter(g => g.product_id === product.id);
      DG.sheet(c.name, (body, close) => {
        const maxQ = el('input', { type: 'number', inputmode: 'numeric', min: 1, max: 50, value: String(l.max_quantity) });
        const group = el('select', {}, el('option', { value: '', text: 'Sem grupo' }), ...groups.map(g => el('option', { value: String(g.id), text: g.label })));
        group.value = l.group_id ? String(l.group_id) : '';
        body.append(
          c.kind === 'additional' ? el('label', { class: 'field' }, el('span', { text: 'Quantidade máxima' }), maxQ) : null,
          c.kind === 'additional' ? el('label', { class: 'field' }, el('span', { text: 'Grupo' }), group) : null,
          el('button', { class: 'btn primary block', type: 'button', text: 'Salvar', on: { click: async () => {
            const payload = { product_id: product.id, complement_id: c.id, paused: l.paused, max_quantity: Number(maxQ.value) || 1, group_id: group.value ? Number(group.value) : null };
            if (await DG.run(() => DG.api('link_save', { body: payload }), 'Salvo.')) { close(); refresh(); }
          } } }),
          el('button', { class: 'btn danger block', type: 'button', text: 'Desvincular', on: { click: async () => {
            if (!(await DG.confirm('Desvincular ' + c.name + ' deste produto?', 'Desvincular', true))) return;
            if (await DG.run(() => DG.api('link_delete', { body: { product_id: product.id, complement_id: c.id } }), 'Desvinculado.')) { close(); refresh(); }
          } } }));
      });
    }

    function editGroup(g) {
      DG.sheet(g ? 'Editar grupo' : 'Novo grupo', (body, close) => {
        const label = el('input', { type: 'text', maxlength: 80, value: g ? g.label : '' });
        const key = el('input', { type: 'text', maxlength: 40, autocapitalize: 'none', value: g ? g.key : '' });
        const min = el('input', { type: 'number', inputmode: 'numeric', min: 0, max: 50, value: String(g ? g.min_choices : 0) });
        const max = el('input', { type: 'number', inputmode: 'numeric', min: 1, max: 50, value: String(g ? g.max_choices : 1) });
        const order = el('input', { type: 'number', inputmode: 'numeric', min: 0, value: String(g ? g.sort_order : 0) });
        body.append(
          el('label', { class: 'field' }, el('span', { text: 'Título (ex.: Escolha 2 recheios)' }), label),
          el('label', { class: 'field' }, el('span', { text: 'Chave (letras minúsculas, sem espaço)' }), key),
          el('div', { class: 'grid2' }, el('label', { class: 'field' }, el('span', { text: 'Mínimo' }), min), el('label', { class: 'field' }, el('span', { text: 'Máximo' }), max)),
          el('label', { class: 'field' }, el('span', { text: 'Ordem' }), order),
          el('button', { class: 'btn primary block', type: 'button', text: 'Salvar', on: { click: async () => {
            const payload = { label: label.value, key: key.value, min_choices: Number(min.value), max_choices: Number(max.value), sort_order: Number(order.value) };
            if (g) payload.id = g.id; else payload.product_id = product.id;
            if (await DG.run(() => DG.api('group_save', { body: payload }), 'Grupo salvo.')) { close(); refresh(); }
          } } }),
          g ? el('button', { class: 'btn danger block', type: 'button', text: 'Excluir grupo', on: { click: async () => {
            if (!(await DG.confirm('Excluir o grupo "' + g.label + '"? Os complementos ficam sem grupo.', 'Excluir', true))) return;
            if (await DG.run(() => DG.api('group_delete', { body: { id: g.id } }), 'Grupo excluído.')) { close(); refresh(); }
          } } }) : null);
      });
    }
    paint();
    return box;
  }

  // Abre o editor. product = null cria um novo (defaultCategoryId opcional).
  DG.openProduct = function (productIn, catalog, defaultCategoryId, onDone) {
    const isNew = !productIn;
    const product = productIn ? { ...productIn } : { id: null, name: '', description: '', price_cents: null, category_id: defaultCategoryId || (catalog.categories[0] || {}).id, sort_order: 0, active: true, image_path: null };
    let changed = false;
    DG.sheet(isNew ? 'Novo produto' : 'Editar produto', (body, close) => {
      const name = el('input', { type: 'text', maxlength: 120, value: product.name });
      const desc = el('textarea', { maxlength: 500 });
      desc.value = product.description || '';
      const price = el('input', { type: 'text', inputmode: 'decimal', placeholder: 'ex.: 12,50', value: DG.moneyInput(product.price_cents) });
      const cat = el('select', {}, ...catalog.categories.map(c => el('option', { value: String(c.id), text: c.name + (c.active ? '' : ' (pausada)') })));
      cat.value = String(product.category_id);
      const order = el('input', { type: 'number', inputmode: 'numeric', min: 0, value: String(product.sort_order) });
      const active = DG.switchEl(product.active, 'Produto ativo', async next => { product.active = next; return true; });
      const saveBtn = el('button', { class: 'btn primary block', type: 'button', text: isNew ? 'Criar produto' : 'Salvar alterações' });
      const extra = el('div', { class: 'stack' });
      saveBtn.addEventListener('click', async () => {
        const cents = DG.parseMoney(price.value);
        if (Number.isNaN(cents)) { DG.toast('Preço inválido. Use o formato 12,50.', true); return; }
        const payload = { name: name.value, description: desc.value, price_cents: cents, category_id: Number(cat.value), sort_order: Number(order.value) || 0, active: product.active };
        if (!isNew) payload.id = product.id;
        const r = await DG.run(() => DG.api('product_save', { body: payload }), 'Produto salvo.');
        if (!r) return;
        changed = true;
        Object.assign(product, r.product);
        if (isNew) { await DG.loadCatalog(); Object.assign(catalog, DG.state.catalog); close(); DG.openProduct(product, catalog, null, onDone); }
      });
      body.append(
        el('label', { class: 'field' }, el('span', { text: 'Nome' }), name),
        el('label', { class: 'field' }, el('span', { text: 'Descrição' }), desc),
        el('div', { class: 'grid2' }, el('label', { class: 'field' }, el('span', { text: 'Preço (R$)' }), price), el('label', { class: 'field' }, el('span', { text: 'Ordem' }), order)),
        el('label', { class: 'field' }, el('span', { text: 'Categoria' }), cat),
        el('div', { class: 'card row between' }, el('div', {}, el('strong', { text: 'Disponível no cardápio' }), el('p', { class: 'muted small', text: 'Desligue para pausar' })), active),
        saveBtn);
      if (!isNew) {
        body.append(photoBox(product, () => { changed = true; }), linksBox(product, catalog),
          el('button', { class: 'btn danger block', type: 'button', text: 'Excluir produto', on: { click: async () => {
            if (!(await DG.confirm('Excluir "' + product.name + '" de vez? Pedidos antigos não são afetados.', 'Excluir', true))) return;
            if (await DG.run(() => DG.api('product_delete', { body: { id: product.id } }), 'Produto excluído.')) { changed = true; close(); }
          } } }));
      } else {
        body.append(el('p', { class: 'muted small', text: 'Depois de criar, você poderá enviar a foto e vincular complementos.' }));
      }
      body.append(extra);
    }, () => { if (changed && onDone) onDone(); });
  };
})();
