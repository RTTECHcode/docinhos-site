'use strict';
/* Aba Ajustes (A5): horários e fechamento da loja, frete, pontos, sinônimos, loja e segurança do admin.
   Também: tela obrigatória de pergunta de segurança e "Esqueci a senha" (usadas por admin.js). */
(function () {
  const DG = window.DG;
  const { el, $ } = DG;
  const isAdmin = () => DG.state.user && DG.state.user.role === 'admin';
  const DAYS = [[1, 'Segunda'], [2, 'Terça'], [3, 'Quarta'], [4, 'Quinta'], [5, 'Sexta'], [6, 'Sábado'], [0, 'Domingo']];
  const MAX_RANGES = 6;

  // ---------- códigos de recuperação (mostrados UMA vez) ----------
  function codesView(codes, notice, onDone) {
    const text = codes.join('\n');
    const copy = el('button', { class: 'btn block', type: 'button', text: 'Copiar códigos' });
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); DG.toast('Códigos copiados.'); } catch { DG.toast('Não consegui copiar. Anote à mão.', true); }
    });
    const sure = el('input', { type: 'checkbox' });
    const done = el('button', { class: 'btn primary block', type: 'button', text: 'Já guardei os códigos', disabled: true, on: { click: onDone } });
    sure.addEventListener('change', () => { done.disabled = !sure.checked; });
    return el('div', { class: 'stack' },
      el('p', { class: 'a5-warn wrap', text: 'Estes 10 códigos aparecem só agora. Guarde-os fora do computador (papel ou cofre de senhas). Cada um vale uma vez e serve para recuperar a senha.' }),
      notice ? el('p', { class: 'muted small wrap', text: notice }) : null,
      el('div', { class: 'a5-codes' }, ...codes.map(c => el('code', { text: c }))),
      copy,
      el('label', { class: 'a5-check' }, sure, el('span', { text: 'Guardei os códigos em local seguro.' })),
      done);
  }

  async function loadQuestions() {
    const r = await DG.api('security_questions');
    return r.questions || [];
  }

  // Formulário de pergunta + resposta. needCurrent: pedir a senha atual (troca de pergunta já cadastrada).
  function questionForm(questions, needCurrent, onSaved) {
    const sel = el('select', {}, ...questions.map(q => el('option', { value: q.id, text: q.text })));
    const ans = el('input', { type: 'text', maxlength: 100, autocomplete: 'off', autocapitalize: 'none' });
    const cur = needCurrent ? el('input', { type: 'password', autocomplete: 'current-password', maxlength: 256 }) : null;
    const err = el('p', { class: 'error', hidden: true });
    const form = el('form', { class: 'stack', novalidate: true, on: { submit: async e => {
      e.preventDefault();
      err.hidden = true;
      if (ans.value.trim().length < 3) { err.textContent = 'A resposta precisa ter pelo menos 3 letras.'; err.hidden = false; return; }
      const body = { question_id: sel.value, answer: ans.value };
      if (cur) body.current_password = cur.value;
      let r;
      try { r = await DG.api('security_setup', { body }); } catch (ex) { err.textContent = ex.message; err.hidden = false; return; }
      onSaved(r);
    } } },
    el('label', { class: 'field' }, el('span', { text: 'Pergunta de segurança' }), sel),
    el('label', { class: 'field' }, el('span', { text: 'Sua resposta (não use algo que outras pessoas saibam)' }), ans),
    cur ? el('label', { class: 'field' }, el('span', { text: 'Senha atual' }), cur) : null,
    err, el('button', { class: 'btn primary block', type: 'submit', text: 'Salvar' }));
    return form;
  }

  // Tela que bloqueia o painel até cadastrar a pergunta (login com needsSecurity).
  let lockEl = null;
  DG.forceSecurity = async function () {
    if (lockEl) return;
    $('#app').hidden = true;
    $('#login-view').hidden = true;
    const card = el('div', { class: 'login-card' }, el('h1', { text: 'Proteja sua conta' }),
      el('p', { class: 'muted', text: 'Antes de continuar, cadastre uma pergunta de segurança. Ela ajuda a recuperar a senha se você esquecer.' }));
    lockEl = el('main', { class: 'login a5-lock' }, card);
    document.body.append(lockEl);
    const finish = async () => {
      lockEl.remove(); lockEl = null;
      try { await DG.api('me'); } catch { return; }
      if (DG.state.user && DG.state.user.weakPassword && DG.forcePasswordChange) { DG.forcePasswordChange(); return; }
      $('#app').hidden = false;
      DG.go(DG.state.tab);
    };
    const out = el('div', { class: 'stack' });
    card.append(out, el('button', { class: 'btn block', type: 'button', text: 'Sair', on: { click: async () => { await DG.run(() => DG.api('logout', { body: {} })); location.reload(); } } }));
    try {
      const questions = await loadQuestions();
      out.replaceChildren(questionForm(questions, false, r => out.replaceChildren(codesView(r.codes || [], r.codes_notice, finish))));
    } catch (e) { out.replaceChildren(el('p', { class: 'error', text: e.message })); }
  };

  // ---------- Esqueci a senha (tela de login) ----------
  DG.forgotPassword = function () {
    DG.sheet('Esqueci a senha', (body, close) => {
      const user = el('input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', maxlength: 64 });
      const step = el('div', { class: 'stack' });
      const msg = el('p', { class: 'error wrap', hidden: true });
      const show = (t) => { msg.textContent = t; msg.hidden = false; };
      const askUser = () => {
        const go = el('button', { class: 'btn primary block', type: 'submit', text: 'Continuar' });
        step.replaceChildren(el('form', { class: 'stack', novalidate: true, on: { submit: async e => {
          e.preventDefault(); msg.hidden = true; go.disabled = true;
          try { const q = await DG.api('recover_question', { body: { username: user.value.trim() } }); askAnswer(q.question); } catch (ex) { show(ex.message); }
          go.disabled = false;
        } } }, el('label', { class: 'field' }, el('span', { text: 'Usuário' }), user), go));
      };
      const askAnswer = question => {
        const ans = el('input', { type: 'text', autocomplete: 'off', maxlength: 100 });
        const code = el('input', { type: 'text', autocomplete: 'off', autocapitalize: 'characters', maxlength: 30, placeholder: 'ABCD-EFGH-JKMN' });
        const pw = el('input', { type: 'password', autocomplete: 'new-password', maxlength: 128 });
        const go = el('button', { class: 'btn primary block', type: 'submit', text: 'Trocar senha' });
        step.replaceChildren(el('form', { class: 'stack', novalidate: true, on: { submit: async e => {
          e.preventDefault(); msg.hidden = true; go.disabled = true;
          try {
            await DG.api('recover', { body: { username: user.value.trim(), answer: ans.value, code: code.value.trim(), new_password: pw.value } });
            DG.toast('Senha trocada. Entre com a nova senha.');
            close();
          } catch (ex) { show(ex.message); go.disabled = false; }
        } } },
        el('p', { class: 'wrap', text: question }),
        el('label', { class: 'field' }, el('span', { text: 'Sua resposta' }), ans),
        el('label', { class: 'field' }, el('span', { text: 'Um código de recuperação' }), code),
        el('label', { class: 'field' }, el('span', { text: 'Nova senha (mínimo 8 caracteres)' }), pw), go));
      };
      body.append(el('p', { class: 'muted small', text: 'Use a resposta da sua pergunta de segurança e um dos códigos de recuperação. Depois de 3 erros o acesso fica bloqueado por 1 hora.' }), step, msg);
      askUser();
    });
  };

  // ---------- Horários (M3) ----------
  function hoursSheet(onSaved) {
    DG.sheet('Horários de funcionamento', async (body, close) => {
      body.append(DG.loading());
      let r;
      try { r = await DG.api('store_hours'); } catch (e) { body.replaceChildren(el('p', { class: 'error', text: e.message })); return; }
      const model = {};
      for (const [d] of DAYS) model[d] = [];
      for (const h of r.hours) if (model[h.weekday]) model[h.weekday].push({ opens: h.opens, closes: h.closes });
      const daysBox = el('div', { class: 'stack' });
      const msg = el('p', { class: 'error wrap', hidden: true });

      const paint = () => daysBox.replaceChildren(...DAYS.map(([d, name]) => {
        const rows = model[d].map((rg, i) => {
          const o = el('input', { type: 'time', value: rg.opens, 'aria-label': name + ' abre' });
          const c = el('input', { type: 'time', value: rg.closes, 'aria-label': name + ' fecha' });
          o.addEventListener('input', () => { rg.opens = o.value; });
          c.addEventListener('input', () => { rg.closes = c.value; });
          return el('div', { class: 'row' }, el('label', { class: 'field grow' }, el('span', { text: 'Abre' }), o), el('label', { class: 'field grow' }, el('span', { text: 'Fecha' }), c),
            el('button', { class: 'btn small danger', type: 'button', 'aria-label': 'Remover faixa', text: '×', on: { click: async () => {
              // P5: apagar a última faixa de um dia (ou de todos) deixa a loja fechada; pede confirmação.
              if (model[d].length === 1) {
                const total = DAYS.reduce((n, [k]) => n + model[k].length, 0);
                const aviso = total === 1 ? 'Sem nenhum horário, a loja fica fechada o tempo todo. Apagar mesmo assim?' : 'Sem horário, a loja fica fechada nesse dia. Apagar mesmo assim?';
                if (!(await DG.confirm(aviso, 'Apagar horário', true))) return;
              }
              model[d].splice(i, 1); paint();
            } } }));
        });
        return el('div', { class: 'card stack' }, el('strong', { text: name }),
          rows.length ? rows : el('p', { class: 'muted small', text: 'Sem horário: a loja fica fechada nesse dia.' }),
          el('div', { class: 'row wrap-row' },
            el('button', { class: 'btn small', type: 'button', text: '+ Faixa', disabled: model[d].length >= MAX_RANGES, on: { click: () => { model[d].push({ opens: '09:00', closes: '18:00' }); paint(); } } }),
            model[d].length ? el('button', { class: 'btn small', type: 'button', text: 'Copiar para...', on: { click: () => copyTo(d, name) } }) : null));
      }));

      const copyTo = (from, name) => {
        DG.sheet('Copiar horário de ' + name, (b2, close2) => {
          const picked = new Set();
          const chips = el('div', { class: 'chips a5-wrap-chips' });
          const draw = () => chips.replaceChildren(...DAYS.filter(([d]) => d !== from).map(([d, n]) => el('button', { class: 'chip', type: 'button', text: n, 'aria-pressed': String(picked.has(d)), on: { click: () => { if (picked.has(d)) picked.delete(d); else picked.add(d); draw(); } } })));
          draw();
          b2.append(el('p', { class: 'muted small', text: 'Escolha os dias que recebem o mesmo horário (os horários deles serão substituídos).' }), chips,
            el('button', { class: 'btn primary block', type: 'button', text: 'Copiar', on: { click: () => {
              if (!picked.size) { DG.toast('Escolha ao menos um dia.', true); return; }
              for (const d of picked) model[d] = model[from].map(x => ({ ...x }));
              close2(); paint(); DG.toast('Copiado. Lembre de salvar.');
            } } }));
        });
      };

      const validate = () => {
        for (const [d, name] of DAYS) {
          const list = model[d].map(x => ({ ...x }));
          for (const x of list) {
            if (!/^\d{2}:\d{2}$/.test(x.opens || '') || !/^\d{2}:\d{2}$/.test(x.closes || '')) return name + ': preencha abre e fecha.';
            if (x.closes <= x.opens) return name + ': o fechamento precisa ser depois da abertura.';
          }
          list.sort((a, b) => (a.opens < b.opens ? -1 : 1));
          for (let i = 1; i < list.length; i++) if (list[i].opens < list[i - 1].closes) return name + ': as faixas não podem se sobrepor.';
        }
        return null;
      };
      const save = el('button', { class: 'btn primary block', type: 'button', text: 'Salvar horários' });
      save.addEventListener('click', async () => {
        const problem = validate();
        if (problem) { msg.textContent = problem; msg.hidden = false; return; }
        msg.hidden = true; save.disabled = true;
        const hours = [];
        for (const [d] of DAYS) for (const x of model[d]) hours.push({ weekday: d, opens: x.opens, closes: x.closes });
        const res = await DG.run(() => DG.api('store_hours_save', { body: { hours } }), 'Horários salvos.');
        if (res && res.hours_warning === 'no_hours') DG.toast('Sem nenhum horário, a loja fica fechada o tempo todo.', true);
        if (res) { close(); onSaved(); } else save.disabled = false;
      });
      body.replaceChildren(el('p', { class: 'muted small', text: 'Horário de São Paulo. Dia sem horário fica fechado. Sem nenhum horário, a loja fica sempre fechada.' }), daysBox, msg, save);
      paint();
    });
  }

  function hoursCard(onChange) {
    const box = el('div', { class: 'card stack' }, DG.loading());
    const load = async () => {
      const r = await DG.api('store_hours').catch(() => null);
      if (!r) { box.replaceChildren(el('p', { class: 'error', text: 'Não consegui carregar os horários.' })); return; }
      const lines = DAYS.map(([d, name]) => {
        const rg = r.hours.filter(h => h.weekday === d).map(h => h.opens + ' às ' + h.closes);
        return el('div', { class: 'row between' }, el('span', { text: name }), el('span', { class: 'muted small', text: rg.length ? rg.join(' e ') : '-' }));
      });
      const noHours = r.hours_warning === 'no_hours' || !r.hours.length;
      box.replaceChildren(...(noHours ? [el('p', { class: 'a5-warn wrap', role: 'note', text: 'Nenhum horário cadastrado: a loja fica fechada o tempo todo. Cadastre os horários para ela abrir.' })] : lines),
        el('button', { class: 'btn block', type: 'button', text: 'Editar horários', on: { click: () => hoursSheet(() => { load(); if (onChange) onChange(); }) } }));
    };
    box.reload = load;
    load();
    return box;
  }

  // P1: fechar a loja (com prazo) e a programação de horários ficam juntos, na mesma seção.
  function hoursSection(catalog) {
    const state = DG.storeBox(catalog);
    return el('div', { class: 'stack' }, state, hoursCard(() => state.reload()));
  }

  // ---------- Frete (M5) ----------
  function shippingCard() {
    const box = el('div', { class: 'card stack' }, DG.loading());
    const load = async () => {
      const r = await DG.api('shipping_get').catch(() => null);
      if (!r) { box.replaceChildren(el('p', { class: 'error', text: 'Não consegui carregar o frete.' })); return; }
      const s = r.shipping;
      const rows = s.bands.map(b => el('div', { class: 'row between' }, el('span', { text: 'Até ' + b.max_km + ' km' }), el('strong', { text: DG.money(b.fee_cents) })));
      box.replaceChildren(
        el('dl', { class: 'kv' }, el('dt', { text: 'Origem' }), el('dd', { text: s.origin_address || '-' })),
        ...rows,
        el('p', { class: 'muted small', text: 'Retirada: ' + DG.money(0) + '. Acima de ' + s.max_km + ' km não entregamos.' }),
        isAdmin() ? el('button', { class: 'btn block', type: 'button', text: 'Editar frete', on: { click: () => shippingSheet(s, load) } }) : el('p', { class: 'muted small', text: 'Só o administrador edita o frete.' }));
    };
    load();
    return box;
  }

  function shippingSheet(s, onSaved) {
    DG.sheet('Frete por distância', (body, close) => {
      const bands = s.bands.map(b => ({ km: String(b.max_km).replace('.', ','), fee: DG.moneyInput(b.fee_cents) }));
      const origin = el('input', { type: 'text', maxlength: 200, value: s.origin_address || '' });
      const list = el('div', { class: 'stack' });
      const msg = el('p', { class: 'error wrap', hidden: true });
      const paint = () => list.replaceChildren(...bands.map((b, i) => {
        const km = el('input', { type: 'text', inputmode: 'decimal', value: b.km, 'aria-label': 'Até quantos km' });
        const fee = el('input', { type: 'text', inputmode: 'decimal', value: b.fee, 'aria-label': 'Valor em reais' });
        km.addEventListener('input', () => { b.km = km.value; });
        fee.addEventListener('input', () => { b.fee = fee.value; });
        return el('div', { class: 'row' }, el('label', { class: 'field grow' }, el('span', { text: 'Até (km)' }), km), el('label', { class: 'field grow' }, el('span', { text: 'Valor (R$)' }), fee),
          el('button', { class: 'btn small danger', type: 'button', 'aria-label': 'Remover faixa', text: '×', disabled: bands.length <= 1, on: { click: () => { bands.splice(i, 1); paint(); } } }));
      }));
      paint();
      const save = el('button', { class: 'btn primary block', type: 'button', text: 'Salvar frete' });
      save.addEventListener('click', async () => {
        const out = []; let last = 0;
        for (const b of bands) {
          const km = Number(String(b.km).replace(',', '.'));
          const cents = DG.parseMoney(b.fee);
          if (!Number.isFinite(km) || km <= 0) { msg.textContent = 'Informe os km de cada faixa (maior que zero).'; msg.hidden = false; return; }
          if (km <= last) { msg.textContent = 'As faixas precisam ir crescendo (3 km, 6 km, 10 km...).'; msg.hidden = false; return; }
          if (cents === null || Number.isNaN(cents)) { msg.textContent = 'Informe o valor de cada faixa, ex.: 6,00.'; msg.hidden = false; return; }
          out.push({ max_km: km, fee_cents: cents }); last = km;
        }
        msg.hidden = true; save.disabled = true;
        const r = await DG.run(() => DG.api('shipping_save', { body: { bands: out, origin_address: origin.value.trim() } }), 'Frete salvo.');
        if (r) { if (r.warning) DG.toast(r.warning); close(); onSaved(); } else save.disabled = false;
      });
      body.append(el('label', { class: 'field' }, el('span', { text: 'Endereço de origem (de onde sai a entrega)' }), origin),
        el('p', { class: 'muted small', text: 'Cada faixa vale até a distância indicada. Acima da última faixa não entregamos.' }), list,
        el('button', { class: 'btn block', type: 'button', text: '+ Adicionar faixa', on: { click: () => { bands.push({ km: '', fee: '' }); paint(); } } }), msg, save);
    });
  }

  // ---------- Pontos (regra editável; o servidor valida e calcula tudo) ----------
  const ptsWord = n => (n === 1 ? '1 ponto' : n.toLocaleString('pt-BR') + ' pontos');
  // Percentual do valor gasto que volta em desconto (só para orientar; o limite de verdade é do servidor).
  const returnPct = r => (r.points_per_real * r.block_value_cents) / r.block_points;
  const pctText = r => returnPct(r).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%';

  function pointsCard() {
    const box = el('div', { class: 'card stack' }, DG.loading());
    const load = async () => {
      const r = await DG.api('points_get').catch(() => null);
      if (!r) { box.replaceChildren(el('p', { class: 'error', text: 'Não consegui carregar a regra de pontos.' })); return; }
      const p = r.points, x = p.rules;
      box.replaceChildren(
        el('div', { class: 'row between' }, el('strong', { text: 'Programa de pontos' }),
          el('span', { class: 'pill ' + (x.enabled ? 'ok' : 'off'), text: x.enabled ? 'Ligado' : 'Desligado' })),
        el('dl', { class: 'kv' },
          el('dt', { text: 'Ganho' }), el('dd', { text: ptsWord(x.points_per_real) + ' a cada R$ 1,00 pago (sem o frete)' }),
          el('dt', { text: 'Resgate' }), el('dd', { text: ptsWord(x.block_points) + ' = ' + DG.money(x.block_value_cents) + ' de desconto' }),
          el('dt', { text: 'Volta' }), el('dd', { text: 'cerca de ' + pctText(x) + ' do valor gasto' })),
        x.enabled ? null : el('p', { class: 'a5-warn wrap', text: 'Desligado: os clientes não ganham pontos novos e não podem usar pontos. O saldo de cada um fica guardado.' }),
        isAdmin() ? el('button', { class: 'btn block', type: 'button', text: 'Editar pontos', on: { click: () => pointsSheet(p, load) } })
          : el('p', { class: 'muted small', text: 'Só o administrador edita a regra de pontos.' }));
    };
    load();
    return box;
  }

  function pointsSheet(p, onSaved) {
    DG.sheet('Regra de pontos', (body, close) => {
      const L = p.limits, D = p.defaults;
      const state = { ...p.rules };
      const num = (value, [min, max], label) => el('input', { type: 'number', inputmode: 'numeric', min, max, step: 1, value: String(value), 'aria-label': label });
      const perReal = num(state.points_per_real, L.points_per_real, 'Pontos por R$ 1,00');
      const block = num(state.block_points, L.block_points, 'Pontos por resgate');
      const value = el('input', { type: 'text', inputmode: 'decimal', value: DG.moneyInput(state.block_value_cents), 'aria-label': 'Desconto por resgate em reais' });
      const stateTxt = el('span', { class: 'state ' + (state.enabled ? 'on' : 'off'), text: state.enabled ? 'Ligado' : 'Desligado' });
      // Só muda o rascunho; grava no "Salvar pontos".
      const sw = DG.switchEl(state.enabled, 'Programa de pontos ligado', async next => {
        state.enabled = next; stateTxt.textContent = next ? 'Ligado' : 'Desligado'; stateTxt.className = 'state ' + (next ? 'on' : 'off'); return true;
      }, true);
      const preview = el('p', { class: 'muted small wrap', 'aria-live': 'polite' });
      const msg = el('p', { class: 'error wrap', hidden: true });

      // Lê os campos. Retorna { rules } ou { problem } (mensagem para a tela).
      const read = () => {
        const ints = [[perReal, L.points_per_real, 'Pontos por R$ 1,00'], [block, L.block_points, 'Pontos por resgate']].map(([input, [min, max], label]) => {
          const n = Number(input.value);
          return Number.isInteger(n) && n >= min && n <= max ? n : label + ': use um número inteiro de ' + min + ' a ' + max + '.';
        });
        const bad = ints.find(v => typeof v === 'string');
        if (bad) return { problem: bad };
        const cents = DG.parseMoney(value.value);
        const [vmin, vmax] = L.block_value_cents;
        if (cents === null || Number.isNaN(cents) || cents < vmin || cents > vmax) return { problem: 'Desconto por resgate: use um valor de ' + DG.money(vmin) + ' a ' + DG.money(vmax) + '.' };
        const rules = { enabled: state.enabled, points_per_real: ints[0], block_points: ints[1], block_value_cents: cents };
        if (returnPct(rules) > L.max_return_pct) return { problem: 'Com essa regra o cliente receberia mais de ' + L.max_return_pct + '% do valor gasto de volta. Aumente os pontos por resgate ou diminua o desconto.' };
        return { rules };
      };
      const paintPreview = () => {
        const { rules } = read();
        if (!rules) { preview.textContent = ''; return; }
        const spend = Math.ceil(rules.block_points / rules.points_per_real);
        preview.textContent = 'Exemplo: uma compra de ' + DG.money(5000) + ' rende ' + ptsWord(50 * rules.points_per_real) + '. Para ganhar '
          + DG.money(rules.block_value_cents) + ' de desconto o cliente precisa gastar ' + DG.money(spend * 100) + ' (volta cerca de ' + pctText(rules) + ').';
      };
      for (const i of [perReal, block, value]) i.addEventListener('input', () => { msg.hidden = true; paintPreview(); });
      paintPreview();

      const save = el('button', { class: 'btn primary block', type: 'button', text: 'Salvar pontos' });
      save.addEventListener('click', async () => {
        const { rules, problem } = read();
        if (problem) { msg.textContent = problem; msg.hidden = false; return; }
        if (p.rules.enabled && !rules.enabled && !(await DG.confirm('Desligar o programa de pontos? Os clientes param de ganhar e de usar pontos até você ligar de novo. O saldo deles fica guardado.', 'Desligar', true))) return;
        msg.hidden = true; save.disabled = true;
        const r = await DG.run(() => DG.api('points_save', { body: rules }), 'Regra de pontos salva.');
        if (r) { close(); onSaved(); } else save.disabled = false;
      });
      const reset = el('button', { class: 'btn block', type: 'button', text: 'Voltar ao padrão', on: { click: () => {
        perReal.value = String(D.points_per_real); block.value = String(D.block_points); value.value = DG.moneyInput(D.block_value_cents);
        msg.hidden = true; paintPreview(); DG.toast('Valores padrão preenchidos. Lembre de salvar.');
      } } });

      body.append(
        el('div', { class: 'card row between' }, el('div', { class: 'grow' }, el('strong', { text: 'Programa de pontos' }), el('p', {}, stateTxt)), sw),
        el('label', { class: 'field' }, el('span', { text: 'Pontos ganhos a cada R$ 1,00 pago (' + L.points_per_real[0] + ' a ' + L.points_per_real[1] + ')' }), perReal),
        el('div', { class: 'grid2' },
          el('label', { class: 'field' }, el('span', { text: 'Pontos por resgate' }), block),
          el('label', { class: 'field' }, el('span', { text: 'Desconto (R$)' }), value)),
        preview,
        el('p', { class: 'muted small wrap', text: 'Vale para os próximos pagamentos aprovados. Pontos já creditados e descontos já usados não mudam. O desconto nunca passa do valor dos produtos do pedido.' }),
        msg, save, reset);
    });
  }

  // ---------- Sinônimos ----------
  function synonymsCard() {
    const box = el('div', { class: 'stack' });
    const load = async () => {
      const r = await DG.api('synonyms').catch(() => null);
      if (!r) { box.replaceChildren(el('p', { class: 'error', text: 'Não consegui carregar os sinônimos.' })); return; }
      box.replaceChildren(
        ...(r.synonyms.length ? r.synonyms.map(x => el('div', { class: 'card row' },
          el('div', { class: 'grow' }, el('strong', { class: 'wrap', text: x.synonym }), el('p', { class: 'muted small wrap', text: 'vale como: ' + x.canonical })),
          el('button', { class: 'btn small', type: 'button', text: 'Editar', on: { click: () => edit(x) } }),
          el('button', { class: 'btn small danger', type: 'button', 'aria-label': 'Apagar ' + x.synonym, text: '×', on: { click: async () => {
            if (!(await DG.confirm('Apagar o sinônimo "' + x.synonym + '"?', 'Apagar', true))) return;
            if (await DG.run(() => DG.api('synonym_delete', { body: { id: x.id } }), 'Apagado.')) load();
          } } }))) : [DG.empty('Nenhum sinônimo cadastrado.')]),
        el('button', { class: 'btn block', type: 'button', text: 'Novo sinônimo', on: { click: () => edit(null) } }));
    };
    const edit = x => {
      DG.sheet(x ? 'Editar sinônimo' : 'Novo sinônimo', (body, close) => {
        const syn = el('input', { type: 'text', maxlength: 60, value: x ? x.synonym : '', placeholder: 'Ex.: oreo' });
        const can = el('input', { type: 'text', maxlength: 60, value: x ? x.canonical : '', placeholder: 'Ex.: biscoito oreo' });
        body.append(el('p', { class: 'muted small', text: 'Quando você pausar um ingrediente, o painel também procura pelos sinônimos.' }),
          el('label', { class: 'field' }, el('span', { text: 'Como você chama' }), syn), el('label', { class: 'field' }, el('span', { text: 'Nome no cardápio' }), can),
          el('button', { class: 'btn primary block', type: 'button', text: 'Salvar', on: { click: async () => {
            const b = { canonical: can.value.trim(), synonym: syn.value.trim() };
            if (x) b.id = x.id;
            if (await DG.run(() => DG.api('synonym_save', { body: b }), 'Salvo.')) { close(); load(); }
          } } }));
      });
    };
    load();
    return box;
  }

  // ---------- Segurança ----------
  function securityCard() {
    const box = el('div', { class: 'card stack' }, DG.loading());
    const load = async () => {
      const r = await DG.api('security_status').catch(() => null);
      if (!r) { box.replaceChildren(el('p', { class: 'error', text: 'Não consegui carregar.' })); return; }
      const s = r.security;
      box.replaceChildren(
        el('dl', { class: 'kv' },
          el('dt', { text: 'Pergunta' }), el('dd', { text: s.set ? s.question : 'Não cadastrada' }),
          el('dt', { text: 'Códigos' }), el('dd', { text: s.set ? s.codes_left + ' de 10 restantes' : '-' })),
        s.codes_left !== undefined && s.set && s.codes_left <= 3 ? el('p', { class: 'a5-warn', text: 'Poucos códigos restantes. Gere novos.' }) : null,
        el('button', { class: 'btn block', type: 'button', text: s.set ? 'Trocar pergunta' : 'Cadastrar pergunta', on: { click: () => changeQuestion(s.set, load) } }),
        s.set ? el('button', { class: 'btn block', type: 'button', text: 'Gerar novos códigos', on: { click: () => newCodes(load) } }) : null);
    };
    load();
    return box;
  }
  function showCodesSheet(codes, notice, after) {
    DG.sheet('Códigos de recuperação', (body, close) => body.append(codesView(codes, notice, () => { close(); after(); })));
  }
  async function changeQuestion(isSet, after) {
    let questions;
    try { questions = await loadQuestions(); } catch (e) { DG.toast(e.message, true); return; }
    DG.sheet(isSet ? 'Trocar pergunta' : 'Cadastrar pergunta', (body, close) => {
      body.append(questionForm(questions, isSet, r => { close(); showCodesSheet(r.codes || [], r.codes_notice, after); }));
    });
  }
  function newCodes(after) {
    DG.sheet('Gerar novos códigos', (body, close) => {
      const pw = el('input', { type: 'password', autocomplete: 'current-password', maxlength: 256 });
      const err = el('p', { class: 'error', hidden: true });
      body.append(el('p', { class: 'muted small', text: 'Os códigos antigos deixam de valer.' }), el('label', { class: 'field' }, el('span', { text: 'Senha atual' }), pw), err,
        el('button', { class: 'btn primary block', type: 'button', text: 'Gerar', on: { click: async () => {
          err.hidden = true;
          try { const r = await DG.api('recovery_codes_new', { body: { current_password: pw.value } }); close(); showCodesSheet(r.codes || [], r.codes_notice, after); } catch (ex) { err.textContent = ex.message; err.hidden = false; }
        } } }));
    });
  }

  DG.tabs.settings = {
    async render(view) {
      const catalog = await DG.loadCatalog();
      DG.setStoreBadge(!(catalog.storeState ? catalog.storeState.open : !catalog.settings.storePaused));
      view.replaceChildren(
        el('h2', { class: 'section-title', text: 'Horários e fechamento da loja' }), hoursSection(catalog),
        el('h2', { class: 'section-title', text: 'Frete' }), shippingCard(),
        el('h2', { class: 'section-title', text: 'Pontos' }), pointsCard(),
        el('h2', { class: 'section-title', text: 'Sinônimos de ingredientes' }), synonymsCard(),
        el('h2', { class: 'section-title', text: 'Loja' }), DG.storeCard(catalog),
        el('h2', { class: 'section-title', text: 'Segurança' }), securityCard());
    }
  };
})();
