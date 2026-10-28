/**
 * Recebe os cliques de botao do Slack (Interactivity & Shortcuts).
 *
 * SETUP NECESSARIO NO LADO DO SLACK (fora deste codigo, feito uma vez
 * no app do Slack em api.slack.com/apps):
 *   1. Abrir o app usado pelo SLACK_WEBHOOK_URL (ou criar um novo, se
 *      o Incoming Webhook atual nao tiver um app "de verdade" por tras).
 *   2. Menu lateral -> "Interactivity & Shortcuts" -> ativar o toggle.
 *   3. Em "Request URL", colocar https://<dominio-railway>/slack/interactions
 *   4. Salvar.
 *   5. Em "Basic Information" -> "App Credentials", copiar o
 *      "Signing Secret" e colocar em SLACK_SIGNING_SECRET (.env / Railway).
 *
 * NAO precisa de Bot Token nem do escopo chat:write: a confirmacao do
 * clique (trocar o botao por "✅ Sent" ou mostrar erro) e feita via
 * response_url, que o Slack manda em cada payload de interacao — isso
 * funciona mesmo com um app que so tem Incoming Webhook + Interactivity.
 *
 * FORMATO DO PAYLOAD: Slack manda application/x-www-form-urlencoded
 * com um unico campo "payload" contendo uma string JSON. Por isso a
 * rota precisa do corpo cru (raw) ANTES de express.urlencoded, do
 * mesmo jeito que o webhook da Paladin precisa do corpo cru para a
 * verificacao HMAC.
 */
const express = require('express');
const { verifySlackSignature } = require('../lib/verifySlackSignature');
const { sendMessage } = require('../services/paladinApiClient');

const router = express.Router();

router.post('/', async (req, res) => {
  const rawBody = req.body.toString('utf8');
  const timestamp = req.header('X-Slack-Request-Timestamp');
  const signature = req.header('X-Slack-Signature');

  const isValid = verifySlackSignature(process.env.SLACK_SIGNING_SECRET, rawBody, timestamp, signature);
  if (!isValid) {
    console.warn('[slack-interactions] Assinatura invalida — requisicao rejeitada.');
    return res.status(401).send('invalid_signature');
  }

  // Responde rapido (Slack exige <3s) e processa o envio de forma
  // assincrona, igual ao padrao ja usado no webhook da Paladin.
  res.status(200).send('');

  let payload;
  try {
    const params = new URLSearchParams(rawBody);
    payload = JSON.parse(params.get('payload'));
  } catch (err) {
    console.error('[slack-interactions] Payload invalido:', err);
    return;
  }

  if (payload.type !== 'block_actions') return;

  const action = (payload.actions || []).find((a) => a.action_id === 'send_reply');
  if (!action) return;

  handleSendReplyClick(action, payload).catch((err) => {
    console.error('[slack-interactions] Erro ao processar clique de Send:', err);
  });
});

async function handleSendReplyClick(action, payload) {
  let data;
  try {
    data = JSON.parse(action.value);
  } catch (err) {
    await replaceMessage(payload.response_url, '🛑 Internal error: could not read button data.');
    return;
  }

  const { contactId, text } = data;
  const clickedBy = payload.user?.username || payload.user?.name || 'someone';

  try {
    await sendMessage(contactId, text);
    await replaceMessage(
      payload.response_url,
      `✅ *Sent by ${clickedBy}:*\n>${text}`
    );
  } catch (err) {
    console.error('[slack-interactions] sendMessage falhou:', err.message);
    await replaceMessage(
      payload.response_url,
      `🛑 *Failed to send* (clicked by ${clickedBy}): ${err.message}\nReply manually in Paladin instead.`
    );
  }
}

/**
 * Substitui a mensagem original do Slack (onde o botao foi clicado)
 * por um texto simples de confirmacao/erro, usando o response_url que
 * o proprio Slack manda no payload de interacao. replace_original:true
 * remove os blocks antigos (incluindo o botao), evitando clique duplo.
 */
async function replaceMessage(responseUrl, text) {
  if (!responseUrl) return;
  try {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replace_original: true, text }),
    });
  } catch (err) {
    console.error('[slack-interactions] Falha ao atualizar mensagem via response_url:', err);
  }
}

module.exports = router;
