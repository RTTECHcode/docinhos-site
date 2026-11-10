# Plano: promoções por WhatsApp (Docinhos da Gigi)

Data da pesquisa: 10/11/2026. Só planejamento, sem código.

## 1. Resumo e recomendação

1. Dá para mandar promoção pelo WhatsApp de forma legal e segura usando a API oficial da Meta (WhatsApp Cloud API).
2. Marketing é cobrado por mensagem entregue: cerca de R$ 0,32 cada (valor a confirmar na tabela oficial). 300 clientes x 4 promoções/mês = cerca de R$ 386/mês.
3. Só se pode mandar para quem deu consentimento claro e registrado. Isso precisa estar certo no cadastro (U1) desde já.
4. Nunca usar robô não oficial: risco real de banir o número da loja.
5. **Recomendação:** começar pequeno. Fase 0 = acertar o consentimento no cadastro (custo zero). Depois, disparo manual em lotes pelo admin. Automatizar só se as vendas justificarem.

## 2. API oficial da Meta (Cloud API)

**O que é preciso**
- Conta no Meta Business Manager (portfólio empresarial) e uma conta WhatsApp Business (WABA).
- Verificação da empresa (CNPJ e documentos). Ajuda a subir o limite de envio e dá credibilidade.
- Número dedicado, que não pode estar ativo no app WhatsApp normal (chip novo ou fixo que receba código por ligação).
- Nome de exibição aprovado pela Meta (ex.: "Docinhos da Gigi"), compatível com o nome da empresa.
- Um app na Meta for Developers com token de acesso e URL de webhook (para status de entrega e respostas).

**Modelos (templates) de mensagem.** Fora da janela de 24 h, só se envia modelo aprovado pela Meta (aprovação costuma levar de minutos a 1 dia). Categorias:
- **Marketing:** promoções, novidades, cupons. É a que a Gigi vai usar. Mais cara.
- **Utility:** ligada a um pedido existente (confirmação, saiu para entrega). Bem mais barata.
- **Authentication:** códigos de verificação. Não será usada.

Exemplos em PT-BR (variáveis entre chaves duplas):
- Marketing: "Oi, {{1}}! Esta semana a caixa de brigadeiros gourmet está com {{2}}% de desconto. Peça até {{3}} no nosso site. Para não receber mais ofertas, toque em Sair."
- Marketing (pontos): "Oi, {{1}}! Você tem {{2}} pontos na Gigi, que valem R$ {{3}} de desconto. Use no próximo pedido. Para parar de receber, toque em Sair."
- Marketing (aniversário): "Parabéns, {{1}}! A Gigi preparou um presente: {{2}} de desconto hoje. Para não receber mais mensagens, toque em Sair."
- Utility: "Oi, {{1}}! Seu pedido {{2}} foi confirmado e sai para entrega em {{3}}."

Boas práticas: texto claro, sem enganar, botão de resposta rápida "Sair". Se a Meta achar que um modelo "utility" é promoção, reclassifica como marketing (e cobra como tal).

**Janela de 24 h.** Quando o cliente escreve para o número, abre-se uma janela de 24 h em que dá para responder com texto livre. Fora dela, só modelo. Promoção é sempre iniciada pela loja, então sempre usa modelo de marketing, cobrado.

**Custo (modelo vigente).** Desde 1/7/2025 a cobrança é por mensagem de modelo entregue, não mais por conversa. O preço depende da categoria e do código do país do destinatário (+55 = Brasil). Mensagens que o cliente envia para a loja não são cobradas.
- Valores do Brasil que encontrei em fontes de terceiros que citam a tabela da Meta (tabela em vigor desde 1/10/2026): **marketing R$ 0,3217 (cerca de US$ 0,0625)**; **utility, authentication e service R$ 0,0350 (cerca de US$ 0,0068)**. A página oficial da Meta não mostrou a tabela de forma legível para mim: **confirmar na tabela oficial antes de orçar**.
- A Meta só muda preços no primeiro dia de um trimestre, com aviso de pelo menos 1 mês. **Esses valores podem mudar a cada trimestre.**
- Cada número tem 1.000 mensagens de serviço grátis por mês. Cobrança em reais (BRL) disponível desde 1/7/2026; contas em dólar precisam migrar até 30/6/2027.
- Exemplo: 300 clientes x 4 promoções = 1.200 mensagens/mês x R$ 0,32 = **cerca de R$ 386/mês**. Com 2 promoções/mês: cerca de R$ 193. Só confirmação de pedido (utility): 300 x R$ 0,035 = cerca de R$ 10,50.
- Só paga o que foi entregue. Cliente sem WhatsApp não custa.

