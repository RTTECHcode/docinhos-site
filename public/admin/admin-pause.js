'use strict';
/* Aba Pausa rápida: caixa de comandos (regras no servidor, sem IA), pausar loja, produtos e complementos. */
(function () {
  const DG = window.DG;
  const { el } = DG;
  const st = { search: '' };
  const TYPE_LABEL = { product: 'Produto', complement: 'Complemento', category: 'Categoria', link: 'Complemento no produto', store: 'Loja' };
  const stateText = on => (on ? 'Disponível' : 'Pausado');

  function diffRow(t) {
    return el('div', { class: 'diff-row' },
      el('span', { class: 'muted small', text: TYPE_LABEL[t.type] || t.type }),
      el('strong', { class: 'wrap', text: t.name }),
      el('span', { class: 'change' },
        el('span', { class: 'state ' + (t.from ? 'on' : 'off'), text: stateText(t.from) }),
        el('span', { class: 'arrow', text: '→' }),
        el('span', { class: 'state ' + (t.to ? 'on' : 'off'), text: stateText(t.to) })));
  }

  function examplesBox(examples, onPick) {
    return el('div', { class: 'stack' }, el('p', { class: 'muted small', text: 'Exemplos:' }),
      ...examples.map(x => el('button', { class: 'btn example', type: 'button', text: x, on: { click: () => onPick(x) } })));
  }

  // Mostra a prévia do comando; só aplica depois do botão Confirmar.
  function commandBox() {
    const input = el('input', { class: 'search', type: 'text', maxlength: 200, placeholder: 'Ex.: acabou o kitkat no monte seu copo', autocapitalize: 'none', enterkeyhint: 'send', 'aria-label': 'Comando' });
    const out = el('div', { class: 'stack' });
    const run = async text => {
      const command = String(text === undefined ? input.value : text).trim();
      if (!command) { DG.toast('Escreva um comando.', true); return; }
      input.value = command;
      out.replaceChildren(el('p', { class: 'muted', text: 'Entendendo...' }));
      const r = await DG.run(() => DG.api('command', { body: { text: command } }));
      if (!r) { out.replaceChildren(); return; }
      show(r);
    };
    const show = r => {
      if (r.ok && r.targets.length) {
        out.replaceChildren(
          el('p', { class: 'muted small', text: 'Confira o que vai mudar:' }),
          el('div', { class: 'diff' }, ...r.targets.map(diffRow)),
          r.skipped ? el('p', { class: 'muted small', text: r.skipped + ' item(ns) já estava(m) assim.' }) : null,
          el('div', { class: 'grid2' },
            el('button', { class: 'btn', type: 'button', text: 'Cancelar', on: { click: () => { out.replaceChildren(); } } }),
            el('button', { class: 'btn primary', type: 'button', text: 'Confirmar', on: { click: async function () {
              this.disabled = true;
              const a = await DG.run(() => DG.api('command_apply', { body: { targets: r.targets } }), 'Pronto! Alterações aplicadas.');
              if (a) { input.value = ''; out.replaceChildren(); DG.reload(); } else this.disabled = false;
            } } })));
      } else if (r.ok) {
        out.replaceChildren(el('p', { class: 'wrap', text: r.note || 'Nada a mudar: tudo já estava assim.' }));
      } else if (r.kind === 'ambiguous') {
        out.replaceChildren(el('p', { text: r.message }), ...r.candidates.map(c => el('button', { class: 'diff-row item-btn', type: 'button', on: { click: () => show({ ok: true, targets: [c], skipped: 0 }) } },
          el('span', { class: 'muted small', text: TYPE_LABEL[c.type] || c.type }), el('strong', { class: 'wrap', text: c.name }))));
      } else {
        out.replaceChildren(el('p', { class: 'wrap', text: r.message || 'Não entendi.' }), examplesBox(r.examples || [], x => { input.value = x; input.focus(); }));
      }
    };
    const form = el('form', { class: 'stack', novalidate: true, on: { submit: e => { e.preventDefault(); run(); } } },
      el('div', { class: 'row' }, input, el('button', { class: 'btn primary', type: 'submit', text: 'Ver' })), out);
    return el('div', { class: 'card stack' }, el('strong', { text: 'Comando rápido' }), el('p', { class: 'muted small', text: 'Escreva como falaria: "pausar nutella", "voltou o kitkat".' }), form);
  }

  function storeBox(catalog) {
    const paused = catalog.settings.storePaused;
    const btn = el('button', { class: 'btn block ' + (paused ? 'primary' : 'danger'), type: 'button', text: paused ? 'Reabrir a loja' : 'Pausar loja inteira', on: { click: async () => {
      const ok = await DG.confirm(paused ? 'Reabrir a loja e voltar a aceitar pedidos?' : 'Pausar a loja inteira? Os clientes não conseguirão pedir até você reabrir.', paused ? 'Reabrir' : 'Pausar loja', !paused);
      if (!ok) return;
      if (await DG.run(() => DG.api('store_save', { body: { store_paused: !paused } }), paused ? 'Loja aberta.' : 'Loja pausada.')) DG.reload();
    } } });
    return el('div', { class: 'card stack' }, el('div', { class: 'row between' }, el('strong', { text: 'Loja' }), el('span', { class: 'pill ' + (paused ? 'warn' : 'ok'), text: paused ? 'Pausada' : 'Aberta' })), btn);
  }

  function toggleRow(label, sub, checked, onChange, extra) {
    return el('div', { class: 'card' }, el('div', { class: 'row' },
      el('div', { class: 'grow' }, el('strong', { class: 'wrap', text: label }), sub ? el('p', { class: 'muted small wrap', text: sub }) : null),
      extra || null, DG.switchEl(checked, label, onChange, true)));
  }

  function linksSheet(product, catalog) {
    DG.sheet(product.name, (body) => {
      const links = catalog.links.filter(l => l.product_id === product.id).map(l => ({ l, c: catalog.complements.find(c => c.id === l.complement_id) })).filter(x => x.c);
      body.append(el('p', { class: 'muted small', text: 'Pause um complemento só neste produto.' }),
        ...(links.length ? links.map(({ l, c }) => toggleRow(c.name, DG.money(c.price_cents), !l.paused, async next =>
          !!(await DG.run(() => DG.api('link_toggle', { body: { product_id: product.id, complement_id: c.id, paused: !next } }))) && ((l.paused = !next), true))) : [el('p', { class: 'muted', text: 'Sem complementos.' })]));
    });
  }

  DG.tabs.pause = {
    async render(view) {
      const catalog = await DG.loadCatalog();
      DG.setStoreBadge(catalog.settings.storePaused);
      const search = el('input', { class: 'search', type: 'search', placeholder: 'Buscar produto ou complemento', maxlength: 60, value: st.search, 'aria-label': 'Buscar' });
      const list = el('div', {});
      const pinned = new Set(catalog.pinned);
      const paint = () => {
        const term = st.search.trim().toLowerCase();
        const has = n => !term || n.toLowerCase().includes(term);
        const comps = catalog.complements.filter(c => has(c.name)).sort((a, b) => (pinned.has(b.id) - pinned.has(a.id)) || (pinned.has(a.id) && pinned.has(b.id) ? catalog.pinned.indexOf(a.id) - catalog.pinned.indexOf(b.id) : 0) || (b.uses - a.uses) || a.name.localeCompare(b.name));
        const prods = catalog.products.filter(p => has(p.name));
        list.replaceChildren(
          el('h2', { class: 'section-title', text: 'Complementos (em todos os produtos)' }),
          ...(comps.length ? comps.map(c => toggleRow(c.name, 'em ' + c.uses + ' produto(s)' + (pinned.has(c.id) ? ' - fixado' : ''), c.active,
            async next => !!(await DG.run(() => DG.api('complement_toggle', { body: { id: c.id, active: next } }))) && ((c.active = next), true),
            el('button', { class: 'btn small', type: 'button', 'aria-label': (pinned.has(c.id) ? 'Desafixar ' : 'Fixar ') + c.name, 'aria-pressed': String(pinned.has(c.id)), text: pinned.has(c.id) ? '★' : '☆', on: { click: async () => {
              const r = await DG.run(() => DG.api('pin_toggle', { body: { complement_id: c.id, pinned: !pinned.has(c.id) } }));
              if (r) { catalog.pinned = r.pinned; pinned.clear(); r.pinned.forEach(x => pinned.add(x)); paint(); }
            } } }))) : [el('p', { class: 'muted', text: 'Nenhum complemento.' })]),
          el('h2', { class: 'section-title', text: 'Produtos' }),
          ...(prods.length ? prods.map(p => toggleRow(p.name, DG.money(p.price_cents), p.active,
            async next => !!(await DG.run(() => DG.api('product_toggle', { body: { id: p.id, active: next } }))) && ((p.active = next), true),
            el('button', { class: 'btn small', type: 'button', text: 'Extras', 'aria-label': 'Complementos de ' + p.name, on: { click: () => linksSheet(p, catalog) } }))) : [el('p', { class: 'muted', text: 'Nenhum produto.' })]));
      };
      search.addEventListener('input', () => { st.search = search.value; paint(); });
      view.replaceChildren(commandBox(), storeBox(catalog), search, list);
      paint();
    }
  };
})();
