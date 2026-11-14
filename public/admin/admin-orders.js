'use strict';
/* Aba Pedidos: kanban (aceite, preparo, entrega), atividade das últimas 24 h, busca, detalhe e mudança de status. Atualiza sozinha a cada 30 s. */
(function () {
  const { el, $ } = window.DG;
  const DG = window.DG;
  const STATUS = { new: 'Novo', accepted: 'Aceito', preparing: 'Em preparo', ready: 'Pronto', awaiting_delivery: 'Aguardando entrega', completed: 'Concluído', delivered: 'Concluído', cancelled: 'Cancelado' };
  const PAY = { approved: 'Pago', pending: 'Aguardando pagamento', in_process: 'Em análise', rejected: 'Recusado', cancelled: 'Cancelado', refunded: 'Reembolsado', expired: 'Expirado' };
  const METHOD = { pix: 'Pix', mercadopago: 'Mercado Pago', mercadopago_card: 'Cartão' };
  // v4 N1: as colunas usam status_key da API (pagamento + preparo). A antiga coluna "Novos" virou duas.
  const COLS = [
    { key: 'pay', title: 'Aguardando pagamento', short: 'A pagar', keys: ['awaiting_payment', 'payment_failed'] },
    { key: 'new', title: 'Pagos, aguardando aceite', short: 'Pagos', keys: ['received'] },
    { key: 'prep', title: 'Em preparo', short: 'Em preparo', keys: ['accepted', 'preparing'] },
    { key: 'wait', title: 'Aguardando entrega', short: 'Entrega', keys: ['ready', 'awaiting_delivery'] }
  ];
  const LS_ACT = 'dg_orders_activity_open';
  // filter: '' = quadro normal; 'scheduled' = só encomendas com data marcada, na ordem da data (a mais próxima primeiro), vinda do servidor.
  const st = { search: '', filter: '', timer: null, seen: null, orders: [], box: null, busy: new Set(), version: 0, reqSeq: 0, col: 'new', actOpen: lsGet() };

  function lsGet() { try { return localStorage.getItem(LS_ACT) !== '0'; } catch { return true; } }
  function lsSet(v) { try { localStorage.setItem(LS_ACT, v ? '1' : '0'); } catch { /* sem storage */ } }
  function isPickup(o) { return o.delivery_method === 'pickup'; }
  function waitLabel(o) { return isPickup(o) ? 'Aguardando retirada' : 'Aguardando entrega'; }
  // v4 N1: o rótulo vem pronto da API (status_label); o resto é só para pedidos antigos sem o campo.
  function statusText(o) {
    if (o.status_label) return o.status_label;
    const s = o.fulfillment_status;
    if (s === 'awaiting_delivery') return waitLabel(o);
    return STATUS[s] || o.fulfillment_label || s;
  }
  function whatsLink(phone, name, code) {
    let digits = String(phone).replace(/\D/g, '');
    if (digits.length <= 11) digits = '55' + digits;
    const text = 'Olá ' + String(name).split(' ')[0] + '! Aqui é da Docinhos da Gigi sobre o seu pedido ' + code + '.';
    return 'https://wa.me/' + digits + '?text=' + encodeURIComponent(text);
  }
  function codeOf(o) { return o.public_code || o.code; }
  function byId(id) { return st.orders.find(x => x.id === id); }

  async function fetchOrders() {
    const seq = ++st.reqSeq;
    const ver = st.version;
    const query = { s: st.search };
    if (st.filter) query.f = st.filter;
    const r = await DG.api('orders', { query });
    // resposta velha (outra busca depois, ou ação concluída no meio): descarta para não sobrescrever o estado mais novo
    if (seq !== st.reqSeq || ver !== st.version) return null;
    const prev = st.seen;
    st.orders = r.orders;
    const ids = new Set(r.orders.map(o => o.id));
    const fresh = prev ? new Set(r.orders.filter(o => !prev.has(o.id)).map(o => o.id)) : new Set();
    // lista filtrada (Agendados) é parcial: não vira a referência de "já vistos", senão os outros pareceriam novos depois
    if (!st.filter && (!st.search || !prev)) st.seen = ids;
    const dot = $('#orders-dot');
    if (dot) dot.hidden = !(fresh.size && DG.state.tab !== 'orders');
    return fresh;
  }
  async function refresh(showFresh) {
    let fresh = await fetchOrders();
    if (fresh === null) fresh = await fetchOrders();
    if (fresh === null) return null;
    renderAll(fresh);
    if (showFresh && fresh.size) DG.toast(fresh.size === 1 ? 'Chegou um pedido novo.' : 'Chegaram ' + fresh.size + ' pedidos novos.');
    return fresh;
  }

  // Muda o status achando o pedido pelo id no estado mais recente. Botões só ficam desabilitados durante a própria requisição.
  async function changeStatus(id, status, okMsg, reason) {
    if (st.busy.has(id)) return false;
    st.busy.add(id);
    renderAll();
    try {
      const body = { id, status };
      if (reason) body.reason = reason;
      const r = await DG.api('order_status', { body });
      st.version++;
      const cur = byId(id);
      if (cur && r.order) { cur.fulfillment_status = r.order.fulfillment_status; cur.fulfillment_label = r.order.fulfillment_label; if (r.order.status_key) { cur.status_key = r.order.status_key; cur.status_label = r.order.status_label; } }
      if (okMsg) DG.toast(okMsg);
      return true;
    } catch (e) {
      DG.toast(e.message || 'Não foi possível atualizar o pedido. Tente de novo.', true);
      return false;
    } finally {
      st.busy.delete(id);
      renderAll();
      refresh(false).catch(() => {});
    }
  }
  async function cancelOrder(o) {
    // v4: pedido já pago não é estornado pelo painel; a Gigi devolve o dinheiro no Mercado Pago.
    const paid = o.payment_status === 'approved';
    const ok = await DG.confirm('Cancelar o pedido ' + codeOf(o) + ' de ' + o.customer_name + '? Isso não pode ser desfeito.'
      + (paid ? ' Este pedido já foi pago: depois de cancelar, devolva o dinheiro pelo Mercado Pago (o painel não faz o estorno).' : ''), 'Cancelar pedido', true);
    if (!ok) return false;
    return changeStatus(o.id, 'cancelled', paid ? 'Pedido cancelado. Lembre de devolver o dinheiro no Mercado Pago.' : 'Pedido cancelado.');
  }

  // Aceitar (ou avançar) um pedido novo sem pagamento aprovado (Pix ou cartão ainda não pago) pede confirmação.
  // Pedido pago segue direto, como antes.
  async function confirmUnpaid(o, to) {
    if (!o || o.fulfillment_status !== 'new' || to === 'cancelled' || o.payment_status === 'approved') return true;
    return DG.confirm('O pagamento deste pedido ainda não foi aprovado. Aceitar mesmo assim?', 'Aceitar mesmo assim');
  }
  async function advance(id, act) {
    if (!(await confirmUnpaid(byId(id), act.to))) return false;
    return changeStatus(id, act.to, act.msg);
  }

  // P6: conferir no Mercado Pago um pedido com pagamento pendente (POST payment_check). Resultado em linguagem simples.
  const canCheckPay = o => (o.payment_status === 'pending' || o.payment_status === 'in_process') && o.fulfillment_status !== 'cancelled';
  function payCheckText(r) {
    const ps = r.order && r.order.payment_status;
    if (r.outcome === 'updated') return ps === 'approved' ? 'Pagamento aprovado, pedido atualizado.' : 'Pagamento atualizado: ' + (PAY[ps] || ps) + '.';
    if (r.outcome === 'unchanged') return ps === 'pending' || ps === 'in_process' ? 'Ainda pendente no Mercado Pago.' : 'Nada mudou: o pedido já estava igual ao Mercado Pago.';
    if (r.outcome === 'not_found') return 'Sem pagamento encontrado no Mercado Pago para este pedido.';
    return r.message || 'Conferência concluída.';
  }
  async function checkPayment(id) {
    if (st.busy.has(id)) return false;
    st.busy.add(id);
    renderAll();
    try {
      const r = await DG.api('payment_check', { body: { id } });
      st.version++;
      const cur = byId(id);
      if (cur && r.order) { cur.payment_status = r.order.payment_status; if (r.order.payment_method) cur.payment_method = r.order.payment_method; if (r.order.status_key) { cur.status_key = r.order.status_key; cur.status_label = r.order.status_label; } }
      DG.toast(payCheckText(r), !(r.outcome === 'updated' || r.outcome === 'unchanged' || r.outcome === 'not_found'));
      return true;
    } catch (e) {
      DG.toast(e.message || 'Não foi possível conferir o pagamento. Tente de novo.', true);
      return false;
    } finally {
      st.busy.delete(id);
      renderAll();
      refresh(false).catch(() => {});
    }
  }

  function nextAction(o) {
    switch (o.fulfillment_status) {
      case 'new': return { label: 'Aceitar', to: 'accepted', msg: 'Pedido aceito.' };
      case 'accepted': case 'preparing': return { label: 'Pedido pronto', to: 'ready', msg: 'Pedido pronto.' };
      case 'ready': return { label: isPickup(o) ? 'Marcar aguardando retirada' : 'Marcar aguardando entrega', to: 'awaiting_delivery', msg: waitLabel(o) + '.' };
      case 'awaiting_delivery': return { label: isPickup(o) ? 'Concluir (retirado)' : 'Concluir (entregue)', to: 'completed', msg: 'Pedido concluído.' };
      default: return null;
    }
  }

  function badges(o) {
    const km = o.distance_km !== null && o.distance_km !== undefined && !isPickup(o) && Number.isFinite(Number(o.distance_km))
      ? ' (' + Number(o.distance_km).toFixed(1).replace('.', ',') + ' km)' : '';
    return el('div', { class: 'row wrap-row' },
      DG.statusPill(o),
      el('span', { class: 'pill ord-how', text: (isPickup(o) ? 'Retirada' : 'Entrega') + km }),
      ...DG.orderFlags(o));
  }

  function kanbanCard(o, fresh) {
    const act = nextAction(o);
    const busy = st.busy.has(o.id);
    return el('div', { class: 'card ord-card' + (o.status_key === 'received' || fresh ? ' hl' : '') },
      el('button', { class: 'ord-main', type: 'button', on: { click: () => { const c = byId(o.id); if (c) openOrder(c); } } },
        el('div', { class: 'row between' },
          el('strong', { class: 'ellipsis grow', text: o.customer_name }),
          el('strong', { text: DG.money(o.total_cents) })),
        el('div', { class: 'row between' },
          el('span', { class: 'ord-code', text: codeOf(o) }),
          el('span', { class: 'muted small', text: DG.fmtDate(o.created_at) })),
        badges(o),
        el('span', { class: 'muted small', text: o.status_key === 'payment_failed' ? 'O cliente pode tentar pagar de novo.' : '' })),
      el('div', { class: 'ord-actions' },
        act ? el('button', { class: 'btn primary', type: 'button', text: act.label, disabled: busy, on: { click: () => advance(o.id, act) } }) : null,
        canCheckPay(o) ? el('button', { class: 'btn', type: 'button', text: 'Conferir pagamento', disabled: busy, on: { click: () => checkPayment(o.id) } }) : null,
        el('a', { class: 'btn', href: whatsLink(o.customer_phone, o.customer_name, codeOf(o)), target: '_blank', rel: 'noopener noreferrer', text: 'Chamar cliente no WhatsApp' }),
        el('button', { class: 'btn danger ord-cancel', type: 'button', text: 'Cancelar pedido', disabled: busy, on: { click: () => { const c = byId(o.id); if (c) cancelOrder(c); } } })));
  }

  function activityRow(o) {
    return el('button', { class: 'card item-btn ord-act-row', type: 'button', on: { click: () => { const c = byId(o.id); if (c) openOrder(c); } } },
      el('div', { class: 'row between' },
        el('strong', { class: 'ellipsis grow', text: o.customer_name }),
        el('strong', { text: DG.money(o.total_cents) })),
      el('div', { class: 'row between' },
        el('span', { class: 'ord-code', text: codeOf(o) }),
        el('span', { class: 'muted small', text: DG.fmtDate(o.created_at) })),
      el('div', { class: 'row wrap-row' },
        DG.statusPill(o),
        el('span', { class: 'muted small', text: (isPickup(o) ? 'Retirada' : 'Entrega') + (o.payment_method ? ' - ' + (METHOD[o.payment_method] || o.payment_method) : '') })));
  }

  // v4 N10: "Todos" (quadro) ou "Agendados" (lista pela data marcada).
  function filterChips() {
    const chip = (k, t) => el('button', { class: 'chip', type: 'button', 'aria-pressed': String(st.filter === k), text: t, on: { click: async () => {
      if (st.filter === k) return;
      st.filter = k; st.version++;
      st.box.replaceChildren(DG.loading('Carregando pedidos...'));
      try { await refresh(false); } catch (e) { DG.toast(e.message, true); }
    } } });
    return el('div', { class: 'chips', role: 'group', 'aria-label': 'Mostrar' }, chip('', 'Todos'), chip('scheduled', 'Agendados'));
  }

  function renderAll(fresh) {
    if (!st.box) return;
    if (st.filter === 'scheduled') {
      st.box.replaceChildren(filterChips(),
        el('p', { class: 'muted small wrap', text: 'Encomendas com data marcada, a mais próxima primeiro.' }),
        el('div', { class: 'ord-sched-list' }, ...(st.orders.length ? st.orders.map(o => kanbanCard(o, fresh && fresh.has(o.id))) : [DG.empty('Nenhuma encomenda agendada.')])));
      return;
    }
    const groups = COLS.map(c => ({ c, list: st.orders.filter(o => c.keys.includes(o.status_key)) }));
    const seg = el('div', { class: 'ord-seg', role: 'tablist', 'aria-label': 'Etapas do pedido' },
      ...groups.map(g => el('button', { class: 'ord-seg-btn ord-' + g.c.key, type: 'button', role: 'tab', 'aria-selected': String(st.col === g.c.key),
        'aria-label': g.c.title + ': ' + g.list.length,
        on: { click: () => { st.col = g.c.key; renderAll(); } } },
        el('span', { text: g.c.short, 'aria-hidden': 'true' }), el('b', { class: 'ord-count', 'aria-hidden': 'true', text: String(g.list.length) }))));
    const board = el('div', { class: 'ord-board' }, ...groups.map(g => el('section', { class: 'ord-col ord-' + g.c.key + (st.col === g.c.key ? ' is-active' : ''), 'aria-label': g.c.title },
      el('h3', { class: 'ord-col-h' }, el('span', { text: g.c.title }), el('b', { class: 'ord-count', text: String(g.list.length) })),
      ...(g.list.length ? g.list.map(o => kanbanCard(o, fresh && fresh.has(o.id))) : [el('p', { class: 'empty-state ord-empty', text: 'Nenhum pedido aqui.' })]))));
    const actHead = el('button', { class: 'ord-act-toggle', type: 'button', 'aria-expanded': String(st.actOpen),
      on: { click: () => { st.actOpen = !st.actOpen; lsSet(st.actOpen); renderAll(); } } },
      el('span', { text: 'Atividade recente (24 h)' }),
      el('span', { class: 'muted small', text: st.orders.length + (st.orders.length === 1 ? ' pedido ' : ' pedidos ') + (st.actOpen ? '▲' : '▼') }));
    const act = el('div', { class: 'ord-activity' }, actHead,
      ...(st.actOpen ? (st.orders.length ? st.orders.map(activityRow) : [DG.empty('Nenhum pedido nas últimas 24 horas.')]) : []));
    st.box.replaceChildren(filterChips(), seg, board, act);
  }

  function openOrder(o) {
    DG.sheet('Pedido ' + codeOf(o), (body, close) => {
      const statusBox = el('div', { class: 'status-grid' });
      const STEPS = ['new', 'accepted', 'preparing', 'ready', 'awaiting_delivery', 'completed', 'cancelled'];
      const paintStatus = () => {
        const cur = byId(o.id) || o;
        const now = cur.fulfillment_status === 'delivered' ? 'completed' : cur.fulfillment_status;
        // P3: o status não volta. Mostra só o atual (marcado) e as etapas à frente; concluído e cancelado são finais.
        const idx = STEPS.indexOf(now);
        const shown = now === 'cancelled' || now === 'completed' ? [now] : STEPS.filter((k, i) => i >= idx);
        statusBox.replaceChildren(...shown.map(k => el('button', {
          class: 'btn', type: 'button', text: k === 'awaiting_delivery' ? waitLabel(o) : STATUS[k], 'aria-pressed': String(k === now),
          disabled: st.busy.has(o.id),
          on: { click: async () => {
            if (k === now) return;
            const ok = k === 'cancelled' ? await cancelOrder(byId(o.id) || o)
              : (await confirmUnpaid(byId(o.id) || o, k)) && await changeStatus(o.id, k, 'Status atualizado.');
            if (ok) paintStatus();
          } }
        })));
      };
      paintStatus();
      body.append(
        el('div', { class: 'card' }, el('dl', { class: 'kv' },
          el('dt', { text: 'Pedido' }), el('dd', { text: codeOf(o) }),
          el('dt', { text: 'Cliente' }), el('dd', { text: o.customer_name }),
          el('dt', { text: 'Telefone' }), el('dd', { text: o.customer_phone }),
          el('dt', { text: 'Recebe' }), el('dd', { text: isPickup(o) ? 'Retirada' : 'Entrega' + (o.distance_km !== null && o.distance_km !== undefined && Number.isFinite(Number(o.distance_km)) ? ' (' + Number(o.distance_km).toFixed(1).replace('.', ',') + ' km)' : '') }),
          el('dt', { text: 'Endereço' }), el('dd', { text: o.address || '-' }),
          el('dt', { text: 'Situação' }), el('dd', {}, DG.statusPill(o)),
          el('dt', { text: 'Pagamento' }), el('dd', { text: (PAY[o.payment_status] || o.payment_status) + (o.payment_method ? ' (' + (METHOD[o.payment_method] || o.payment_method) + ')' : '') }),
          el('dt', { text: 'Hora' }), el('dd', { text: DG.fmtDate(o.created_at) }))),
        DG.orderFlags(o).length ? el('div', { class: 'row wrap-row' }, ...DG.orderFlags(o)) : null,
        DG.giftBox(o, () => { const c = byId(o.id); if (c) { c.gift = o.gift; renderAll(); } }),
        el('h3', { class: 'section-title', text: 'Itens' }),
        ...DG.orderItems(o.items),
        o.notes ? el('div', { class: 'card' }, el('strong', { text: 'Observações' }), el('p', { class: 'wrap', text: o.notes })) : null,
        DG.orderTotals(o),
        el('h3', { class: 'section-title', text: 'Andamento' }), statusBox,
        canCheckPay(o) ? el('button', { class: 'btn block', type: 'button', text: 'Conferir pagamento', on: { click: async function () { this.disabled = true; await checkPayment(o.id); const c = byId(o.id) || o; Object.assign(o, c); this.disabled = false; if (!canCheckPay(c)) { this.hidden = true; } paintStatus(); } } }) : null,
        el('a', { class: 'btn primary block', href: whatsLink(o.customer_phone, o.customer_name, codeOf(o)), target: '_blank', rel: 'noopener noreferrer', text: 'Chamar cliente no WhatsApp' }),
        el('button', { class: 'btn block', type: 'button', text: 'Fechar', on: { click: close } }));
    });
  }

  function stop() { if (st.timer) { clearInterval(st.timer); st.timer = null; } }

  DG.tabs.orders = {
    stop,
    async render(view) {
      stop();
      const searchInput = el('input', { class: 'search', type: 'search', placeholder: 'Buscar por código ou nome', maxlength: 60, value: st.search, 'aria-label': 'Buscar pedido' });
      let debounce = null;
      searchInput.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(async () => { st.search = searchInput.value.trim(); try { await refresh(false); } catch (e) { DG.toast(e.message, true); } }, 350);
      });
      st.box = el('div', {}, DG.loading('Carregando pedidos...'));
      view.replaceChildren(searchInput, st.box);
      await refresh(false);
      const dot = $('#orders-dot'); if (dot) dot.hidden = true;
      st.timer = setInterval(async () => {
        if (document.hidden || DG.state.tab !== 'orders' || st.busy.size) return;
        try { await refresh(true); } catch { /* tenta de novo no próximo ciclo */ }
      }, 30000);
    }
  };
})();
