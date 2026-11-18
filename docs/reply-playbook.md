# Playbook de respostas (definido pelo Matheus, nov/2026)

Regras para classificar a última resposta do lead e decidir a ação. Fonte da verdade para o classificador
(`src/services/classifier.js`) e para o auto-reply da IA. **Ainda não aplicado no código** — só documentado.

## Nome usado na conversa
Podemos nos apresentar como Rob, Mark, Mitch ou outros nomes. **Sempre ler a primeira mensagem que NÓS enviamos**
na conversa para saber qual nome foi usado, e manter esse nome. (Nas conversas de 16–18/11 foi sempre "Mark".)

## 1. Resposta positiva (yes, sure, ok, qualquer interesse)
Enviar:
> Great...would love to connect and discuss what that looks like. We'll reach out after patient hours? Looking forward to connecting..

Ação extra: star (já é automático hoje).

## 2. Pergunta querendo detalhes (quem é você? qual empresa? qual prática? como conseguiu meu número?)
Usar a melhor das opções:

1. Thanks for the reply. I work with Menlo Dental Transitions and we work with practice owners looking to transition. My website is www.menlotransitions.com. You can find me, my partners and all of our listings there. I sense you might be trying to determine the validity to this text, completely understandable, and the best way to do that is jump on a call so we can discuss. Of course, no pressure whatsoever. Thx
2. Sure....I work with Menlo Dental Transitions. We represent sellers in most cases but can help with any part of a transition and have for a very long time.
3. Sure...we got your number from a publicly available list of practice owners. Would love to connect over the phone if interested? If not, I can remove your number.

Sugestão de uso: 1 = desconfiança/validade; 2 = "qual empresa / quem é"; 3 = "como conseguiu meu número / qual prática".

**Se nenhuma das 3 servir:** tentar responder a pergunta de forma breve, **apenas se soubermos a resposta**
(sem inventar números, nomes de compradores ou promessas), e terminar marcando uma ligação para explicar melhor
(ex.: "We'll reach out after patient hours?"). Esses rascunhos precisam de aprovação humana.

## 3. Quer se encontrar pessoalmente
Enviar:
> Happy to facilitate an in-person meeting. Let me connect you with my partner who lives nearby

E mandar o lead para a **Chrysete** (grafia correta, confirmada) com este texto no card do Slack:
> This person wants to meet in person. Please, mark as urgent

"Urgente" é só esse texto na mensagem (não é tag no Paladin). Implementado em `buildLeadCard({ urgent: true })`
([src/services/leadCard.js](../src/services/leadCard.js)).

## 4. Só ARQUIVAR (sem resposta)
Número errado, nome errado ("I'm not Dr X", "Wrong Mark"), tipo de cliente errado (não é dono de prática dentária),
não interessado, pediu para sair/bloquear, vendeu, aposentou, faleceu, ou qualquer coisa que impeça o contato.
**West Virginia: sempre apenas arquivar** (a Menlo não pode transacionar no estado).

## Roteamento — Califórnia
Sul da Califórnia: David Haynes, Mark Soelberg, Rob Brian, Marc Schubert.
Norte da Califórnia: Mark Soelberg, Rob Brian, Marc Schubert.
Divisão "no meio" do estado, com bom senso (definido em 18/11/2026): CEP 900–939 = Sul (inclui Fresno, Bakersfield,
Santa Barbara, SLO, Monterey/Salinas); 940–961 = Norte. O Paladin não traz CEP, então o código usa uma lista de cidades
(`routingMatrix.js`); cidade fora da lista fica "unresolved" para confirmação manual.

## Outros acordos
- Regiões inferidas (Midwest, Southeast, Northeast, WA/OR) confirmadas como corretas.
- Rodízio do Arizona agora fica no Postgres (`settings.az_rotation_index`), não mais em arquivo.
