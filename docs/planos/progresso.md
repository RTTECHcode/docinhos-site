# Progresso — Painel Gigi

Retomada: ler este arquivo, continuar da primeira tarefa não concluída. Tarefa em andamento recomeça do início na própria branch.

Status: pendente | andamento | feito | bloqueado

| ID | Status | Branch | Nota |
|---|---|---|---|
| F0 | feito | painel-v2 | skill presente; D2 resolvida; commits locais ok; banco só .env.dev |
| S1-S7 auditoria | feito | — | 13 achados: 2 Altos, 3 Médios, 8 Baixos; produção sem arquivos expostos |
| B2-B5, P1-P2 | feito | a4-fixes-admin, a9-polish | merge; P2 campo texto da pausa entrou na F5 |
| C1, C9 | feito | a6-fix-cart | merge; causa C1: modal fechando cobria tela 300ms; 20/20 taps ok |
| S-fix Crítico/Alto | feito | a2-security | merge em painel-v2 |
| O1-O13 | feito | a2-base | merge; contrato em docs/planos/api-contrato.md; migração só no banco dev |
| R0 | feito | a11-promo-doc | merge; docs/planos/promocoes-whatsapp.md; preços Meta a confirmar |
| K1-K5 | feito | a3-orders | merge; kanban, atividade recente, DG-#### |
| M1-M5 | feito | a5-settings | merge; abas Histórico e Ajustes; pausa em lote com desfazer |
| C2-C8 | feito | a6-store | merge; inclui pedido.html e privacidade.html |
| U1-U6 | feito | a10-account | merge após revisão A1 e correções |
| V1-V3 | feito | a7-design | merge; identidade preservada, contraste AA |
| Acabamento | feito | a9-polish | 4 rodadas; estados, textos, dados pessoais, bugs do QA |
| QA | feito | a8-qa | cerca de 450 checagens; 1 Médio e 2 Baixos corrigidos |
| Re-auditoria | feito | a2-fix-f5 | sem Crítico/Alto; achados corrigidos; ZAP pendente sem Docker/Java |
| Preview | feito | painel-v2 | publicado com F5; usa banco dev |
| Relatório | feito | painel-v2 | docs/planos/relatorio-final.md; aguarda aprovação do Renan |

## v3 — rodada de ajustes

Base: ajustes-v3 criada da painel-v3 (v2.1), que vai para a main.

| ID | Status | Branch | Nota |
|---|---|---|---|
| F0 | feito | ajustes-v3 | docs lidos; branch e seção criadas |
| F1 W1 | feito | v3-a1-webhook | 401 em todo webhook: segredo da Vercel difere do MP |
| F1 W2-W4, W6 | feito | v3-a1-webhook | fbaa7c9; conferência de reserva, back_urls, testes novos |
| F1 W5 | bloqueado | — | MP aprovado R$12 nos dois; Renan roda scripts/conferir-pagamento.js --aplicar |
| F2 D1-D8 | feito | v3-a2-backend | e429856; 2 migrações rodadas só na dev |
| F3 P1-P6 | feito | v3-a3-admin | ed7dd10; navegador ok; test-admin rerodar com banco parado |
| F3 L1-L8 | feito | v3-a4-loja | 609a508; 90 checagens no navegador ok |
| F4 V1-V7 | feito | v3-a5-design | c1ab0a8; V6 aprovada e aplicada; causa V4: popstate atrasado |
| F5 ressalvas A2 | feito | v3-a2-fix | 1cdb19b; testes ok no dev novo |
| F5 QA W/D/P/L | feito | v3-a6-qa | de5a64a; 14/14 scripts, 28 IDs ok, 1 Baixo corrigido |
| F5 QA V | andamento | v3-a6-qa | rodada 2 em dc46511 |
| F6 Relatório | andamento | ajustes-v3 | docs/planos/relatorio-v3.md; migrações prod e horários temporários feitos |

Banco dev trocado em 11/11 (antigo expirou): cópia da produção; migrações v3 rodadas; horários 00:00-23:59 só no dev.
