'use strict';
/* Aba Pausa rápida: comando (ingrediente com prévia, desfazer e lotes), fechar/reabrir loja, produtos e complementos. */
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

  // ---- M2: pausa/reativação por ingrediente (prévia + confirmação + desfazer) ----
  const words = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const PAUSE_V = new Set(['pausar', 'pausa', 'pause', 'acabou', 'acabar', 'acabaram', 'acaba', 'esgotou', 'esgotaram', 'sem', 'faltou', 'falta', 'tirar', 'tira', 'desativar']);
  const RESUME_V = new Set(['reativar', 'reativa', 'reative', 'voltar', 'volta', 'voltou', 'tem', 'temos', 'liberar', 'libera', 'chegou', 'chegaram', 'repor']);
  const FILLER = new Set(['o', 'a', 'os', 'as', 'de', 'do', 'da', 'dos', 'das', 'um', 'uma', 'pra', 'para', 'por', 'que', 'ja', 'agora', 'favor', 'mais']);
  const SCOPED = new Set(['no', 'na', 'nos', 'nas', 'em', 'loja', 'todos', 'todas', 'tudo', 'categoria']);

  // Só trata como ingrediente textos curtos ("morango", "acabou o morango"). O resto vai ao comando antigo.
  function ingredientTerm(text) {
    const w = words(text);
    if (!w.length || w.some(t => RESUME_V.has(t) || SCOPED.has(t))) return null;
    const rest = w.filter(t => !PAUSE_V.has(t) && !FILLER.has(t));
    if (!rest.length || rest.length > 2) return null;
    return rest.join(' ');
  }

  function listNames(items, kind) {
    return el('ul', { class: 'a5-list' }, ...items.map(i => el('li', { class: 'wrap', text: i.name + (kind === 'keep' && i.held_by && i.held_by.length ? ' (continua pausado até liberar: ' + i.held_by.join(', ') + ')' : '') })));
  }

  function resumePreviewView(r, out, after) {
    if (!r.batches || !r.batches.length) {
      out.replaceChildren(el('p', { class: 'wrap', text: r.message || 'Não há pausa em lote aberta para esse ingrediente.' }));
      return;
    }
    const sum = r.summary || {};
    out.replaceChildren(
      el('p', { class: 'muted small', text: 'Reativar "' + r.term + '": confira.' }),
      r.will_resume.length ? el('div', { class: 'card stack' }, el('strong', { text: 'Voltam a ficar disponíveis (' + r.will_resume.length + ')' }), listNames(r.will_resume)) : el('p', { class: 'muted', text: 'Nada volta agora.' }),
      r.keep_paused.length ? el('div', { class: 'card stack' }, el('strong', { text: 'Continuam pausados (' + r.keep_paused.length + ')' }), listNames(r.keep_paused, 'keep')) : null,
      sum.already_active ? el('p', { class: 'muted small', text: sum.already_active + ' item(ns) já estava(m) ativo(s).' }) : null,
      el('div', { class: 'grid2' },
        el('button', { class: 'btn', type: 'button', text: 'Cancelar', on: { click: () => out.replaceChildren() } }),
        el('button', { class: 'btn primary', type: 'button', text: 'Confirmar', on: { click: async function () {
          this.disabled = true;
          const a = await DG.run(() => DG.api('resume_apply', { body: { term: r.term, confirm: true } }), 'Pronto! Itens reativados.');
          if (a) { out.replaceChildren(el('p', { class: 'wrap', text: 'Reativado: ' + (a.products_resumed || 0) + ' produto(s) e ' + (a.links_resumed || 0) + ' complemento(s).' })); after(); } else this.disabled = false;
        } } })));
  }

  function pausePreviewView(r, out, after) {
    const products = r.products || [], comps = r.complements || [];
    if (!products.length && !comps.length) { out.replaceChildren(el('p', { class: 'wrap', text: 'Não achei "' + r.term + '" em nenhum produto ou complemento.' })); return; }
    const prodBoxes = [], linkBoxes = [];
    const label = el('input', { type: 'text', maxlength: 60, placeholder: 'Ex.: sem ' + r.term + ' hoje' });
    const check = (checked, disabled) => el('input', { type: 'checkbox', checked: checked, disabled: disabled });
    const prodRows = products.map(p => {
      const c = check(!p.builder && !p.paused && p.active !== false, p.paused);
      prodBoxes.push({ c, id: p.id });
      return el('label', { class: 'a5-check' }, c, el('span', { class: 'wrap grow' }, el('strong', { text: p.name }),
        el('span', { class: 'muted small', text: ' (' + p.matched_in + ')' + (p.paused ? ' - já pausado' : '') + (p.builder ? ' - "monte seu": o certo é pausar só a opção abaixo' : '') })));
    });
    const compRows = comps.map(cp => el('div', { class: 'card stack' }, el('strong', { class: 'wrap', text: cp.name }),
      ...cp.links.map(l => {
        const c = check(!l.paused, l.paused);
        linkBoxes.push({ c, product_id: l.product_id, complement_id: cp.id });
        return el('label', { class: 'a5-check' }, c, el('span', { class: 'wrap grow', text: 'em ' + l.product_name + (l.group_label ? ' / ' + l.group_label : '') + (l.paused ? ' - já pausado' : '') }));
      }),
      cp.links.length ? null : el('p', { class: 'muted small', text: 'Sem vínculo com produtos.' })));
    const apply = el('button', { class: 'btn primary', type: 'button', text: 'Pausar' });
    apply.addEventListener('click', async () => {
      const product_ids = prodBoxes.filter(x => x.c.checked).map(x => x.id);
      const links = linkBoxes.filter(x => x.c.checked).map(x => ({ product_id: x.product_id, complement_id: x.complement_id }));
      if (!product_ids.length && !links.length) { DG.toast('Marque pelo menos um item.', true); return; }
      apply.disabled = true;
      const body = { term: r.term, confirm: true, product_ids, links };
      if (label.value.trim()) body.pause_label = label.value.trim();
      const a = await DG.run(() => DG.api('pause_apply', { body }));
      if (!a) { apply.disabled = false; return; }
      after();
      const done = [el('p', { class: 'wrap', text: a.batch_id ? 'Pausado: ' + a.products_changed + ' produto(s) e ' + a.links_changed + ' complemento(s).' : 'Nada mudou: tudo já estava pausado.' })];
      for (const w of a.warnings || []) done.push(el('p', { class: 'a5-warn wrap', text: 'Atenção: ' + w.message }));
      if (a.batch_id) {
        done.push(el('button', { class: 'btn block', type: 'button', text: 'Desfazer', on: { click: async function () {
          this.disabled = true;
          const u = await DG.run(() => DG.api('pause_undo', { body: { batch_id: a.batch_id } }), 'Pausa desfeita.');
          if (u) { out.replaceChildren(el('p', { text: 'Pausa de "' + a.term + '" desfeita.' })); after(); } else this.disabled = false;
        } } }));
      }
      out.replaceChildren(...done);
    });
    out.replaceChildren(
      el('p', { class: 'muted small', text: 'Pausar "' + r.term + '": marque o que vale e confirme.' }),
      prodRows.length ? el('div', { class: 'card stack' }, el('strong', { text: 'Produtos' }), ...prodRows) : null,
      ...compRows,
      el('label', { class: 'field' }, el('span', { text: 'Etiqueta nos produtos pausados (opcional)' }), label),
      el('div', { class: 'grid2' }, el('button', { class: 'btn', type: 'button', text: 'Cancelar', on: { click: () => out.replaceChildren() } }), apply));
  }

  // Lotes abertos, cada um com botão Reativar (prévia + confirmação).
  function batchesBox(after) {
    const box = el('div', {});
    const load = async () => {
      const r = await DG.api('pause_batches').catch(() => null);
      if (!r) { box.replaceChildren(); return; }
      if (!r.batches.length) { box.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'muted small', text: 'Nenhuma pausa por ingrediente aberta.' }))); return; }
      box.replaceChildren(...r.batches.map(b => {
        const out = el('div', { class: 'stack' });
        return el('div', { class: 'card stack' }, el('div', { class: 'row between' },
          el('div', { class: 'grow' }, el('strong', { class: 'wrap', text: b.term }), el('p', { class: 'muted small wrap', text: DG.fmtSP(b.created_at) + ' - ' + (b.created_by || '') + ' - ' + (b.products || 0) + ' produto(s), ' + (b.links || 0) + ' complemento(s)' })),
          el('button', { class: 'btn small', type: 'button', text: 'Reativar', on: { click: async function () {
            this.disabled = true;
            const p = await DG.run(() => DG.api('resume_preview', { body: { term: b.term } }));
            this.disabled = false;
            if (p) resumePreviewView(p, out, after);
          } } })), out);
      }));
    };
    box.load = load;
    return box;
  }

  // Comando rápido. Ingrediente simples usa a prévia por ingrediente (com sinônimos do servidor); "voltou X" abre a prévia de
  // lote quando existe; o resto segue o fluxo antigo (command / command_apply).
  function commandBox(after) {
    const input = el('input', { class: 'search', type: 'text', maxlength: 200, placeholder: 'Ex.: morango, voltou oreo, acabou o kitkat', autocapitalize: 'none', enterkeyhint: 'send', 'aria-label': 'Comando' });
    const out = el('div', { class: 'stack' });
    const run = async text => {
      const command = String(text === undefined ? input.value : text).trim();
      if (!command) { DG.toast('Escreva um comando.', true); return; }
      input.value = command;
      out.replaceChildren(el('p', { class: 'muted', text: 'Entendendo...' }));
      const term = ingredientTerm(command);
      if (term) {
        const p = await DG.api('pause_preview', { body: { term } }).catch(() => null);
        if (p && p.ok && ((p.products || []).length || (p.complements || []).length)) { pausePreviewView(p, out, after); return; }
      }
      const r = await DG.run(() => DG.api('command', { body: { text: command } }));
      if (!r) { out.replaceChildren(); return; }
      if (r.kind === 'ingredient_resume') resumePreviewView(r, out, after); else show(r);
    };
    const show = r => {
      if (r.ok && r.targets && r.targets.length) {
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
    return el('div', { class: 'card stack' }, el('strong', { text: 'Comando rápido' }),
      el('p', { class: 'muted small', text: 'Escreva o ingrediente ("morango", "oreo") para pausar, ou "voltou morango" para reativar.' }), form);
  }

  // ---- M1: loja (Fechar loja com prazo / Reabrir agora) ----
  function stateLine(s, manual) {
    if (s.open) return s.closes_at ? 'Aberta pelo horário. Fecha às ' + DG.timeSP(s.closes_at) + '.' : (s.schedule_configured ? 'Aberta pelo horário.' : 'Aberta.');
    if (s.reason === 'manual') {
      if (manual && manual.closed_indefinitely) return 'Fechada manualmente até você reabrir.';
      const until = (manual && manual.closed_until) || s.reopens_at;
      return until ? 'Fechada manualmente até ' + DG.fmtSP(until) + '.' : 'Fechada manualmente.';
    }
    return 'Fechada pelo horário.' + (s.next_open_at ? ' Abre ' + DG.fmtSP(s.next_open_at) + '.' : '');
  }

  function closeSheet(catalog, done) {
    DG.sheet('Fechar loja', (body, close) => {
      let choice = '30';
      const chips = el('div', { class: 'chips', role: 'group', 'aria-label': 'Prazo' });
      const OPTS = [['30', '30 min'], ['60', '1 h'], ['custom', 'Personalizado'], ['indef', 'Até eu reabrir']];
      const customBox = el('div', { class: 'stack', hidden: true });
      const mins = el('input', { type: 'number', min: 1, max: 1440, inputmode: 'numeric', placeholder: 'Ex.: 45' });
      const time = el('input', { type: 'time' });
      customBox.append(el('label', { class: 'field' }, el('span', { text: 'Fechar por quantos minutos (1 a 1440)' }), mins),
        el('p', { class: 'muted small', text: 'ou' }),
        el('label', { class: 'field' }, el('span', { text: 'Reabrir às (horário de São Paulo)' }), time));
      const paint = () => chips.replaceChildren(...OPTS.map(([k, t]) => el('button', { class: 'chip', type: 'button', text: t, 'aria-pressed': String(k === choice), on: { click: () => { choice = k; customBox.hidden = k !== 'custom'; paint(); } } })));
      paint();
      const msg = el('textarea', { maxlength: 200 });
      msg.value = catalog.settings.storePausedMessage || '';
      const go = el('button', { class: 'btn danger solid block', type: 'button', text: 'Fechar loja' });
      go.addEventListener('click', async () => {
        let payload;
        if (choice === 'indef') payload = { indefinite: true };
        else if (choice === 'custom') {
          const m = mins.value ? Number(mins.value) : (time.value ? DG.minutesUntilSP(time.value) : NaN);
          if (!Number.isInteger(m) || m < 1 || m > 1440) { DG.toast('Informe de 1 a 1440 minutos ou um horário.', true); return; }
          payload = { minutes: m };
        } else payload = { minutes: Number(choice) };
        payload.message = msg.value.trim();
        go.disabled = true;
        if (payload.message !== (catalog.settings.storePausedMessage || '')) {
          const sv = await DG.api('store_save', { body: { store_paused_message: payload.message } }).catch(() => null);
          if (sv) catalog.settings.storePausedMessage = sv.settings.storePausedMessage;
        }
        const r = await DG.run(() => DG.api('store_close', { body: payload }), 'Loja fechada.');
        if (r) { close(); done(); } else go.disabled = false;
      });
      body.append(el('p', { class: 'muted small', text: 'Por quanto tempo a loja fica fechada? Os clientes não conseguem pedir.' }), chips, customBox,
        el('label', { class: 'field' }, el('span', { text: 'Mensagem para os clientes' }), msg), go);
    });
  }

  function storeBox(catalog) {
    const box = el('div', { class: 'card stack' }, el('p', { class: 'muted', text: 'Carregando...' }));
    const load = async () => {
      const r = await DG.api('store_state').catch(() => null);
      if (!r) { box.replaceChildren(el('p', { class: 'error', text: 'Não consegui ver o estado da loja.' })); return; }
      const s = r.state;
      DG.setStoreBadge(!s.open);
      const manualOn = !!(r.manual && (r.manual.closed_indefinitely || (r.manual.closed_until && new Date(r.manual.closed_until) > new Date())));
      box.replaceChildren(
        el('div', { class: 'row between' }, el('strong', { text: 'Loja' }), el('span', { class: 'pill ' + (s.open ? 'ok' : 'warn'), text: s.open ? 'Aberta' : 'Fechada' })),
        el('p', { class: 'wrap', text: stateLine(s, manualOn ? r.manual : null) }),
        s.open ? el('button', { class: 'btn danger block', type: 'button', text: 'Fechar loja', on: { click: () => closeSheet(catalog, load) } }) : null,
        manualOn ? el('button', { class: 'btn primary block', type: 'button', text: 'Reabrir agora', on: { click: async () => { if (await DG.run(() => DG.api('store_reopen', { body: {} }), 'Loja reaberta.')) load(); } } }) : null);
    };
    load();
    return box;
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
      let catalog = await DG.loadCatalog();
      const search = el('input', { class: 'search', type: 'search', placeholder: 'Buscar produto ou complemento', maxlength: 60, value: st.search, 'aria-label': 'Buscar' });
      const list = el('div', {});
      let pinned = new Set(catalog.pinned);
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
      // Depois de pausar/desfazer/reativar em lote: recarrega lotes e as listas de baixo sem apagar a prévia ou o botão Desfazer.
      const batches = batchesBox(() => after());
      const after = () => {
        batches.load();
        DG.api('catalog').then(c => { if (DG.state.tab === 'pause') { DG.state.catalog = c; catalog = c; pinned = new Set(c.pinned); paint(); } }).catch(() => {});
      };
      search.addEventListener('input', () => { st.search = search.value; paint(); });
      view.replaceChildren(commandBox(after), el('h2', { class: 'section-title', text: 'Pausas por ingrediente abertas' }), batches, storeBox(catalog), search, list);
      batches.load();
      paint();
    }
  };
})();
