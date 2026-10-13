require('dotenv').config();
const express = require('express');
const webhookRouter = require('./routes/webhook');

const REQUIRED_ENV = [
  'PALADIN_WEBHOOK_SECRET',
  'OPENAI_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
];

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
app.use(express.json());

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'paladin-sourcing-automation' });
});

app.use('/webhook', webhookRouter);

app.use((err, _req, res, _next) => {
  console.error('[unhandled-error]', err);
  res.status(500).json({ error: 'internal_error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[startup] Servidor rodando na porta ${PORT}`);
});
