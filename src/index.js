require('dotenv').config();
const express = require('express');
const webhookRouter = require('./routes/webhook');
const slackInteractionsRouter = require('./routes/slackInteractions');

const REQUIRED_ENV = [
  'PALADIN_WEBHOOK_SECRET',
  'GEMINI_API_KEY',
  'SLACK_WEBHOOK_URL',
];

// SLACK_SIGNING_SECRET so e obrigatorio se voce configurou o botao de
// "Send" no Slack (ver comentario de topo de routes/slackInteractions.js).
// Nao bloqueia o startup se faltar — so avisa, porque o resto do sistema
// funciona normalmente sem o botao (voce ainda responde manualmente).
if (!process.env.SLACK_SIGNING_SECRET) {
  console.warn(
    '[startup] SLACK_SIGNING_SECRET nao configurado — o botao "Send" do Slack nao vai funcionar ' +
    '(cliques serao rejeitados). Ver src/routes/slackInteractions.js para o passo a passo de setup.'
  );
}

const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(
    `[startup] Faltam variaveis de ambiente obrigatorias: ${missing.join(', ')}`
  );
  console.error(
    '[startup] Configure-as no Railway (Settings -> Variables) antes de usar em producao. Encerrando.'
  );
  process.exit(1);
}

const app = express();

// IMPORTANTE: o corpo precisa chegar como texto bruto (raw) ao verificador
// de assinatura HMAC, por isso o parsing do webhook acontece dentro da
// propria rota, nao aqui globalmente com express.json().
app.use('/webhook', express.raw({ type: 'application/json' }));

// Mesma logica para /slack/interactions: o Slack manda
// application/x-www-form-urlencoded (nao JSON), e precisamos do corpo
// cru para verificar a assinatura antes de parsear. Ver comentario de
// topo de routes/slackInteractions.js.
app.use('/slack/interactions', express.raw({ type: 'application/x-www-form-urlencoded' }));

app.use(express.json());

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'paladin-sourcing-automation' });
});

app.use('/webhook', webhookRouter);
app.use('/slack/interactions', slackInteractionsRouter);

app.use((err, _req, res, _next) => {
  console.error('[unhandled-error]', err);
  res.status(500).json({ error: 'internal_error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[startup] Servidor rodando na porta ${PORT}`);
});
