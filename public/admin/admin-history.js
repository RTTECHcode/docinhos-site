'use strict';
/* Aba Histórico (A5, M4): pedidos com mais de 24 h. Somente leitura, com filtros e paginação. */
(function () {
  const DG = window.DG;
  const { el } = DG;
  const STATUS = { new: 'Novo', accepted: 'Aceito', preparing: 'Em preparo', ready: 'Pronto', awaiting_delivery: 'Aguardando entrega', completed: 'Concluído', delivered: 'Concluído', cancelled: 'Cancelado' };
  const PAY = { approved: 'Pago', pending: 'Aguardando pagamento', in_process: 'Em análise', rejected: 'Recusado', cancelled: 'Cancelado', refunded: 'Reembolsado', expired: 'Expirado' };
  const METHOD = { pix: 'Pix', mercadopago: 'Mercado Pago', mercadopago_card: 'Cartão' };
  const FILTERS = [['', 'Todos'], ['completed', 'Concluídos'], ['cancelled', 'Cancelados'], ['paid', 'Pagos'], ['new', 'Novos'], ['accepted', 'Aceitos'], ['preparing', 'Em preparo'], ['ready', 'Prontos'], ['awaiting_delivery', 'Aguardando entrega']];
  const st = { from: '', to: '', f: '', s: '', page: 1 };

  const payClass = s => (s === 'approved' ? 'ok' : (s === 'pending' || s === 'in_process') ? 'warn' : 'off');
  const statusText = o => o.fulfillment_label || STATUS[o.fulfillment_status] || o.fulfillment_status;
  const fullDate = iso => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-');

  function card(o) {
    return el('button', { class: 'card item-btn', type: 'button', on: { click: () => detail(o) } },
      el('div', { class: 'row between' }, el('strong', { text: o.public_code || o.code }), el('span', { class: 'muted small', text: fullDate(o.created_at) })),
      el('div', { class: 'row between' }, el('span', { class: 'ellipsis grow', text: o.customer_name }), el('strong', { text: DG.money(o.total_cents) })),
      el('div', { class: 'row wrap-row' },
        el('span', { class: 'pill ' + payClass(o.payment_status), text: PAY[o.payment_status] || o.payment_status }),
        el('span', { class: 'pill off', text: statusText(o) }),
        el('span', { class: 'muted small', text: (o.delivery_method === 'pickup' ? 'Retirada' : 'Entrega') + (o.payment_method ? ' - ' + (METHOD[o.payment_method] || o.payment_method) : '') })));
  }

  function detail(o) {
    DG.sheet('Pedido ' + (o.public_code || o.code), (body, close) => {
      const items = Array.isArray(o.items) ? o.items : [];
      const rows = [['Cliente', o.customer_name], ['Telefone', o.customer_phone], ['Recebe', o.delivery_method === 'pickup' ? 'Retirada' : 'Entrega'], ['Endereço', o.address || '-'],
        ['Pagamento', (PAY[o.payment_status] || o.payment_status) + (o.payment_method ? ' (' + (METHOD[o.payment_method] || o.payment_method) + ')' : '')],
        ['Situação', statusText(o)], ['Feito em', fullDate(o.created_at)]];
      if (o.completed_at) rows.push(['Concluído em', fullDate(o.completed_at)]);
      if (o.cancelled_at) rows.push(['Cancelado em', fullDate(o.cancelled_at)]);
      if (o.cancel_reason) rows.push(['Motivo', o.cancel_reason]);
      if (o.distance_km) rows.push(['Distância', o.distance_km + ' km']);
      body.append(
        el('div', { class: 'card' }, el('dl', { class: 'kv' }, ...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: String(v) })]))),
        el('h3', { class: 'section-title', text: 'Itens' }),
        ...items.map(i => el('div', { class: 'card' },
          el('div', { class: 'row between' }, el('strong', { class: 'wrap', text: (i.qty || 1) + 'x ' + (i.name || '') }), el('span', { text: DG.money((i.unit_total_cents || 0) * (i.qty || 1)) })),
          i.size ? el('p', { class: 'muted small wrap', text: 'Tamanho: ' + i.size }) : null,
          Array.isArray(i.extras) && i.extras.length ? el('p', { class: 'muted small wrap', text: 'Extras: ' + i.extras.map(x => (x && x.name) || x).join(', ') }) : null)),
        o.notes ? el('div', { class: 'card' }, el('strong', { text: 'Observações' }), el('p', { class: 'wrap', text: o.notes })) : null,
        el('div', { class: 'card' },
          el('div', { class: 'row between' }, el('span', { text: 'Subtotal' }), el('span', { text: DG.money(o.subtotal_cents) })),
          el('div', { class: 'row between' }, el('span', { text: 'Entrega' }), el('span', { text: DG.money(o.delivery_fee_cents) })),
          o.discount_cents ? el('div', { class: 'row between' }, el('span', { text: 'Desconto' + (o.points_redeemed ? ' (' + o.points_redeemed + ' pontos)' : '') }), el('span', { text: '- ' + DG.money(o.discount_cents) })) : null,
          el('div', { class: 'row between' }, el('strong', { text: 'Total' }), el('strong', { text: DG.money(o.total_cents) }))),
        el('button', { class: 'btn block', type: 'button', text: 'Fechar', on: { click: close } }));
    });
  }

  DG.tabs.history = {
    async render(view) {
      const from = el('input', { type: 'date', value: st.from, 'aria-label': 'Data inicial' });
      const to = el('input', { type: 'date', value: st.to, 'aria-label': 'Data final' });
      const sel = el('select', { 'aria-label': 'Status' }, ...FILTERS.map(([k, t]) => el('option', { value: k, text: t, selected: k === st.f })));
      const search = el('input', { class: 'search', type: 'search', placeholder: 'Buscar por código ou nome', maxlength: 60, value: st.s, 'aria-label': 'Buscar pedido' });
      const list = el('div', {});
      const pager = el('div', { class: 'row between' });
      const load = async () => {
        if (from.value && to.value && from.value > to.value) { DG.toast('A data inicial deve ser antes da final.', true); return; }
        st.from = from.value; st.to = to.value; st.f = sel.value; st.s = search.value.trim();
        list.replaceChildren(el('p', { class: 'muted', text: 'Carregando...' }));
        const query = { page: st.page, page_size: 20 };
        if (st.from) query.from = st.from;
        if (st.to) query.to = st.to;
        if (st.f) query.f = st.f;
        if (st.s) query.s = st.s;
        let r;
        try { r = await DG.api('order_history', { query }); } catch (e) { list.replaceChildren(el('p', { class: 'error', text: e.message })); pager.replaceChildren(); return; }
        if (DG.state.tab !== 'history') return;
        list.replaceChildren(...(r.orders.length ? r.orders.map(card) : [el('p', { class: 'muted', text: 'Nenhum pedido antigo encontrado.' })]));
        const pages = Math.max(1, r.total_pages || 1);
        const go = n => { st.page = n; load(); window.scrollTo(0, 0); };
        pager.replaceChildren(
          el('button', { class: 'btn small', type: 'button', text: 'Anterior', disabled: r.page <= 1, on: { click: () => go(r.page - 1) } }),
          el('span', { class: 'muted small', text: 'Página ' + r.page + ' de ' + pages + ' - ' + r.total + ' pedido(s)' }),
          el('button', { class: 'btn small', type: 'button', text: 'Próxima', disabled: r.page >= pages, on: { click: () => go(r.page + 1) } }));
      };
      const refilter = () => { st.page = 1; load(); };
      let debounce = null;
      search.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(refilter, 350); });
      from.addEventListener('change', refilter); to.addEventListener('change', refilter); sel.addEventListener('change', refilter);
      view.replaceChildren(
        el('p', { class: 'muted small', text: 'Pedidos com mais de 24 horas. Só leitura.' }),
        el('div', { class: 'grid2' }, el('label', { class: 'field' }, el('span', { text: 'De' }), from), el('label', { class: 'field' }, el('span', { text: 'Até' }), to)),
        el('label', { class: 'field' }, el('span', { text: 'Status' }), sel), search, el('div', { class: 'a5-gap' }), list, pager);
      await load();
    }
  };
})();
