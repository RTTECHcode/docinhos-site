'use strict';
/* Aba Pedidos: lista dos últimos 100, filtros, busca, detalhe e mudança de status. Atualiza sozinha a cada 30 s. */
(function () {
  const { el, $ } = window.DG;
  const DG = window.DG;
  const STATUS = { new: 'Novo', preparing: 'Preparando', ready: 'Pronto', delivered: 'Entregue', cancelled: 'Cancelado' };
  const PAY = { approved: 'Pago', pending: 'Aguardando pagamento', in_process: 'Em análise', rejected: 'Recusado', cancelled: 'Cancelado', refunded: 'Reembolsado', expired: 'Expirado' };
  const METHOD = { pix: 'Pix', mercadopago: 'Mercado Pago', mercadopago_card: 'Cartão' };
  const FILTERS = [['', 'Todos'], ['new', 'Novos'], ['preparing', 'Preparando'], ['ready', 'Prontos'], ['delivered', 'Entregues'], ['cancelled', 'Cancelados'], ['paid', 'Pagos']];
  const st = { filter: '', search: '', timer: null, seen: null, orders: [], listBox: null };

  function payClass(s) { return s === 'approved' ? 'ok' : (s === 'pending' || s === 'in_process') ? 'warn' : 'off'; }
  function whatsLink(phone, name, code) {
    let digits = String(phone).replace(/\D/g, '');
    if (digits.length <= 11) digits = '55' + digits;
    const text = 'Olá ' + String(name).split(' ')[0] + '! Aqui é da Docinhos da Gigi sobre o seu pedido ' + code + '.';
    return 'https://wa.me/' + digits + '?text=' + encodeURIComponent(text);
  }

  async function fetchOrders() {
    const r = await DG.api('orders', { query: { f: st.filter, s: st.search } });
    const prev = st.seen;
    st.orders = r.orders;
    const ids = new Set(r.orders.map(o => o.id));
    const fresh = prev ? new Set(r.orders.filter(o => !prev.has(o.id)).map(o => o.id)) : new Set();
    if (!st.search && !st.filter) st.seen = ids; else if (!prev) st.seen = ids;
    const dot = $('#orders-dot');
    if (dot) dot.hidden = !(fresh.size && DG.state.tab !== 'orders');
    return fresh;
  }

  function orderCard(o, fresh) {
    const isNew = o.fulfillment_status === 'new';
    const paid = o.payment_status === 'approved';
    return el('button', { class: 'card item-btn' + ((isNew && paid) || fresh ? ' hl' : ''), type: 'button', on: { click: () => openOrder(o) } },
      el('div', { class: 'row between' },
        el('strong', { text: o.code }),
        el('span', { class: 'muted small', text: DG.fmtDate(o.created_at) })),
      el('div', { class: 'row between' },
        el('span', { class: 'ellipsis grow', text: o.customer_name }),
        el('strong', { text: DG.money(o.total_cents) })),
      el('div', { class: 'row wrap-row' },
        el('span', { class: 'pill ' + payClass(o.payment_status), text: PAY[o.payment_status] || o.payment_status }),
        el('span', { class: 'pill' + (isNew ? '' : ' off'), text: STATUS[o.fulfillment_status] || o.fulfillment_status }),
        el('span', { class: 'muted small', text: (o.delivery_method === 'pickup' ? 'Retirada' : 'Entrega') + (o.payment_method ? ' - ' + (METHOD[o.payment_method] || o.payment_method) : '') })));
  }

  function renderList(fresh) {
    if (!st.listBox) return;
    if (!st.orders.length) { st.listBox.replaceChildren(el('p', { class: 'muted', text: 'Nenhum pedido encontrado.' })); return; }
    st.listBox.replaceChildren(...st.orders.map(o => orderCard(o, fresh && fresh.has(o.id))));
  }

  function openOrder(o) {
    DG.sheet('Pedido ' + o.code, (body, close) => {
      const items = Array.isArray(o.items) ? o.items : [];
      const statusBox = el('div', { class: 'status-grid' });
      const paintStatus = current => statusBox.replaceChildren(...Object.entries(STATUS).map(([k, label]) => el('button', {
        class: 'btn', type: 'button', text: label, 'aria-pressed': String(k === current),
        on: { click: async () => {
          const r = await DG.run(() => DG.api('order_status', { body: { id: o.id, status: k } }), 'Status atualizado.');
          if (r) { o.fulfillment_status = k; paintStatus(k); fetchOrders().then(() => renderList()).catch(() => {}); }
        } }
      })));
      paintStatus(o.fulfillment_status);
      body.append(
        el('div', { class: 'card' }, el('dl', { class: 'kv' },
          el('dt', { text: 'Cliente' }), el('dd', { text: o.customer_name }),
          el('dt', { text: 'Telefone' }), el('dd', { text: o.customer_phone }),
          el('dt', { text: 'Recebe' }), el('dd', { text: o.delivery_method === 'pickup' ? 'Retirada' : 'Entrega' }),
          el('dt', { text: 'Endereço' }), el('dd', { text: o.address || '-' }),
          el('dt', { text: 'Pagamento' }), el('dd', { text: (PAY[o.payment_status] || o.payment_status) + (o.payment_method ? ' (' + (METHOD[o.payment_method] || o.payment_method) + ')' : '') }),
          el('dt', { text: 'Hora' }), el('dd', { text: DG.fmtDate(o.created_at) }))),
        el('h3', { class: 'section-title', text: 'Itens' }),
        ...items.map(i => el('div', { class: 'card' },
          el('div', { class: 'row between' }, el('strong', { class: 'wrap', text: (i.qty || 1) + 'x ' + (i.name || '') }), el('span', { text: DG.money((i.unit_total_cents || 0) * (i.qty || 1)) })),
          i.size ? el('p', { class: 'muted small wrap', text: 'Tamanho: ' + i.size }) : null,
          Array.isArray(i.extras) && i.extras.length ? el('p', { class: 'muted small wrap', text: 'Extras: ' + i.extras.join(', ') }) : null)),
        o.notes ? el('div', { class: 'card' }, el('strong', { text: 'Observações' }), el('p', { class: 'wrap', text: o.notes })) : null,
        el('div', { class: 'card' },
          el('div', { class: 'row between' }, el('span', { text: 'Subtotal' }), el('span', { text: DG.money(o.subtotal_cents) })),
          el('div', { class: 'row between' }, el('span', { text: 'Entrega' }), el('span', { text: DG.money(o.delivery_fee_cents) })),
          el('div', { class: 'row between' }, el('strong', { text: 'Total' }), el('strong', { text: DG.money(o.total_cents) }))),
        el('h3', { class: 'section-title', text: 'Andamento' }), statusBox,
        el('a', { class: 'btn primary block', href: whatsLink(o.customer_phone, o.customer_name, o.code), target: '_blank', rel: 'noopener noreferrer', text: 'Chamar no WhatsApp' }),
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
        debounce = setTimeout(async () => { st.search = searchInput.value.trim(); try { await fetchOrders(); renderList(); } catch (e) { DG.toast(e.message, true); } }, 350);
      });
      const chips = el('div', { class: 'chips', role: 'group', 'aria-label': 'Filtrar por status' });
      const paintChips = () => chips.replaceChildren(...FILTERS.map(([k, label]) => el('button', {
        class: 'chip', type: 'button', text: label, 'aria-pressed': String(k === st.filter),
        on: { click: async () => { st.filter = k; paintChips(); try { await fetchOrders(); renderList(); } catch (e) { DG.toast(e.message, true); } } }
      })));
      paintChips();
      st.listBox = el('div', {}, el('p', { class: 'muted', text: 'Carregando...' }));
      view.replaceChildren(searchInput, chips, st.listBox);
      renderList(await fetchOrders());
      $('#orders-dot').hidden = true;
      st.timer = setInterval(async () => {
        if (document.hidden || DG.state.tab !== 'orders') return;
        try {
          const fresh = await fetchOrders();
          renderList(fresh);
          if (fresh.size) DG.toast(fresh.size === 1 ? 'Chegou um pedido novo.' : 'Chegaram ' + fresh.size + ' pedidos novos.');
        } catch { /* tenta de novo no próximo ciclo */ }
      }, 30000);
    }
  };
})();