**Limites de envio (tiers).** Contam pessoas diferentes contatadas fora da janela de 24 h, em 24 h, por portfólio empresarial. Começa em **250/dia**; sobe para 2.000, 10.000, 100.000 e ilimitado. Para chegar a 2.000: verificar a empresa, ou enviar 2.000 mensagens entregues a números únicos em 30 dias com modelos de boa qualidade. Depois sobe sozinho se a qualidade for alta e usar metade do limite em 7 dias. Para 300 clientes, 250/dia já quase basta; a verificação da empresa resolve de vez.

**Qualidade do número.** Se muita gente bloquear ou denunciar a loja, a qualidade cai, o limite não sobe e modelos podem ser pausados. Por isso: só enviar a quem aceitou, frequência baixa, conteúdo útil, "Sair" fácil.

**Intermediários (BSP: Zenvia, Take Blip, Twilio, Gupshup etc.).** Dão painel pronto, suporte e campanhas, mas cobram mensalidade e/ou margem por mensagem, além da Meta. Como a Gigi terá painel próprio, a Cloud API direta é mais barata e dá controle. BSP só vale se o Renan não quiser mexer na integração. Sempre perguntar o valor total por mensagem.

**Por que NÃO usar automação não oficial** (bibliotecas que controlam o WhatsApp Web, "disparadores"): viola os termos do WhatsApp; os números são banidos com frequência, e perder o número da loja (que o cliente já conhece) é pior que qualquer economia. Também não dá prova de consentimento nem status confiável.

## 3. Opt-in e prova de consentimento

**O que gravar** (já previsto em U1): aceite (sim/não), data/hora, texto aceito, IP, data de opt-out. Acrescentar: versão do texto, origem (cadastro, checkout, painel) e telefone no momento do aceite.

**Texto sugerido (caixa não pré-marcada, separada dos termos de uso):**
> "Quero receber ofertas, promoções e novidades da Docinhos da Gigi pelo WhatsApp, no número informado. Posso cancelar quando quiser respondendo SAIR ou pelo site. Meus dados serão usados só para isso, conforme a Política de Privacidade."

Regras: opcional (não pode ser condição para comprar), específico para WhatsApp (não misturar com e-mail), sem caixa pré-marcada, com link para a política.

**Dupla confirmação (opcional, recomendada).** Após o cadastro, enviar uma mensagem utility: "Confirme que quer receber ofertas da Gigi: toque em Sim." Só vira "confirmado" após a resposta. Evita número digitado errado (alguém recebendo promoção sem ter pedido) e reforça a prova. Custo: cerca de R$ 0,035 por cliente.

**Como provar depois:** a ficha do cliente mostra o registro completo (data, texto, versão, IP) e o histórico de envios. Guardar cada versão do texto de consentimento. Em caso de reclamação, o ônus da prova é da loja (LGPD, art. 8º, §2º).

## 4. Segmentação (filtros no admin)

Todos os filtros partem de "consentimento ativo e sem opt-out":
- **Compraram nos últimos X dias** (ex.: 30): para novidades.
- **Gastaram acima de R$ Y** no período: clientes top, ofertas especiais.
- **Pontos parados:** saldo acima de N pontos e sem compra há X dias ("você tem R$ 15 em pontos").
- **Aniversariantes:** só se o cadastro coletar data de nascimento (ou dia/mês).
- **Inativos:** última compra há mais de X dias, ou nunca compraram.
- **Compra única:** para incentivar a segunda compra.

No admin: campos de número (dias, valor) e caixas de seleção combináveis com "e", contador ao vivo de quantos clientes batem, e botão para salvar o segmento com nome.

## 5. Aba "Promoções" no admin (telas)

