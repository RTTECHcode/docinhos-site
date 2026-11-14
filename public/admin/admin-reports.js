'use strict';
/* Tela Relatórios (v4 N5, só administrador): Vendas (período, resumo e tabelas) e Clientes (busca, ordem, páginas).
   Tudo é calculado no servidor. Planilhas (CSV) baixadas com fetch + blob. Nada de dado de cliente no console. */
(function () {
  const DG = window.DG;
  const { el } = DG;
  const st = { view: 'sales', from: '', to: '', s: '', sort: 'spent', dir: 'desc', page: 1 };
  const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  const SORTS = [['spent', 'Total gasto'], ['paid_orders', 'Pedidos pagos'], ['last_order', 'Último pedido'], ['points', 'Pontos'], ['name', 'Nome']];
  const GIFT = { pending: ['Mimo pendente', 'warn'], delivered: ['Mimo entregue', 'ok'], cancelled: ['Mimo cancelado', 'off'] };
  const pct = x => (x * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%';
  const int = n => Number(n || 0).toLocaleString('pt-BR');
  const addDays = (day, n) => { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const dayBR = day => (day ? day.split('-').reverse().join('/') : '');

  // Baixa o CSV (resposta não é JSON). Erro vem em JSON normal.
  async function downloadCsv(action, query, btn) {
    btn.disabled = true;
    try {
      let res;
      try { res = await fetch('/api/admin?' + new URLSearchParams({ a: action, ...query }).toString(), { credentials: 'same-origin', cache: 'no-store' }); } catch { throw new Error('Sem conexão. Tente de novo.'); }
      if (!res.ok) {
        let d = {};
        try { d = await res.json(); } catch { /* corpo vazio */ }
        throw new Error(res.status === 401 ? 'Sessão expirada. Entre de novo.' : (d.error || 'Não consegui gerar a planilha.'));
      }
      const blob = await res.blob();
      const m = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '');
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: m ? m[1] : action + '.csv', hidden: true });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      DG.toast('Planilha baixada.');
    } catch (e) { DG.toast(e.message, true); }
    btn.disabled = false;
  }

  // Tabela simples, com rolagem horizontal no celular. cols: [{ t: título, num: alinhado à direita }]
  function table(caption, cols, rows, emptyText) {
    if (!rows.length) return el('div', { class: 'card' }, el('strong', { text: caption }), DG.empty(emptyText || 'Nada no período.'));
    return el('div', { class: 'card rep-box', role: 'region', 'aria-label': caption, tabindex: 0 },
      el('table', { class: 'rep-table' },
        el('caption', { text: caption }),
        el('thead', {}, el('tr', {}, ...cols.map(c => el('th', { scope: 'col', class: c.num ? 'num' : null, text: c.t })))),
        el('tbody', {}, ...rows.map(r => el('tr', {}, ...r.map((v, i) => i === 0 ? el('th', { scope: 'row', text: String(v) }) : el('td', { class: cols[i].num ? 'num' : null, text: String(v) })))))));
  }
  const tile = (label, value, sub) => el('div', { class: 'rep-tile' }, el('span', { class: 'rep-tile-l', text: label }), el('strong', { class: 'rep-tile-v', text: value }), sub ? el('span', { class: 'muted small', text: sub }) : null);

  // ---------- Vendas ----------
  function salesView(box) {
    const today = DG.todaySP();
    if (!st.to) st.to = today;
    if (!st.from) st.from = addDays(today, -29);
    const from = el('input', { type: 'date', value: st.from, max: today });
    const to = el('input', { type: 'date', value: st.to, max: today });
    const out = el('div', { class: 'stack' });
    const csv = el('button', { class: 'btn block', type: 'button', text: 'Baixar planilha de vendas (CSV)' });
    csv.addEventListener('click', () => downloadCsv('report_sales_csv', { from: st.from, to: st.to }, csv));
    const quick = (label, f, t) => el('button', { class: 'chip', type: 'button', text: label, on: { click: () => { from.value = f; to.value = t; load(); } } });
    const monthStart = today.slice(0, 8) + '01';
    const load = async () => {
      if (!from.value || !to.value) { DG.toast('Escolha as duas datas.', true); return; }
      if (from.value > to.value) { DG.toast('A data inicial deve ser antes da final.', true); return; }
      st.from = from.value; st.to = to.value;
      out.replaceChildren(DG.loading('Calculando vendas...'));
      let r;
      try { r = (await DG.api('report_sales', { query: { from: st.from, to: st.to } })).report; } catch (e) { out.replaceChildren(el('p', { class: 'error wrap', text: e.message })); return; }
      if (DG.state.tab !== 'reports' || st.view !== 'sales') return;
      const pay = r.by_payment || {}, dl = r.by_delivery || {};
      const hours = (r.by_hour || []).filter(h => h.orders > 0);
      out.replaceChildren(
        el('p', { class: 'muted small wrap', text: 'De ' + dayBR(r.from) + ' a ' + dayBR(r.to) + ' (horário de São Paulo). Só pedidos pagos e não cancelados contam como venda.' }),
        el('div', { class: 'rep-tiles' },
          tile('Recebido (líquido)', DG.money(r.net_cents)),
          tile('Pedidos pagos', int(r.paid_orders)),
          tile('Ticket médio', DG.money(r.avg_ticket_cents)),
          tile('Bruto (produtos + frete)', DG.money(r.gross_cents)),
          tile('Frete', DG.money(r.delivery_fee_cents)),
          tile('Descontos', DG.money(r.discount_cents), r.coupon_discount_cents ? DG.money(r.coupon_discount_cents) + ' em cupons' : null),
          tile('Pontos do Clube usados', int(r.club_points_spent)),
          tile('Pedidos não pagos', int(r.unpaid_orders), pct(r.unpaid_rate || 0) + ' de ' + int(r.total_orders))),
        table('Pix x cartão', [{ t: 'Forma' }, { t: 'Pedidos', num: 1 }, { t: 'Recebido', num: 1 }],
          [['Pix', int((pay.pix || {}).orders), DG.money((pay.pix || {}).net_cents || 0)], ['Cartão', int((pay.card || {}).orders), DG.money((pay.card || {}).net_cents || 0)]]),
        table('Entrega x retirada', [{ t: 'Como' }, { t: 'Pedidos', num: 1 }, { t: 'Recebido', num: 1 }],
          [['Entrega', int((dl.delivery || {}).orders), DG.money((dl.delivery || {}).net_cents || 0)], ['Retirada', int((dl.pickup || {}).orders), DG.money((dl.pickup || {}).net_cents || 0)]]),
        table('Produtos mais vendidos', [{ t: 'Produto' }, { t: 'Qtd.', num: 1 }, { t: 'Receita', num: 1 }, { t: 'Prêmios', num: 1 }],
          (r.top_products || []).map(p => [p.name, int(p.qty), DG.money(p.revenue_cents), int(p.reward_qty)]), 'Nenhum produto vendido no período.'),
        table('Por dia da semana', [{ t: 'Dia' }, { t: 'Pedidos', num: 1 }, { t: 'Recebido', num: 1 }],
          (r.by_weekday || []).map(w => [WEEKDAYS[w.weekday] || w.weekday, int(w.orders), DG.money(w.net_cents)])),
        table('Por hora (só horas com pedido)', [{ t: 'Hora' }, { t: 'Pedidos', num: 1 }, { t: 'Recebido', num: 1 }],
          hours.map(h => [String(h.hour).padStart(2, '0') + ':00', int(h.orders), DG.money(h.net_cents)]), 'Nenhum pedido pago no período.'),
        table('Por dia', [{ t: 'Dia' }, { t: 'Pagos', num: 1 }, { t: 'Bruto', num: 1 }, { t: 'Frete', num: 1 }, { t: 'Descontos', num: 1 }, { t: 'Recebido', num: 1 }],
          (r.by_day || []).map(d => [dayBR(d.day), int(d.paid_orders), DG.money(d.gross_cents), DG.money(d.delivery_fee_cents), DG.money(d.discount_cents), DG.money(d.net_cents)]), 'Nenhum dia com venda no período.'),
        csv);
    };
    from.addEventListener('change', load);
    to.addEventListener('change', load);
    box.replaceChildren(
      el('div', { class: 'grid2' }, el('label', { class: 'field' }, el('span', { text: 'De' }), from), el('label', { class: 'field' }, el('span', { text: 'Até' }), to)),
      el('div', { class: 'chips', role: 'group', 'aria-label': 'Períodos rápidos' },
        quick('Hoje', today, today), quick('7 dias', addDays(today, -6), today), quick('30 dias', addDays(today, -29), today), quick('Este mês', monthStart, today)),
      out);
    load();
  }

  // ---------- Clientes ----------
  function giftButtons(c, reload) {
    if (c.gift_status === 'pending' && c.gift_pending_id) {
      return el('button', { class: 'btn small danger', type: 'button', text: 'Cancelar mimo', 'aria-label': 'Cancelar mimo de ' + c.name, on: { click: async function () {
        if (!(await DG.confirm('Cancelar o mimo pendente de ' + c.name + '?', 'Cancelar mimo', true))) return;
        this.disabled = true;
        if (await DG.run(() => DG.api('gift_cancel', { body: { id: c.gift_pending_id } }), 'Mimo cancelado.')) reload(); else this.disabled = false;
      } } });
    }
    return el('button', { class: 'btn small', type: 'button', text: 'Avaliou: dar mimo', 'aria-label': 'Dar mimo para ' + c.name + ' (avaliou no Google)', on: { click: async function () {
      if (!(await DG.confirm(c.name + ' avaliou a loja no Google? O mimo aparece no próximo pedido desse telefone.', 'Dar mimo'))) return;
      this.disabled = true;
      if (await DG.run(() => DG.api('gift_grant', { body: { phone: c.phone_key } }), 'Mimo registrado.')) reload(); else this.disabled = false;
    } } });
  }

  function customerCard(c, reload) {
    const g = GIFT[c.gift_status];
    return el('div', { class: 'card stack rep-cust' },
      el('div', { class: 'row between' }, el('strong', { class: 'wrap grow', text: c.name || 'Sem nome' }), el('span', { class: 'muted small', text: c.phone || '' })),
      el('div', { class: 'row wrap-row' },
        el('span', { class: 'pill ' + (c.has_account ? '' : 'off'), text: c.has_account ? 'Com conta' : 'Visitante' }),
        c.whatsapp_consent ? el('span', { class: 'pill ok', text: 'Aceita WhatsApp' }) : null,
        g ? el('span', { class: 'pill ' + g[1], text: g[0] }) : null),
      el('dl', { class: 'kv' },
        el('dt', { text: 'Pedidos pagos' }), el('dd', { text: int(c.paid_orders) }),
        el('dt', { text: 'Total gasto' }), el('dd', { text: DG.money(c.spent_cents) }),
        el('dt', { text: 'Último pedido' }), el('dd', { text: c.last_order_at ? DG.fmtDay(c.last_order_at) : '-' }),
        el('dt', { text: 'Pontos' }), el('dd', { text: c.has_account ? int(c.points_balance) : '-' })),
      giftButtons(c, reload));
  }

  function customersView(box) {
    const search = el('input', { class: 'search', type: 'search', placeholder: 'Buscar por nome ou telefone', maxlength: 60, value: st.s, 'aria-label': 'Buscar cliente' });
    const sort = el('select', {}, ...SORTS.map(([k, t]) => el('option', { value: k, text: t, selected: k === st.sort })));
    const dir = el('select', {}, el('option', { value: 'desc', text: 'Maior / mais novo primeiro', selected: st.dir === 'desc' }), el('option', { value: 'asc', text: 'Menor / mais antigo primeiro', selected: st.dir === 'asc' }));
    const list = el('div', { class: 'rep-cust-list' });
    const pager = el('div', { class: 'row between rep-pager' });
    const csvMasked = el('button', { class: 'btn block', type: 'button', text: 'Baixar planilha de clientes (telefone escondido)' });
    const csvFull = el('button', { class: 'btn block', type: 'button', text: 'Baixar com telefone completo' });
    const csvQuery = () => { const q = { sort: st.sort, dir: st.dir }; if (st.s) q.s = st.s; return q; };
    csvMasked.addEventListener('click', () => downloadCsv('report_customers_csv', csvQuery(), csvMasked));
    csvFull.addEventListener('click', async () => {
      if (!(await DG.confirm('A planilha terá o telefone completo dos clientes (dado pessoal). Guarde em lugar seguro e apague quando não precisar mais.', 'Baixar mesmo assim'))) return;
      downloadCsv('report_customers_csv', { ...csvQuery(), pii: '1' }, csvFull);
    });
    const load = async () => {
      st.s = search.value.trim(); st.sort = sort.value; st.dir = dir.value;
      list.replaceChildren(DG.loading('Carregando clientes...'));
      const query = { sort: st.sort, dir: st.dir, page: st.page };
      if (st.s) query.s = st.s;
      let r;
      try { r = (await DG.api('report_customers', { query })).report; } catch (e) { list.replaceChildren(el('p', { class: 'error wrap', text: e.message })); pager.replaceChildren(); return; }
      if (DG.state.tab !== 'reports' || st.view !== 'customers') return;
      list.replaceChildren(...(r.customers.length ? r.customers.map(c => customerCard(c, load)) : [DG.empty(st.s ? 'Nenhum cliente com essa busca.' : 'Nenhum cliente ainda.')]));
      const go = n => { st.page = n; load(); window.scrollTo(0, 0); };
      pager.replaceChildren(
        el('button', { class: 'btn small', type: 'button', text: 'Anterior', disabled: r.page <= 1, on: { click: () => go(r.page - 1) } }),
        el('span', { class: 'muted small', text: 'Página ' + r.page + ' de ' + Math.max(1, r.total_pages) + ' - ' + int(r.total) + ' cliente(s)' }),
        el('button', { class: 'btn small', type: 'button', text: 'Próxima', disabled: r.page >= r.total_pages, on: { click: () => go(r.page + 1) } }));
    };
    const refilter = () => { st.page = 1; load(); };
    let debounce = null;
    search.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(refilter, 400); });
    sort.addEventListener('change', refilter);
    dir.addEventListener('change', refilter);
    box.replaceChildren(search,
      el('div', { class: 'grid2' }, el('label', { class: 'field' }, el('span', { text: 'Ordenar por' }), sort), el('label', { class: 'field' }, el('span', { text: 'Ordem' }), dir)),
      el('p', { class: 'muted small wrap', text: 'Uma linha por telefone (cliente com conta ou visitante). "Avaliou: dar mimo" registra um mimo para o próximo pedido desse telefone.' }),
      list, pager, csvMasked, csvFull);
    load();
  }

  DG.tabs.reports = {
    async render(view) {
      if (!DG.isAdmin()) { view.replaceChildren(el('p', { class: 'error', text: 'Só o administrador vê os relatórios.' })); return; }
      const box = el('div', { class: 'stack' });
      const seg = el('div', { class: 'chips', role: 'tablist', 'aria-label': 'Tipo de relatório' });
      const paint = () => {
        seg.replaceChildren(...[['sales', 'Vendas'], ['customers', 'Clientes']].map(([k, t]) => el('button', { class: 'chip', type: 'button', role: 'tab', 'aria-selected': String(st.view === k), 'aria-pressed': String(st.view === k), text: t,
          on: { click: () => { if (st.view === k) return; st.view = k; paint(); } } })));
        if (st.view === 'sales') salesView(box); else customersView(box);
      };
      view.replaceChildren(seg, box);
      paint();
    }
  };
})();
