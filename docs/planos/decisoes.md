# Decisões registradas

## 2026-11-10 — Recuperação de senha sem e-mail (O9, U3)
Renan delegou a decisão ao Orquestrador. E-mail fica para uma rodada futura.

Admin:
- Recuperação exige resposta de segurança E um código de recuperação.
- 10 códigos de uso único são gerados no cadastro e na troca de pergunta. São mostrados uma única vez e guardados só em hash (scrypt).
- 3 erros bloqueiam por 1 h (por usuário e por IP). Resposta genérica, sem confirmar se o usuário existe.
- Ao trocar a senha: derrubar todas as sessões e registrar na auditoria.
- Se esquecer os dois: script local O12.

Cliente:
- Recuperação só com telefone + resposta de segurança.
- 5 erros bloqueiam por 30 min (por conta e por IP). Resposta genérica.
- Perguntas de uma lista fixa, sem respostas públicas (nada de "nome da mãe" ou "cidade natal"). Resposta normalizada (minúsculas, sem acento, trim), mínimo 3 caracteres, guardada em hash.
- Após recuperar: derrubar sessões e travar o resgate de pontos por 48 h, com aviso na tela.

Futuro: e-mail ou WhatsApp substituem ou complementam a pergunta.

## 2026-11-10 — Verificações de segurança extras
- Testes de regressão de segurança em scripts/test-*.js (A8, F5): sim.
- Varredura dinâmica (OWASP ZAP baseline) contra o servidor local (F5): sim, se Docker ou Java estiverem disponíveis; senão, registrar como pendência.
- GitHub secret scanning com push protection e Dependabot: ação do Renan, com guia, na entrega.

## 2026-11-10 — Outras
- B1 do checklist do QA = C1 (bug do carrinho). Usar só C1.
- Retirada tem frete R$ 0 (O5).
- Faixas de frete: valores de exemplo até o Renan definir no admin.

## 2026-11-10 — Consentimento de WhatsApp no cadastro (U1), vindo do plano R0
- Caixa separada, opcional, nunca pré-marcada, com link da política de privacidade e opção de sair ("SAIR" ou pela conta).
- Gravar versão do texto, data, IP e origem; histórico de aceite/saída/retorno em customer_consent_events.
- Campo para dupla confirmação futura; telefone em E.164; dia e mês de nascimento opcionais.

## 2026-11-10 — Rodada v3
- Base da ajustes-v3: painel-v3 (v2.1: limites no banco, pontos editáveis), para evitar conflito com a main antiga.
- F1 W1 (diagnóstico, só leitura) e F2 rodam em paralelo; W3 só começa depois do D-lib do A2 para não colidir em api/_lib.
- Banco de produção: só SELECT para diagnóstico. Migrações só no dev; produção vai para a lista do relatório.