1. **Lista de campanhas:** nome, modelo, segmento, status (rascunho, agendada, enviando, pausada, concluída), data e totais.
2. **Nova campanha:** nome interno; escolher **modelo aprovado** (lista sincronizada da Meta, só os aprovados); preencher variáveis (desconto, data) com prévia do texto como o cliente vê.
3. **Escolher segmento:** salvo ou novo.
4. **Prévia e custo:** "Vão receber: 212 clientes. Excluídos por falta de consentimento ou opt-out: 88. Custo estimado: 212 x R$ 0,32 = R$ 68." Avisar se passar do limite diário (tier) e em quantos dias terminará.
5. **Agendar:** enviar agora, em data/hora ou em lotes. Horário sugerido 9h-20h, evitar domingo à noite.
6. **Acompanhamento:** enviadas, entregues, lidas, falhas (com motivo), cliques em botão, opt-outs gerados, pedidos feitos depois (opcional). Botões pausar/continuar/cancelar.
7. **Envio de teste:** mandar a campanha só para o celular do dono antes de disparar.

## 6. Fila com limite de envio

- Ao iniciar a campanha, o sistema cria um registro por destinatário com status "pendente" (a fila fica no banco Neon).
- Um processador pega lotes pequenos (20 a 50), respeitando o limite diário do tier (ex.: 250/dia). Ir devagar protege a qualidade do número.
- **Re-tentativas:** falha temporária (rede, limite de taxa): até 3 tentativas com espera crescente. Falha definitiva (número inválido, sem WhatsApp): marcar e não repetir. Chave única por campanha e cliente evita envio duplicado.
- **Pausar:** botão que para o processador; o resto continua pendente. Pausa automática se a qualidade do número cair ou houver muitas falhas seguidas.
- **O Vercel Hobby só permite cron uma vez por dia.** Alternativas:
  1. **Disparo manual em lotes (começar por aqui):** botão "Enviar próximo lote de 50" no admin. Simples, sem custo; para 300 clientes são poucos cliques.
  2. **Cron diário da Vercel:** libera o lote do dia. Serve se a campanha pode levar alguns dias.
  3. **Serviço externo gratuito de agendamento** (ex.: cron-job.org, GitHub Actions agendado) chamando um endereço protegido por segredo a cada 5 a 10 minutos.
  4. **Fila externa** (ex.: Upstash QStash, plano gratuito): mais robusta; só vale se crescer.

  Funções do Hobby têm tempo máximo curto, então lotes pequenos por chamada.

## 7. Log por cliente e opt-out

**Log por envio:** cliente, campanha, modelo e versão, texto final, data/hora, ID da mensagem na Meta, status (na fila, enviada, entregue, lida, falhou), código e motivo do erro. Os status chegam pelo **webhook da Meta** (endereço HTTPS público, verificação de assinatura, resposta rápida). Na ficha do cliente: linha do tempo de tudo que recebeu.

**Opt-out:**
- Palavra **"SAIR"** (e variações: PARAR, CANCELAR, STOP) recebida pelo webhook: o sistema marca opt-out com data/hora **na hora** e confirma por mensagem (dentro da janela de 24 h aberta pela resposta do cliente).
- **Botão "Sair" no próprio modelo** (resposta rápida), tratado igual.
- O cliente também pode sair pelo site, e o admin pode registrar pedido feito por telefone.
- Efeito imediato: antes de cada envio, o sistema confere de novo o consentimento (mesmo com campanha já na fila).
- **Nunca reenviar** após opt-out. Novo aceite só por ação explícita do cliente, gravando nova prova. Não apagar o registro de opt-out: é ele que impede novo envio.

## 8. Checklist de LGPD (Lei 13.709/2018)

- [ ] **Base legal:** consentimento (art. 7º, I), livre, informado e inequívoco (art. 5º, XII; art. 8º), específico para esta finalidade.
- [ ] **Finalidade e transparência:** dizer no cadastro e na política que o WhatsApp é usado para ofertas (art. 6º, I e VI).
- [ ] **Minimização:** coletar só nome, telefone e, se necessário, aniversário (dia/mês basta). Sem dados sensíveis (art. 6º, III).
- [ ] **Revogação fácil e gratuita** a qualquer momento (art. 8º, §5º), com confirmação.
- [ ] **Direitos do titular** (art. 18): acesso, correção, exclusão, portabilidade; responder dentro do prazo (confirmar prazos na regulamentação da ANPD).
- [ ] **Retenção:** apagar ou anonimizar dados de quem pediu exclusão; manter só o mínimo para provar consentimento e opt-out. Definir prazo (validar com advogado).
- [ ] **Registro das operações** (art. 37): documento simples com quais dados, para quê, quem acessa, onde ficam.
- [ ] **Encarregado/contato** (art. 41): nome e e-mail na política de privacidade. Pequenos agentes podem ter obrigação simplificada, mas o canal precisa existir.
- [ ] **Compartilhamento:** Meta (WhatsApp), Vercel, Neon e Mercado Pago são operadores/fornecedores. Citar na política.
- [ ] **Segurança:** admin com senha forte e 2FA; token da Meta só em variável de ambiente, nunca no código.
- [ ] **Incidentes** (art. 48): plano simples (quem avisa quem); comunicar ANPD e titulares se houver risco relevante, no prazo da regulamentação vigente.
- [ ] **Política de privacidade** atualizada antes do primeiro envio.

