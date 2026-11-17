'use strict';
/* Tela Clube (v4 N3): prêmios que o cliente troca por pontos e quantos pontos ganha por R$ 1,00.
   Sem apagar: prêmio sai do ar desligando. Toda validação é do servidor (a tela mostra a mensagem da API). */
(function () {
  const DG = window.DG;
  const { el } = DG;
  const STATE = { on: ['Ligado', 'ok'], off: ['Desligado', 'off'], scheduled: ['Começa depois', 'warn'], ended: ['Vigência acabou', 'off'] };
  const pts = n => (n === 1 ? '1 ponto' : Number(n).toLocaleString('pt-BR') + ' pontos');

  // Texto curto da vigência do prêmio.
  function windowText(r) {
    if (r.starts_at && r.ends_at) return 'De ' + DG.fmtDay(r.starts_at) + ' a ' + DG.fmtDay(r.ends_at);
    if (r.starts_at) return 'A partir de ' + DG.fmtDay(r.starts_at);
    if (r.ends_at) return 'Até ' + DG.fmtDay(r.ends_at);
    return 'Sem prazo';
  }
  // Por que um prêmio ligado não aparece para o cliente agora.
  function whyUnavailable(r) {
    if (!r.active || r.available) return null;
    if (r.product_active === false) return 'O produto está desativado no cardápio: o prêmio não aparece para o cliente.';
    if (r.product_paused) return 'O produto está pausado ("Volto logo"): o prêmio aparece, mas não dá para trocar agora.';
    if (r.state === 'scheduled' || r.state === 'ended') return null;
    return 'Indisponível agora (categoria desligada, tamanho fora do ar ou produto com escolha obrigatória).';
  }

  // ---------- regra de pontos (ligar/desligar e pontos por real) ----------
  function rulesCard(rules, onSaved) {
    const admin = DG.isAdmin();
    return el('div', { class: 'card stack' },
      el('div', { class: 'row between' }, el('strong', { text: 'Clube de pontos' }),
        el('span', { class: 'pill ' + (rules.enabled ? 'ok' : 'off'), text: rules.enabled ? 'Ligado' : 'Desligado' })),
      el('p', { class: 'wrap', text: 'O cliente ganha ' + pts(rules.points_per_real) + ' a cada R$ 1,00 pago (sem o frete) e troca os pontos pelos prêmios abaixo.' }),
      rules.enabled ? null : el('p', { class: 'a5-warn wrap', text: 'Desligado: ninguém ganha pontos novos nem troca prêmios. O saldo de cada cliente fica guardado.' }),
      admin ? el('button', { class: 'btn block', type: 'button', text: 'Editar pontos por real', on: { click: () => rulesSheet(rules, onSaved) } })
        : el('p', { class: 'muted small', text: 'Só o administrador muda o Clube.' }));
  }

  function rulesSheet(rules, onSaved) {
    DG.sheet('Pontos do Clube', async (body, close) => {
      body.append(DG.loading());
      let info;
      try { info = (await DG.api('points_get')).points; } catch (e) { body.replaceChildren(el('p', { class: 'error', text: e.message })); return; }
      const L = info.limits;
      const [min, max] = L.points_per_real;
      let enabled = info.rules.enabled;
      const stateTxt = el('span', { class: 'state ' + (enabled ? 'on' : 'off'), text: enabled ? 'Ligado' : 'Desligado' });
      const sw = DG.switchEl(enabled, 'Clube ligado', async next => {
        enabled = next; stateTxt.textContent = next ? 'Ligado' : 'Desligado'; stateTxt.className = 'state ' + (next ? 'on' : 'off'); return true;
      }, true);
      const per = DG.intField('Pontos ganhos a cada R$ 1,00 pago (' + min + ' a ' + max + ')', info.rules.points_per_real, min, max);
      const example = el('p', { class: 'muted small wrap', 'aria-live': 'polite' });
      const paint = () => {
        const n = DG.readInt(per.input, min, max, 'Pontos');
        example.textContent = typeof n === 'number' ? 'Exemplo: uma compra de R$ 50,00 rende ' + pts(50 * n) + '. Um prêmio de 100 pontos sai a cada ' + DG.money(Math.ceil(100 / n) * 100) + ' gastos.' : '';
      };
      per.input.addEventListener('input', paint);
      paint();
      const msg = el('p', { class: 'error wrap', role: 'alert', hidden: true });
      const save = el('button', { class: 'btn primary block', type: 'button', text: 'Salvar' });
      save.addEventListener('click', async () => {
        const n = DG.readInt(per.input, min, max, 'Pontos por R$ 1,00');
        if (typeof n !== 'number') { msg.textContent = n.problem; msg.hidden = false; return; }
        if (info.rules.enabled && !enabled && !(await DG.confirm('Desligar o Clube? Ninguém ganha pontos nem troca prêmios até você ligar de novo. O saldo fica guardado.', 'Desligar', true))) return;
        // points_save ainda pede a regra antiga de desconto (block_*), que não vale mais para pedido novo (v4 N3).
        // Mantém a gravada; se ela impedir o novo valor (limite de retorno do servidor), sobe só os pontos do bloco antigo.
        let block = info.rules.block_points;
        const value = info.rules.block_value_cents;
        const need = Math.ceil((n * value) / L.max_return_pct);
        if (need > block) block = Math.min(L.block_points[1], need);
        msg.hidden = true; save.disabled = true;
        try {
          await DG.api('points_save', { body: { enabled, points_per_real: n, block_points: block, block_value_cents: value } });
          DG.toast('Clube atualizado.');
          close(); onSaved();
        } catch (e) { msg.textContent = e.message; msg.hidden = false; save.disabled = false; }
      });
      body.replaceChildren(
        el('div', { class: 'card row between' }, el('div', { class: 'grow' }, el('strong', { text: 'Clube de pontos' }), el('p', {}, stateTxt)), sw),
        per.field, example,
        el('p', { class: 'muted small wrap', text: 'Vale para os próximos pagamentos aprovados. Pontos já ganhos não mudam. Prêmio do Clube não gera pontos.' }),
        msg, save);
    });
  }

  // ---------- prêmio: cadastro e edição ----------
  function rewardSheet(reward, onSaved) {
    DG.sheet(reward ? 'Editar prêmio' : 'Novo prêmio', async (body, close) => {
      body.append(DG.loading());
      let cat;
      try { cat = DG.state.catalog || await DG.loadCatalog(); } catch (e) { body.replaceChildren(el('p', { class: 'error', text: e.message })); return; }
      const catName = new Map(cat.categories.map(c => [c.id, c.name]));
      const sizesOf = pid => cat.links.filter(l => l.product_id === pid)
        .map(l => cat.complements.find(c => c.id === l.complement_id)).filter(c => c && c.kind === 'size' && c.active);
      const prods = cat.products.slice().sort((a, b) => String(catName.get(a.category_id) || '').localeCompare(String(catName.get(b.category_id) || '')) || a.name.localeCompare(b.name));
      const product = el('select', { required: true },
        el('option', { value: '', text: 'Escolha o produto' }),
        ...cat.categories.map(c => {
          const list = prods.filter(p => p.category_id === c.id);
          return list.length ? el('optgroup', { label: c.name }, ...list.map(p => el('option', { value: p.id, text: p.name + (p.active ? '' : ' (desativado)'), selected: reward && reward.product_id === p.id }))) : null;
        }));
      const size = el('select', {});
      const sizeField = el('label', { class: 'field' }, el('span', { text: 'Tamanho do prêmio' }), size);
      const paintSizes = () => {
        const list = sizesOf(Number(product.value));
        size.replaceChildren(el('option', { value: '', text: 'Escolha o tamanho' }), ...list.map(c => el('option', { value: c.id, text: c.name, selected: reward && reward.size_complement_id === c.id })));
        sizeField.hidden = !list.length;
      };
      product.addEventListener('change', paintSizes);
      paintSizes();
      const cost = DG.intField('Custo em pontos (1 a 100.000)', reward ? reward.points_cost : 100, 1, 100000);
      const maxPer = DG.intField('Máximo por pedido (1 a 10)', reward ? reward.max_per_order : 1, 1, 10);
      const sort = DG.intField('Ordem na lista (0 aparece primeiro)', reward ? reward.sort_order : 0, 0, 9999);
      const starts = el('input', { type: 'date', value: reward ? DG.daySP(reward.starts_at) : '' });
      const ends = el('input', { type: 'date', value: reward ? DG.daySP(reward.ends_at) : '' });
      const active = el('input', { type: 'checkbox', checked: reward ? reward.active : true });
      const msg = el('p', { class: 'error wrap', role: 'alert', hidden: true });
      const save = el('button', { class: 'btn primary block', type: 'submit', text: reward ? 'Salvar prêmio' : 'Criar prêmio' });
      const fail = t => { msg.textContent = t; msg.hidden = false; msg.scrollIntoView({ block: 'nearest' }); };
      const form = el('form', { class: 'stack', novalidate: true, on: { submit: async e => {
        e.preventDefault();
        msg.hidden = true;
        if (!product.value) return fail('Escolha o produto do prêmio.');
        const vals = [DG.readInt(cost.input, 1, 100000, 'Custo em pontos'), DG.readInt(maxPer.input, 1, 10, 'Máximo por pedido'), DG.readInt(sort.input, 0, 9999, 'Ordem')];
        const bad = vals.find(v => typeof v !== 'number');
        if (bad) return fail(bad.problem);
        if (starts.value && ends.value && ends.value < starts.value) return fail('O fim da vigência precisa ser depois do início.');
        const payload = { product_id: Number(product.value), points_cost: vals[0], max_per_order: vals[1], sort_order: vals[2],
          starts_at: starts.value || null, ends_at: ends.value || null, active: active.checked };
        if (!sizeField.hidden) payload.size_complement_id = size.value ? Number(size.value) : null;
        if (reward) payload.id = reward.id;
        save.disabled = true;
        try {
          await DG.api('club_reward_save', { body: payload });
          DG.toast(reward ? 'Prêmio salvo.' : 'Prêmio criado.');
          close(); onSaved();
        } catch (ex) { fail(ex.message); save.disabled = false; }
      } } },
      el('label', { class: 'field' }, el('span', { text: 'Produto' }), product), sizeField,
      el('p', { class: 'muted small wrap', text: 'Produto com escolha obrigatória (ex.: sabores) não pode ser prêmio.' }),
      el('div', { class: 'grid2' }, cost.field, maxPer.field),
      el('div', { class: 'grid2' }, el('label', { class: 'field' }, el('span', { text: 'Começa em (opcional)' }), starts), el('label', { class: 'field' }, el('span', { text: 'Termina em (opcional)' }), ends)),
      sort.field,
      el('label', { class: 'a5-check' }, active, el('span', { text: 'Prêmio ligado (aparece para os clientes)' })),
      msg, save);
      body.replaceChildren(form);
      product.focus();
    });
  }

  function rewardCard(r, reload) {
    const admin = DG.isAdmin();
    const [stTxt, stCls] = STATE[r.state] || [r.state, ''];
    const why = whyUnavailable(r);
    return el('div', { class: 'card stack club-card' },
      el('div', { class: 'row between' },
        el('div', { class: 'grow' }, el('strong', { class: 'wrap', text: r.product_name + (r.size_name ? ' (' + r.size_name + ')' : '') }),
          el('p', { class: 'muted small wrap', text: (r.category_name || '') })),
        admin ? DG.switchEl(r.active, (r.active ? 'Desligar ' : 'Ligar ') + r.product_name, async next => {
          try { await DG.api('club_reward_toggle', { body: { id: r.id, active: next } }); DG.toast(next ? 'Prêmio ligado.' : 'Prêmio desligado.'); reload(); return true; } catch (e) { DG.toast(e.message, true); return false; }
        }, true) : null),
      el('div', { class: 'row wrap-row' },
        el('span', { class: 'pill club-cost', text: pts(r.points_cost) }),
        el('span', { class: 'pill ' + stCls, text: stTxt }),
        el('span', { class: 'muted small', text: 'até ' + r.max_per_order + ' por pedido · ' + windowText(r) })),
      why ? el('p', { class: 'a5-warn wrap', text: why }) : null,
      admin ? el('button', { class: 'btn small', type: 'button', text: 'Editar', 'aria-label': 'Editar prêmio ' + r.product_name, on: { click: () => rewardSheet(r, reload) } }) : null);
  }

  DG.tabs.club = {
    async render(view) {
      const r = await DG.api('club_rewards');
      if (DG.state.tab !== 'club') return;
      const reload = () => { if (DG.state.tab === 'club') DG.tabs.club.render(view).catch(e => DG.toast(e.message, true)); };
      const list = r.rewards || [];
      view.replaceChildren(
        rulesCard(r.rules, reload),
        el('h2', { class: 'section-title', text: 'Prêmios (' + list.length + ')' }),
        el('p', { class: 'muted small wrap club-help', text: 'Dica: um prêmio de R$ 10,00 por 100 pontos devolve cerca de 10% do que o cliente gasta. Para tirar um prêmio do ar, desligue (não dá para apagar).' }),
        ...(list.length ? list.map(x => rewardCard(x, reload)) : [DG.empty('Nenhum prêmio cadastrado.')]),
        DG.isAdmin() ? el('button', { class: 'btn primary block', type: 'button', text: 'Novo prêmio', on: { click: () => rewardSheet(null, reload) } }) : null);
    }
  };
})();
