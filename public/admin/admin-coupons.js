'use strict';
/* Tela Cupons e WhatsApp (v4 N6, só administrador).
   Cupons: criar, editar, ligar/desligar, validade, limites e "acumula com o Clube". O desconto real é sempre calculado no servidor.
   Campanhas: monta o público (só clientes com consentimento de WhatsApp), cria a lista, mostra a mensagem pronta e o link wa.me.
   Nada é enviado sozinho: a Gigi toca no link, envia no WhatsApp e marca como enviada. */
(function () {
  const DG = window.DG;
  const { el } = DG;
  const STATE = { on: ['Valendo', 'ok'], off: ['Desligado', 'off'], scheduled: ['Agendado', 'warn'], expired: ['Vencido', 'off'] };
  const AUD = { all: 'Todos com WhatsApp autorizado', bought_within: 'Compraram nos últimos N dias', inactive_for: 'Sem comprar há N dias ou mais', spent_over: 'Gastaram a partir de um valor' };
  const int = n => Number(n || 0).toLocaleString('pt-BR');
  const discountText = c => (c.kind === 'percent' ? c.value + '% de desconto' : DG.money(c.value) + ' de desconto');
  function audienceText(a) {
    if (!a) return '';
    if (a.type === 'all') return AUD.all;
    if (a.type === 'bought_within') return 'Compraram nos últimos ' + a.days + ' dias';
    if (a.type === 'inactive_for') return 'Sem comprar há ' + a.days + ' dias ou mais';
    if (a.type === 'spent_over') return 'Gastaram ' + DG.money(a.cents) + ' ou mais';
    return a.type;
  }
  // wa.me pede o número com DDI. Telefone brasileiro guardado com DDD (10 ou 11 dígitos) ganha o 55 na frente.
  function waLink(phone, message) {
    let d = String(phone || '').replace(/\D/g, '');
    if (d.length === 10 || d.length === 11) d = '55' + d;
    return 'https://wa.me/' + d + '?text=' + encodeURIComponent(message);
  }
  function windowText(c) {
    if (c.starts_at && c.expires_at) return 'de ' + DG.fmtDay(c.starts_at) + ' até ' + DG.fmtDay(c.expires_at);
    if (c.starts_at) return 'a partir de ' + DG.fmtDay(c.starts_at);
    if (c.expires_at) return 'até ' + DG.fmtDay(c.expires_at);
    return 'sem data de validade';
  }

  // ---------- cupom: criar / editar ----------
  function couponSheet(c, onSaved) {
    DG.sheet(c ? 'Editar cupom ' + c.code : 'Novo cupom', (body, close) => {
      const code = el('input', { type: 'text', maxlength: 20, autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false', placeholder: 'ex.: GIGI10', value: c ? c.code : '', readonly: !!c });
      const kind = el('select', {}, el('option', { value: 'percent', text: 'Porcentagem (%)', selected: !c || c.kind === 'percent' }), el('option', { value: 'fixed', text: 'Valor fixo (R$)', selected: !!c && c.kind === 'fixed' }));
      const value = el('input', { type: 'text', inputmode: 'decimal', value: c ? (c.kind === 'percent' ? String(c.value) : DG.moneyInput(c.value)) : '10' });
      const valueLabel = el('span');
      const paintKind = () => { valueLabel.textContent = kind.value === 'percent' ? 'Desconto em % (1 a 100)' : 'Desconto em R$'; value.placeholder = kind.value === 'percent' ? 'ex.: 10' : 'ex.: 5,00'; };
      kind.addEventListener('change', () => { value.value = ''; paintKind(); });
      paintKind();
      const minOrder = el('input', { type: 'text', inputmode: 'decimal', placeholder: 'sem mínimo', value: c && c.min_order_cents ? DG.moneyInput(c.min_order_cents) : '' });
      const starts = el('input', { type: 'date', value: c ? DG.daySP(c.starts_at) : '' });
      const expires = el('input', { type: 'date', value: c ? DG.daySP(c.expires_at) : '' });
      const maxUses = DG.intField('Limite total de usos (vazio = sem limite)', c ? c.max_uses : null, 1, 10000000);
      const perCust = DG.intField('Usos por cliente (vazio = sem limite)', c ? c.max_uses_per_customer : 1, 1, 100000);
      const stacks = el('input', { type: 'checkbox', checked: !!c && c.stacks_with_club });
      const active = el('input', { type: 'checkbox', checked: c ? c.active : true });
      const note = el('input', { type: 'text', maxlength: 200, placeholder: 'só para você (opcional)', value: c && c.note ? c.note : '' });
      const msg = el('p', { class: 'error wrap', role: 'alert', hidden: true });
      const save = el('button', { class: 'btn primary block', type: 'submit', text: c ? 'Salvar cupom' : 'Criar cupom' });
      const fail = t => { msg.textContent = t; msg.hidden = false; msg.scrollIntoView({ block: 'nearest' }); };
      const form = el('form', { class: 'stack', novalidate: true, on: { submit: async e => {
        e.preventDefault();
        msg.hidden = true;
        const codeTxt = code.value.trim().toUpperCase();
        if (!c && !/^[A-Z0-9-]{3,20}$/.test(codeTxt)) return fail('Código: use de 3 a 20 letras, números ou hífen (sem espaço nem acento).');
        let v;
        if (kind.value === 'percent') {
          v = DG.readInt(value, 1, 100, 'Desconto em %');
          if (typeof v !== 'number') return fail(v.problem);
        } else {
          v = DG.parseMoney(value.value);
          if (!Number.isInteger(v) || v < 1 || v > 1000000) return fail('Desconto em R$: informe um valor de R$ 0,01 a R$ 10.000,00.');
        }
        const min = minOrder.value.trim() ? DG.parseMoney(minOrder.value) : 0;
        if (!Number.isInteger(min) || min > 10000000) return fail('Pedido mínimo inválido.');
        if (starts.value && expires.value && expires.value < starts.value) return fail('A validade precisa ser depois do início.');
        const mu = DG.readInt(maxUses.input, 1, 10000000, 'Limite total de usos', true);
        if (mu !== null && typeof mu !== 'number') return fail(mu.problem);
        const pc = DG.readInt(perCust.input, 1, 100000, 'Usos por cliente', true);
        if (pc !== null && typeof pc !== 'number') return fail(pc.problem);
        // Edição regrava todos os campos (o servidor troca o cupom inteiro), então mandamos tudo.
        const payload = { kind: kind.value, value: v, min_order_cents: min, starts_at: starts.value || null, expires_at: expires.value || null,
          max_uses: mu, max_uses_per_customer: pc, stacks_with_club: stacks.checked, active: active.checked, note: note.value.trim() || null };
        if (c) payload.id = c.id; else payload.code = codeTxt;
        save.disabled = true;
        try {
          await DG.api('coupon_save', { body: payload });
          DG.toast(c ? 'Cupom salvo.' : 'Cupom criado.');
          close(); onSaved();
        } catch (ex) { fail(ex.message); save.disabled = false; }
      } } },
      el('label', { class: 'field' }, el('span', { text: c ? 'Código (não muda depois de criado)' : 'Código do cupom' }), code),
      el('div', { class: 'grid2' }, el('label', { class: 'field' }, el('span', { text: 'Tipo' }), kind), el('label', { class: 'field' }, valueLabel, value)),
      el('label', { class: 'field' }, el('span', { text: 'Pedido mínimo em R$ (produtos)' }), minOrder),
      el('div', { class: 'grid2' }, el('label', { class: 'field' }, el('span', { text: 'Começa em (opcional)' }), starts), el('label', { class: 'field' }, el('span', { text: 'Vale até (opcional)' }), expires)),
      el('div', { class: 'grid2' }, maxUses.field, perCust.field),
      el('label', { class: 'a5-check' }, stacks, el('span', { text: 'Pode usar junto com prêmio do Clube' })),
      el('label', { class: 'a5-check' }, active, el('span', { text: 'Cupom ligado' })),
      el('label', { class: 'field' }, el('span', { text: 'Anotação' }), note),
      msg, save);
      body.replaceChildren(form);
      (c ? value : code).focus();
    });
  }

  // ---------- campanha: lista de envio ----------
  function campaignSheet(id, onChange) {
    DG.sheet('Envios pelo WhatsApp', async body => {
      body.replaceChildren(DG.loading('Carregando a lista...'));
      let r;
      try { r = await DG.api('coupon_campaign', { query: { id } }); } catch (e) { body.replaceChildren(el('p', { class: 'error wrap', text: e.message })); return; }
      const progress = el('p', { class: 'muted small', role: 'status' });
      const targets = r.targets || [];
      const paintProgress = () => { progress.textContent = int(targets.filter(t => t.sent_at).length) + ' de ' + int(targets.length) + ' marcadas como enviadas.'; };
      paintProgress();
      body.replaceChildren(
        el('p', { class: 'wrap' }, el('strong', { text: r.campaign.coupon_code }), ' - ' + audienceText(r.campaign.audience)),
        el('p', { class: 'muted small wrap', text: 'Toque em "Abrir no WhatsApp", envie a mensagem e depois marque como enviada. Nada é enviado sozinho.' }),
        progress,
        ...targets.map(t => {
          const when = el('span', { class: 'muted small', text: t.sent_at ? 'Enviada em ' + DG.fmtDate(t.sent_at) : 'Ainda não enviada' });
          const mark = el('input', { type: 'checkbox', checked: !!t.sent_at });
          mark.addEventListener('change', async () => {
            mark.disabled = true;
            try {
              const x = await DG.api('coupon_target_sent', { body: { campaign_id: r.campaign.id, customer_id: t.customer_id, sent: mark.checked } });
              t.sent_at = x.sent_at;
              when.textContent = t.sent_at ? 'Enviada em ' + DG.fmtDate(t.sent_at) : 'Ainda não enviada';
              paintProgress(); onChange();
            } catch (e) { mark.checked = !mark.checked; DG.toast(e.message, true); }
            mark.disabled = false;
          });
          const copy = el('button', { class: 'btn small', type: 'button', text: 'Copiar mensagem', on: { click: async () => {
            try { await navigator.clipboard.writeText(t.message); DG.toast('Mensagem copiada.'); } catch { DG.toast('Não deu para copiar. Use o botão do WhatsApp.', true); }
          } } });
          return el('div', { class: 'card stack cp-target' },
            el('div', { class: 'row between' }, el('strong', { class: 'wrap grow', text: t.name }), el('span', { class: 'muted small', text: t.phone })),
            el('p', { class: 'cp-msg wrap', text: t.message }),
            el('div', { class: 'row wrap-row' },
              el('a', { class: 'btn small primary', href: waLink(t.phone, t.message), target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Abrir conversa com ' + t.name + ' no WhatsApp (abre em nova aba)' }, 'Abrir no WhatsApp'),
              copy),
            el('label', { class: 'a5-check' }, mark, el('span', { text: 'Mensagem enviada' })),
            when);
        }));
    });
  }

  // ---------- campanha: montar público ----------
  function campaignsSheet(c) {
    DG.sheet('WhatsApp - cupom ' + c.code, (body, close) => {
      const type = el('select', {}, ...Object.entries(AUD).map(([k, t]) => el('option', { value: k, text: t })));
      const days = DG.intField('Dias (1 a 3.650)', 30, 1, 3650);
      const cents = el('input', { type: 'text', inputmode: 'decimal', placeholder: 'ex.: 200,00', value: '' });
      const centsField = el('label', { class: 'field' }, el('span', { text: 'Gastaram pelo menos (R$)' }), cents);
      const result = el('div', { class: 'stack', 'aria-live': 'polite' });
      const create = el('button', { class: 'btn primary block', type: 'button', text: 'Criar lista de envio', hidden: true });
      const past = el('div', { class: 'stack' });
      let audience = null;
      const paintType = () => { days.field.hidden = !['bought_within', 'inactive_for'].includes(type.value); centsField.hidden = type.value !== 'spent_over'; audience = null; create.hidden = true; result.replaceChildren(); };
      type.addEventListener('change', paintType);
      [days.input, cents].forEach(i => i.addEventListener('input', () => { audience = null; create.hidden = true; }));
      paintType();
      const readAudience = () => {
        if (type.value === 'all') return { type: 'all' };
        if (type.value === 'spent_over') {
          const v = DG.parseMoney(cents.value);
          if (!Number.isInteger(v) || v < 1 || v > 100000000) return { problem: 'Informe o valor gasto (de R$ 0,01 a R$ 1.000.000,00).' };
          return { type: 'spent_over', cents: v };
        }
        const d = DG.readInt(days.input, 1, 3650, 'Dias');
        return typeof d === 'number' ? { type: type.value, days: d } : d;
      };
      const preview = el('button', { class: 'btn block', type: 'button', text: 'Ver quem vai receber', on: { click: async () => {
        const a = readAudience();
        if (a.problem) { result.replaceChildren(el('p', { class: 'error wrap', role: 'alert', text: a.problem })); return; }
        preview.disabled = true;
        result.replaceChildren(DG.loading('Contando clientes...'));
        try {
          const r = await DG.api('coupon_audience', { body: { coupon_id: c.id, audience: a } });
          audience = r.count ? a : null;
          create.hidden = !r.count;
          result.replaceChildren(
            el('p', { class: 'wrap' }, el('strong', { text: int(r.count) + ' cliente(s)' }), ' com WhatsApp autorizado' + (r.capped ? ' (limite de 5.000 por lista)' : '') + '.'),
            r.preview.length ? el('ul', { class: 'cp-preview' }, ...r.preview.map(p => el('li', { text: p.name }))) : DG.empty('Ninguém neste público.'),
            r.count > r.preview.length ? el('p', { class: 'muted small', text: 'Mostrando os ' + r.preview.length + ' primeiros nomes.' }) : null);
        } catch (e) { result.replaceChildren(el('p', { class: 'error wrap', role: 'alert', text: e.message })); }
        preview.disabled = false;
      } } });
      const loadPast = async () => {
        let r;
        try { r = await DG.api('coupon_campaign', { query: { coupon_id: c.id } }); } catch (e) { past.replaceChildren(el('p', { class: 'error wrap', text: e.message })); return; }
        past.replaceChildren(...(r.campaigns.length ? r.campaigns.map(k => el('button', { class: 'card item-btn cp-camp', type: 'button', on: { click: () => campaignSheet(k.id, loadPast) } },
          el('strong', { class: 'wrap', text: audienceText(k.audience) }),
          el('span', { class: 'muted small', text: DG.fmtDate(k.created_at) + ' - ' + int(k.sent) + ' de ' + int(k.total) + ' enviadas' }))) : [DG.empty('Nenhuma lista criada para este cupom.')]));
      };
      create.addEventListener('click', async () => {
        if (!audience) return;
        create.disabled = true;
        try {
          const r = await DG.api('coupon_campaign_create', { body: { coupon_id: c.id, audience } });
          DG.toast('Lista criada com ' + int(r.count) + ' cliente(s).');
          create.hidden = true; audience = null; result.replaceChildren();
          await loadPast();
          campaignSheet(r.campaign_id, loadPast);
        } catch (e) { DG.toast(e.message, true); }
        create.disabled = false;
      });
      body.replaceChildren(
        el('p', { class: 'muted small wrap', text: discountText(c) + '. Só entram clientes com conta que autorizaram mensagens no WhatsApp.' }),
        el('label', { class: 'field' }, el('span', { text: 'Quem recebe' }), type), days.field, centsField,
        preview, result, create,
        el('h3', { class: 'section-title', text: 'Listas deste cupom' }), past);
      past.replaceChildren(DG.loading());
      loadPast();
      type.focus();
    });
  }

  function couponCard(c, reload) {
    const [stTxt, stCls] = STATE[c.state] || [c.state, ''];
    const limits = [];
    if (c.min_order_cents) limits.push('pedido mínimo ' + DG.money(c.min_order_cents));
    limits.push(c.max_uses ? 'até ' + int(c.max_uses) + ' usos' : 'usos sem limite');
    limits.push(c.max_uses_per_customer ? int(c.max_uses_per_customer) + ' por cliente' : 'sem limite por cliente');
    return el('div', { class: 'card stack cp-card' },
      el('div', { class: 'row between' },
        el('div', { class: 'grow' }, el('strong', { class: 'cp-code', text: c.code }), el('p', { class: 'wrap', text: discountText(c) })),
        DG.switchEl(c.active, (c.active ? 'Desligar' : 'Ligar') + ' cupom ' + c.code, async next => {
          try { await DG.api('coupon_toggle', { body: { id: c.id, active: next } }); DG.toast(next ? 'Cupom ligado.' : 'Cupom desligado.'); reload(); return true; } catch (e) { DG.toast(e.message, true); return false; }
        }, true)),
      el('div', { class: 'row wrap-row' },
        el('span', { class: 'pill ' + stCls, text: stTxt }),
        el('span', { class: 'pill ' + (c.stacks_with_club ? 'ok' : 'off'), text: c.stacks_with_club ? 'Acumula com o Clube' : 'Não acumula com o Clube' })),
      el('p', { class: 'muted small wrap', text: windowText(c) + ' · ' + limits.join(' · ') }),
      el('p', { class: 'small wrap', text: 'Usado em ' + int(c.uses_committed) + ' pedido(s) pago(s), ' + DG.money(c.discount_committed_cents) + ' de desconto' + (c.uses_reserved ? ' · ' + int(c.uses_reserved) + ' aguardando pagamento' : '') + '.' }),
      c.note ? el('p', { class: 'muted small wrap', text: 'Anotação: ' + c.note }) : null,
      el('div', { class: 'row wrap-row' },
        el('button', { class: 'btn small', type: 'button', text: 'Editar', 'aria-label': 'Editar cupom ' + c.code, on: { click: () => couponSheet(c, reload) } }),
        el('button', { class: 'btn small', type: 'button', text: 'Enviar no WhatsApp', 'aria-label': 'Campanha de WhatsApp do cupom ' + c.code, on: { click: () => campaignsSheet(c) } })));
  }

  let renderSeq = 0; // só a última carga desenha (evita lista velha depois de ligar/desligar rápido)
  DG.tabs.coupons = {
    async render(view) {
      if (!DG.isAdmin()) { view.replaceChildren(el('p', { class: 'error', text: 'Só o administrador mexe em cupons.' })); return; }
      const my = ++renderSeq;
      const r = await DG.api('coupons');
      if (DG.state.tab !== 'coupons' || my !== renderSeq) return;
      const reload = () => { if (DG.state.tab === 'coupons') DG.tabs.coupons.render(view).catch(e => DG.toast(e.message, true)); };
      const list = r.coupons || [];
      view.replaceChildren(
        el('p', { class: 'muted small wrap', text: 'O cliente digita o código no carrinho. O desconto vale só sobre os produtos (não sobre o frete) e é conferido pelo servidor.' }),
        el('button', { class: 'btn primary block', type: 'button', text: '+ Novo cupom', on: { click: () => couponSheet(null, reload) } }),
        el('div', { class: 'cp-list' }, ...(list.length ? list.map(c => couponCard(c, reload)) : [DG.empty('Nenhum cupom ainda.')])));
    }
  };
})();