Este documento não é parecer jurídico. Vale revisão rápida de advogado antes de lançar.

## 9. O que depende do cadastro (U1) e ajustes agora

**Depende do consentimento do cadastro:** quem pode receber (todo envio), prova em reclamação, opt-out, contagem da prévia da campanha, segmento de aniversariantes.

**Ajustes recomendados no U1 agora, para não pedir de novo:**
1. Caixa **separada e não pré-marcada** só para WhatsApp, com o texto da seção 3 (evitar texto vago como "aceito receber contatos").
2. Gravar a **versão do texto** (ou o texto completo) em cada aceite, além de data/hora e IP.
3. Telefone em formato internacional (+55DDD...) e normalizado, para casar com o WhatsApp.
4. Campo de **origem** do consentimento (cadastro, checkout, painel) e de **confirmado** (dupla confirmação futura).
5. Opcional: **dia/mês de nascimento**, com finalidade explicada. Sem isso agora, aniversariantes exigiriam novo consentimento.
6. **Histórico** de mudanças (aceitou, saiu, voltou), não só o último estado.
7. No texto, dizer que as mensagens vêm do WhatsApp da loja e que dá para sair com "SAIR".
8. Link para a política de privacidade na própria caixa.

## 10. Esforço e custos

| Fase | O quê | Esforço |
|---|---|---|
| 0 (agora) | Ajustes de consentimento no U1, política de privacidade | 0,5 a 1 dia |
| 1 | Conta Meta, verificação da empresa, número, nome de exibição, 2 ou 3 modelos aprovados | 2 a 5 dias (maior parte é espera da Meta) |
| 2 | Webhook (status e SAIR), log por cliente, envio de teste | 3 a 5 dias |
| 3 | Aba Promoções: segmentos, prévia e custo, disparo manual em lotes | 5 a 8 dias |
| 4 | Agendamento, fila com cron diário/externo, pausa, re-tentativas, relatórios | 4 a 6 dias |

**Custo mensal:**
- Meta, marketing: cerca de R$ 0,32 por mensagem entregue. 300 clientes: 1 promoção/mês = ~R$ 97; 2 = ~R$ 193; 4 = ~R$ 386 (sujeito a mudança trimestral).
- Utility (pedido confirmado): ~R$ 0,035 por mensagem.
- Número/chip: ~R$ 15 a 30/mês.
- Vercel Hobby, Neon e agendador externo gratuito: R$ 0.
- BSP, se usar: mensalidade extra, a consultar.
- **Total realista para começar: R$ 100 a 200/mês.** Medir se a promoção gera mais venda que o custo.

## Fontes

- Preços da plataforma (Meta): https://developers.facebook.com/docs/whatsapp/pricing
- Tabela de preços (WhatsApp Business): https://whatsappbusiness.com/pt-br/products/platform-pricing/
- Limites de mensagens e tiers: https://developers.facebook.com/docs/whatsapp/messaging-limits
- Valores do Brasil citados por terceiros (conferir na Meta): https://zynfo.ai/whatsapp-pricing/brazil e https://vectalk.com.br/blog/en/whatsapp-api-pricing-brazil/
- LGPD, texto da lei: https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm
- ANPD (guias e orientações): https://www.gov.br/anpd/pt-br

Limites desta pesquisa: não consegui ler a tabela oficial da Meta com os valores de marketing/utility do Brasil (a página não renderizou); os valores vêm de blogs de terceiros. Prazos da ANPD e regras de categorias de modelos não foram verificados nas fontes primárias; conferir antes de implementar.
