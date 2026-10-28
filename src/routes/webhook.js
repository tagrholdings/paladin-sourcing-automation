const express = require('express');
const { verifyWebhookSignature } = require('../lib/verifySignature');
const { alreadyProcessed, markProcessed } = require('../lib/idempotency');
const { classifyMessage } = require('../services/classifier');
const { routeLead } = require('../services/routingMatrix');
const { lookupContact } = require('../services/contactLookup');
const { notifyLead, notifyError } = require('../services/slack');
const { toggleStarred, toggleArchived } = require('../services/paladinApiClient');

/**
 * Star/archive automaticos via a API nao oficial do Paladin
 * (paladinApiClient.js). "Best effort": se PALADIN_SESSION_COOKIE nao
 * estiver configurado ou a sessao tiver expirado, so loga o erro e
 * segue o fluxo normalmente — nunca deixa isso quebrar a notificacao
 * no Slack, que e a parte mais importante.
 */
async function safeToggleStarred(contactId) {
  try {
    await toggleStarred(contactId);
  } catch (err) {
    console.error(`[webhook] Falha ao marcar conversa ${contactId} como starred:`, err.message);
  }
}

async function safeToggleArchived(contactId) {
  try {
    await toggleArchived(contactId);
  } catch (err) {
    console.error(`[webhook] Falha ao arquivar conversa ${contactId}:`, err.message);
  }
}

const router = express.Router();

router.post('/', async (req, res) => {
  // req.body chega como Buffer por causa do express.raw() configurado
  // em index.js — precisamos dele cru para a verificacao HMAC.
  const rawBody = req.body.toString('utf8');
  const signature = req.header('X-Webhook-Signature');
  const eventType = req.header('X-Webhook-Event-Type');

  const isValid = verifyWebhookSignature(process.env.PALADIN_WEBHOOK_SECRET, rawBody, signature);
  if (!isValid) {
    console.warn('[webhook] Assinatura invalida — requisicao rejeitada.');
    return res.status(401).json({ error: 'invalid_signature' });
  }

  // Pausa manual: PAUSED=true no Railway. Devolve 503 (em vez de 2xx) para
  // a Paladin nao considerar a mensagem entregue.
  if (process.env.PAUSED === 'true') {
    console.log('[webhook] Automacao pausada (PAUSED=true) — evento nao processado.');
    return res.status(503).json({ error: 'paused' });
  }

  // Responde 2xx imediatamente (dentro dos 10s exigidos pela Paladin)
  // e processa de forma assincrona, conforme best practice da doc.
  res.status(200).json({ received: true });

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    console.error('[webhook] Corpo nao era JSON valido apos verificacao de assinatura:', err);
    return;
  }

  if (eventType !== 'message.inbound' || payload.event !== 'message.inbound') {
    // Reservado para futuros tipos de evento que a Paladin venha a adicionar.
    console.log(`[webhook] Evento ignorado (tipo: ${eventType || payload.event})`);
    return;
  }

  processInboundMessage(payload.data).catch((err) => {
    console.error('[webhook] Erro ao processar mensagem:', err);
    notifyError('Failed to process an inbound message from Paladin', err);
  });
});

async function processInboundMessage(data) {
  const { messageId, contactId, text, from } = data;

  if (!messageId) {
    console.warn('[webhook] Mensagem sem messageId — pulando dedupe, processando mesmo assim.');
  } else if (alreadyProcessed(messageId)) {
    console.log(`[webhook] messageId ${messageId} ja processado — ignorando retentativa.`);
    return;
  }

  if (!text) {
    // MMS sem texto, so midia. Fora do escopo deste MVP: sinaliza para
    // revisao manual em vez de tentar classificar algo que nao existe.
    await notifyLead({
      category: 'attention',
      reasoning: 'Message received with no text (likely an MMS with media only) — review manually in Paladin.',
      suggestedReply: null,
      leadText: '[no text — possible media]',
      fromPhone: from,
    });
    if (messageId) markProcessed(messageId);
    return;
  }

  const classification = await classifyMessage({ leadText: text });

  if (messageId) markProcessed(messageId);

  if (classification.category === 'silent') {
    console.log(`[webhook] Lead ${from} classificada como silenciosa: ${classification.reasoning}`);
    // Auto-archive: tira conversas mortas (opt-out, recusa clara) da
    // visao principal. So chama o toggle se ainda nao estiver
    // arquivada (e um toggle, nao um set — chamar sem checar
    // desarquivaria uma conversa ja arquivada por outra mensagem).
    const contactForArchive = await lookupContact(contactId);
    if (contactForArchive.archived === false) {
      await safeToggleArchived(contactId);
    }
    return;
  }

  // positive ou attention: busca dados do contato (hoje, placeholder —
  // ver contactLookup.js) e tenta sugerir um roteamento.
  const contact = await lookupContact(contactId);

  // Auto-star: so para "positive" (lead com interesse real confirmado),
  // e so se ainda nao estiver starred (mesmo motivo do archive acima —
  // e toggle, nao set).
  if (classification.category === 'positive' && contact.starred === false) {
    await safeToggleStarred(contactId);
  }

  let routing = null;
  if (contact.state) {
    routing = routeLead({
      stateCode: contact.state,
      city: contact.city,
      isLargeOrMultiPractice: Boolean(contact.isLargeOrMultiPractice),
    });
  } else {
    routing = {
      advisors: [],
      confidence: 'unresolved',
      note: 'Contact location unknown (the webhook does not include it). Confirm manually in the Paladin CRM before routing.',
    };
  }

  await notifyLead({
    category: classification.category,
    reasoning: classification.reasoning,
    suggestedReply: classification.suggested_reply,
    leadText: text,
    fromPhone: from,
    routing,
    contactId,
  });
}

module.exports = router;
