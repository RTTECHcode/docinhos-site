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
| F1 W5 | feito | — | Renan rodou conferir-pagamento.js; DG-7747 e DG-5401 aprovados |
| F2 D1-D8 | feito | v3-a2-backend | e429856; 2 migrações rodadas só na dev |
| F3 P1-P6 | feito | v3-a3-admin | ed7dd10; navegador ok; test-admin rerodar com banco parado |
| F3 L1-L8 | feito | v3-a4-loja | 609a508; 90 checagens no navegador ok |
| F4 V1-V7 | feito | v3-a5-design | c1ab0a8; V6 aprovada e aplicada; causa V4: popstate atrasado |
| F5 ressalvas A2 | feito | v3-a2-fix | 1cdb19b; testes ok no dev novo |
| F5 QA W/D/P/L | feito | v3-a6-qa | de5a64a; 14/14 scripts, 28 IDs ok, 1 Baixo corrigido |
| F5 QA V | feito | v3-a6-qa | 1035de3; V1-V7 ok; 20 adições ok em 4 tamanhos |
| F6 Relatório | feito | ajustes-v3 | docs/planos/relatorio-v3.md; aguarda Renan publicar e rodar W5 |

Banco dev trocado em 11/11 (antigo expirou): cópia da produção; migrações v3 rodadas; horários 00:00-23:59 só no dev.

## v4 — clube por itens, cupons, relatórios, mimo e Altos das auditorias

Base: branch v4 criada da main (bff189f). Plano: docs/planos/plano-v4.md. Regras dos agentes: %LOCALAPPDATA%/gigi-tools/REGRAS-V4.md.

| ID | Status | Branch | Nota |
|---|---|---|---|
| F0 A1 | feito | v4 | 4795c53; 0 Crítico, 2 Altos (S-01, O-01) |
| F0 A5 | feito | v4 | c481d6f; 0 Crítico, 8 Altos (U-01 a U-06, P-01, P-02) |
| F1 | feito | v4 | c481d6f; seção 2 do plano com os 10 Altos e 10 Médios/Baixos que entram |
| F2 A2 | feito | v4-a2 | 89c63af; N1-N11 backend, Altos do A2, push sem dependência; 15 suítes ok; migração v4 rodada só no dev |
| F4 A5 antecipada | feito | v4-a5 | 7a5d893; logo 1,7 MB para 9 KB, OG, CLS 0,47 para 0,00, morango/chocolate, N9, U-11 |
| F3 A4 | feito | v4-a4 | 9e15662; N1-N3, N6-N8, N10, N11, U-01 a U-05, U-08 a U-10, X-01, P-06, P-12; 39 prints |
| F3 A2 extra | em andamento | v4-a2 | retry_payment, tracking_url, itens/bairro no rastreio, MIME do dev-server, points_save |
| F3 A3 | feito | v4-a3 | 5972489; N1, N3-N6, N8, N10, N11, U-06 (som, PWA, push), O-01; 44 prints |
| F4 A5 revisão | feito | v4-a5 | 6c46ab2; só CSS: toque 44 px, Quando? em 360, pós-pagamento, foco, barra do Clube; prints "depois" interrompidos por falta de memória (A6 cobre na F5) |
| F5 A6, A1 | aguardando | — | |
| F6 Netlify | aguardando | — | migração (plano seção 5); deploy só com o Renan |
| F7 Polimento | aguardando | — | limpeza e polimento (plano seção 6) |
| F8 | aguardando | — | relatorio-v4.md com passo a passo do Renan |

Pendências do A5 para a F3: A4 aplica morango/chocolate no Quem somos, faixa de confiança, P-06, P-12. Fora da faixa de todos (vão para o A4 na F3): vercel.json e raiz de public/ (P-04 cache do menu, P-05 cache de estáticos, P-07 fontes locais + CSP, P-09 robots/sitemap, P-10 404, manifest da loja).

Domínio docinhosdagigioz.com.br registrado em 14/11/2026 (vence 14/11/2027), ainda sem apontar.

Para a F7 (achados do A5 na F4): placeholder da busca do painel cortado em 360 ao lado de "Ativar som" (A3); faixa O-01 alta demais no celular (A3); cartão "Frete" sozinho na faixa de confiança em 2 colunas (A4); links de nova aba sem aviso (A3/A4).
