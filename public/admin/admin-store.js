'use strict';
/* A5: helpers de horário (fuso São Paulo) e cartão "Loja" (endereço de retirada). A aba Loja agora é a aba Ajustes (admin-settings.js). */
(function () {
  const DG = window.DG;
  const { el } = DG;
  const TZ = 'America/Sao_Paulo';

  // Data/hora no fuso da loja, independente do fuso do aparelho.
  DG.fmtSP = iso => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
  DG.timeSP = iso => (iso ? new Date(iso).toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : '');
  // Minutos que faltam até o próximo HH:MM (horário de São Paulo). Se já passou hoje, conta para amanhã.
  DG.minutesUntilSP = hhmm => {
    const m = /^(\d{2}):(\d{2})$/.exec(hhmm || '');
    if (!m) return NaN;
    const parts = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
    const h = Number(parts.find(p => p.type === 'hour').value) % 24, mi = Number(parts.find(p => p.type === 'minute').value);
    let diff = (Number(m[1]) * 60 + Number(m[2])) - (h * 60 + mi);
    if (diff <= 0) diff += 1440;
    return diff;
  };

  // Cartão com o endereço da loja (retirada). Mensagem de loja fechada fica no menu "Fechar loja" da aba Pausa.
  DG.storeCard = catalog => {
    const address = el('input', { type: 'text', maxlength: 200, value: catalog.settings.storeAddress });
    return el('form', { class: 'card stack', novalidate: true, on: { submit: async e => {
      e.preventDefault();
      const r = await DG.run(() => DG.api('store_save', { body: { store_address: address.value } }), 'Loja atualizada.');
      if (r) catalog.settings.storeAddress = r.settings.storeAddress;
    } } },
    el('label', { class: 'field' }, el('span', { text: 'Endereço da loja (retirada)' }), address),
    el('button', { class: 'btn primary block', type: 'submit', text: 'Salvar endereço' }));
  };
})();
