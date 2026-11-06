'use strict';
/* Aba Loja: endereço, taxa de entrega e mensagem de loja pausada. */
(function () {
  const DG = window.DG;
  const { el } = DG;

  DG.tabs.store = {
    async render(view) {
      const catalog = await DG.loadCatalog();
      const s = catalog.settings;
      DG.setStoreBadge(s.storePaused);
      const address = el('input', { type: 'text', maxlength: 200, value: s.storeAddress });
      const fee = el('input', { type: 'text', inputmode: 'decimal', placeholder: '0,00', value: DG.moneyInput(s.deliveryFeeCents) });
      const message = el('textarea', { maxlength: 200 });
      message.value = s.storePausedMessage;
      const state = { paused: s.storePaused };
      const paused = DG.switchEl(state.paused, 'Loja pausada', async next => {
        const ok = await DG.confirm(next ? 'Pausar a loja inteira? Os clientes não conseguirão pedir.' : 'Reabrir a loja?', next ? 'Pausar loja' : 'Reabrir', next);
        if (!ok) return false;
        const r = await DG.run(() => DG.api('store_save', { body: { store_paused: next } }), next ? 'Loja pausada.' : 'Loja aberta.');
        if (!r) return false;
        state.paused = next;
        DG.setStoreBadge(next);
        return true;
      }, true);
      view.replaceChildren(
        el('div', { class: 'card row between' }, el('div', {}, el('strong', { text: 'Loja pausada' }), el('p', { class: 'muted small', text: 'Bloqueia novos pedidos' })), paused),
        el('form', { class: 'card stack', novalidate: true, on: { submit: async e => {
          e.preventDefault();
          const cents = DG.parseMoney(fee.value);
          if (Number.isNaN(cents)) { DG.toast('Taxa inválida. Use o formato 5,00.', true); return; }
          const r = await DG.run(() => DG.api('store_save', { body: { store_address: address.value, delivery_fee_cents: cents === null ? 0 : cents, store_paused_message: message.value } }), 'Loja atualizada.');
          if (r) DG.setStoreBadge(r.settings.storePaused);
        } } },
        el('label', { class: 'field' }, el('span', { text: 'Endereço para retirada' }), address),
        el('label', { class: 'field' }, el('span', { text: 'Taxa de entrega (R$)' }), fee),
        el('label', { class: 'field' }, el('span', { text: 'Mensagem quando a loja estiver pausada' }), message),
        el('button', { class: 'btn primary block', type: 'submit', text: 'Salvar' })));
    }
  };
})();
