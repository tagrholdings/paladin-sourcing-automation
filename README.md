# Paladin Sourcing — Automação de triagem de leads

Escuta as respostas recebidas no Paladin Sourcing via webhook, classifica cada
uma com IA (positiva / silenciosa / precisa de atenção), tenta sugerir o
advisor da Menlo pela matriz de roteamento, e avisa no Slack só quando
vale a pena olhar.

## ⚠️ Antes de tudo: segurança

Se você chegou aqui depois de colar um token da Paladin ou uma chave da
Gemini em algum chat, **revogue e gere credenciais novas** antes de colocar
isso em produção:
- Gemini: https://aistudio.google.com/apikey
- Paladin: Settings → Integrations/API no painel

Nenhuma credencial deve estar no código. Tudo vem de variáveis de ambiente
(`.env` local, ou Variables no Railway).

## O que este projeto faz (e o que não faz)

**Faz:**
- Recebe o webhook `message.inbound` da Paladin e verifica a assinatura HMAC.
- Classifica a mensagem com IA em `positive`, `silent` ou `attention`.
- Para `positive`/`attention`, tenta sugerir um advisor pela matriz de
  roteamento da Menlo (quando a localização do lead é conhecida).
- Manda uma notificação formatada no Slack só para `positive` e
  `attention` — `silent` só é logado.
- Sugere um rascunho de resposta (você ainda entra no CRM do Paladin e
  envia manualmente).

**NÃO faz (de propósito, por enquanto):**
- **Não envia mensagens pelo Paladin.** Não há API de envio confirmada na
  documentação que recebemos — só webhooks de recebimento. Você ainda
  responde manualmente no CRM.
- **Não verifica a "regra zero" no Pipedrive automaticamente.** Não há
  integração com o Pipedrive neste projeto ainda. Toda notificação do
  Slack inclui um lembrete para você conferir isso manualmente.
- **Não sabe o nome/cidade/estado do contato com certeza.** O payload do
  webhook só traz `contactId`, telefone e texto — não traz dados
  cadastrais. Até confirmarmos com o suporte da Paladin se existe uma API
  de contatos, `src/services/contactLookup.js` é um placeholder que
  retorna "desconhecido", e a notificação avisa que isso precisa ser
  conferido no CRM.
- **Não resolve estados que a matriz original não cobre** (Havaí, Virgínia,
  West Virginia, Oklahoma, etc.) — nesses casos a notificação mostra
  "⚠️ não coberto pela matriz" em vez de arriscar um palpite.

## Rodando localmente

```bash
npm install
cp .env.example .env
# preencha o .env com suas credenciais
npm run dev
```

O servidor sobe em `http://localhost:3000`. `/health` retorna `200 OK` para
checagem rápida.

Para testar localmente, o Paladin precisa alcançar seu computador por HTTPS
— use algo como `ngrok http 3000` e cole a URL do ngrok como webhook URL no
painel da Paladin (lembre de trocar depois pela URL do Railway).

## Deploy no Railway

1. No Railway, **New Project → Deploy from GitHub repo** e selecione este
   repositório.
2. Em **Variables**, adicione todas as chaves do `.env.example` (com valores
   reais — nunca os que já foram expostos em chat).
3. O Railway detecta o `package.json` e roda `npm start` automaticamente.
   Não precisa configurar build command manualmente.
4. Depois do primeiro deploy, o Railway te dá uma URL pública
   (`https://seu-projeto.up.railway.app` ou similar). Se não vier com
   domínio público, ative em **Settings → Networking → Generate Domain**.
5. Sua URL de webhook é `https://<seu-dominio-railway>/webhook`.

### ⚠️ Persistência do contador de rodízio do Arizona

O contador que alterna Haynes/Haynes/Soelberg no rodízio do Arizona é salvo
em um arquivo local (`data/az-rotation-counter.json`). No plano padrão do
Railway, o sistema de arquivos **não é durável** entre deploys — a cada novo
deploy o contador reseta a zero. Para resolver de verdade: anexar um volume
persistente no Railway, ou (melhor) migrar esse contador para um campo no
Pipedrive ou um banco de dados. Enquanto isso, o impacto é pequeno (o pior
caso é a sequência do rodízio ficar um pouco desbalanceada).

## Configurando o webhook na Paladin

1. No painel da Paladin: **Settings → Integrations → Webhooks → Add Webhook**.
2. Cole a URL `https://<seu-dominio-railway>/webhook`.
3. Copie o **secret** mostrado (só aparece uma vez!) e coloque em
   `PALADIN_WEBHOOK_SECRET` nas Variables do Railway.
4. Use o botão de teste (ícone de tubo de ensaio) para confirmar que o
   endpoint responde `200 OK`.

## Criando o Incoming Webhook do Slack

1. Acesse **api.slack.com/apps → Create New App → From scratch** (ou
   "Blank app"), escolha um nome (ex.: "Menlo Leads Bot") e o workspace.
2. No menu lateral do app, abra **Incoming Webhooks** e ative o toggle.
3. Clique em **Add New Webhook to Workspace** e escolha o canal onde as
   notificações devem cair (ex.: `#leads-menlo`, ou uma DM sua).
4. Copie a URL gerada (formato
   `https://hooks.slack.com/services/XXXXX/YYYYY/ZZZZZ`) e coloque em
   `SLACK_WEBHOOK_URL` nas Variables do Railway.

Custo: o plano gratuito do Slack permite até 10 apps instalados, o que
cobre esse uso tranquilamente — não há cobrança por mensagem recebida via
webhook.

Se o workspace for de uma organização (não pessoal), a criação do app pode
pedir aprovação de um administrador do workspace.

## Estrutura do projeto

```
src/
  index.js                 # bootstrap do Express, checa env vars obrigatórias
  routes/webhook.js         # recebe o POST /webhook, orquestra o fluxo
  lib/verifySignature.js    # verificação HMAC-SHA256
  lib/idempotency.js        # dedupe de retentativas (em memória)
  services/classifier.js    # classificação via Gemini
  services/routingMatrix.js # matriz de roteamento da Menlo
  services/contactLookup.js # placeholder — dados do contato (nome/cidade/estado)
  services/slack.js         # envio das notificações
data/
  az-rotation-counter.json  # gerado em runtime, não versionado
```

## Próximos passos sugeridos

1. Confirmar com o suporte da Paladin se existe uma API de contatos (nome,
   cidade, estado por `contactId`) — isso é o que falta para o roteamento
   funcionar automaticamente na maioria dos leads.
2. Decidir junto ao gestor as regiões não cobertas pela matriz original
   (Havaí, Virgínia, West Virginia, Oklahoma, etc.) e atualizar
   `routingMatrix.js`.
3. Avaliar integração com o Pipedrive para checar a "regra zero"
   automaticamente.
4. Se o volume justificar, mover o contador do rodízio do Arizona e o
   dedupe de mensagens para um armazenamento durável (Postgres, por
   exemplo o próprio addon do Railway).
