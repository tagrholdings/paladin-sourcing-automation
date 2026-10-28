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
- Sugere um rascunho de resposta.
- Para leads `positive`, marca a conversa como starred automaticamente
  no Paladin (ajuda a achar os leads quentes direto no dashboard deles).
  Leads `silent` são arquivados automaticamente. Os dois são "best
  effort": se falhar (ex.: cookie de sessão expirado), só loga o erro e
  segue o fluxo normal, sem travar a notificação do Slack.
- A notificação do Slack vem com um **botão "✅ Send"** ao lado da
  resposta sugerida (com confirmação antes de enviar de verdade). Ao
  clicar, manda a mensagem pelo Paladin sem precisar abrir o CRM. Exige
  configurar Interactivity no app do Slack — ver
  `src/routes/slackInteractions.js` para o passo a passo. Sem essa
  configuração, o botão aparece mas o clique falha silenciosamente (fica
  só a sugestão de texto, como antes).

**Faz (via API não oficial, desde 28/10/2026):**
- **Envia mensagens, star/archive de conversas, e busca dados do contato**
  (nome, cidade, estado, ocupação, bio) usando
  `src/services/paladinApiClient.js` — um cliente construído por
  engenharia reversa do dashboard do Paladin (captura de HAR), já que a
  API oficial documentada não oferece isso e o suporte deles (Arjun,
  contatado em 14/10 e 20/10/2026) não respondeu sobre o assunto até
  agora. **Leia o comentário no topo daquele arquivo** antes de mexer —
  cobre os endpoints confirmados, as limitações (sessão via cookie
  copiado manualmente, sem login automatizado ainda) e o risco de quebrar
  sem aviso se o Paladin mudar o frontend deles. Se/quando a Paladin
  responder com uma API oficial, migrar para ela.

**NÃO faz (de propósito, por enquanto):**
- **Não verifica a "regra zero" no Pipedrive automaticamente.** Não há
  integração com o Pipedrive neste projeto ainda. Toda notificação do
  Slack inclui um lembrete para você conferir isso manualmente.
- **Não sabe com certeza se um lead é grande/multi-prática.** Nenhum
  endpoint descoberto até agora sinaliza isso estruturadamente — continua
  dependendo de confirmação humana (ler a bio do contato ajuda, mas não é
  um campo confiável para automação).
- **Não tem login automatizado no Paladin.** O cookie de sessão usado
  pelo `paladinApiClient.js` precisa ser renovado manualmente de tempos
  em tempos (ver `.env.example`).
- **Não resolve estados fora da cobertura conhecida.** Além da matriz
  oficial (PDF da Menlo), o Mitch confirmou por fora em 22/10/2026:
  Alaska e Havaí → Rob Brian; Montana → Luke Kapper; Novo México →
  split 50/50 Craig Gibowicz/Mark Soelberg; Oklahoma → split 50/50
  Craig Gibowicz/Rob Brian; Delaware, Maryland, Virgínia e DC → Craig
  Gibowicz; **West Virginia → ninguém, a Menlo não pode transacionar
  nesse estado** (bloqueio legal/de licença, não falta de advisor).
  Qualquer outro estado fora dessas listas ainda mostra "⚠️ não
  coberto pela matriz" em vez de arriscar um palpite.

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

### Ativando o botão "Send" (opcional)

O app criado acima já serve de base — não precisa criar outro:

1. No mesmo app, menu lateral → **Interactivity & Shortcuts** → ativar o toggle.
2. Em **Request URL**, colocar `https://<seu-dominio-railway>/slack/interactions`.
3. Salvar.
4. Menu lateral → **Basic Information** → seção **App Credentials** →
   copiar o **Signing Secret** e colocar em `SLACK_SIGNING_SECRET` nas
   Variables do Railway.

Não precisa de Bot Token nem de escopos extras — a confirmação do clique
(trocar o botão por "✅ Sent" ou mostrar erro) usa o `response_url` que o
próprio Slack manda a cada interação, o que funciona só com Incoming
Webhook + Interactivity.

## Estrutura do projeto

```
src/
  index.js                     # bootstrap do Express, checa env vars obrigatórias
  routes/webhook.js             # recebe o POST /webhook, orquestra o fluxo
  routes/slackInteractions.js   # recebe cliques do botao "Send" no Slack
  lib/verifySignature.js        # verificação HMAC-SHA256 (webhook Paladin)
  lib/verifySlackSignature.js   # verificação de assinatura (interactivity Slack)
  lib/idempotency.js            # dedupe de retentativas (em memória)
  services/classifier.js        # classificação via Gemini
  services/routingMatrix.js     # matriz de roteamento da Menlo
  services/contactLookup.js     # busca dados do contato (via paladinApiClient)
  services/paladinApiClient.js  # cliente NAO OFICIAL da API do Paladin (engenharia reversa)
  services/slack.js             # envio das notificações
data/
  az-rotation-counter.json      # gerado em runtime, não versionado
```

## Próximos passos sugeridos

1. Se o suporte da Paladin responder com uma API oficial de contatos/envio/
   star/archive, migrar `paladinApiClient.js` para ela — o cliente atual
   não tem garantia de estabilidade (engenharia reversa do frontend deles).
2. Decidir junto ao gestor as regiões não cobertas pela matriz original
   (Havaí, Virgínia, West Virginia, Oklahoma, etc.) e atualizar
   `routingMatrix.js`.
3. Avaliar integração com o Pipedrive para checar a "regra zero"
   automaticamente.
4. Se o volume justificar, mover o contador do rodízio do Arizona e o
   dedupe de mensagens para um armazenamento durável (Postgres, por
   exemplo o próprio addon do Railway).
