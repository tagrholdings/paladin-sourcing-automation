const express = require('express');
const { verifyWebhookSignature } = require('../lib/verifySignature');
const { alreadyProcessed, markProcessed } = require('../lib/idempotency');
const sessionState = require('../lib/sessionState');
const { classifyMessage } = require('../services/classifier');
const { routeLead } = require('../services/routingMatrix');
const { lookupContact } = require('../services/contactLookup');
const { notifyError } = require('../services/slack');
const { toggleStarred, toggleArchived, sendMessage, getTagNameMap } = require('../services/paladinApiClient');
const { buildLeadCard } = require('../services/leadCard');
const { postDm, isLeadForwardingConfigured } = require('../services/slackDm');
const store = require('../services/store');

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
    return true;
  } catch (err) {
    console.error(`[webhook] Falha ao marcar conversa ${contactId} como starred:`, err.message);
    return false;
  }
}

async function safeToggleArchived(contactId) {
  try {
    await toggleArchived(contactId);
    return true;
  } catch (err) {
    console.error(`[webhook] Falha ao arquivar conversa ${contactId}:`, err.message);
    return false;
  }
}

const MAX_TRANSCRIPT_MESSAGES = 40;

/**
 * Monta a transcricao cronologica da conversa para o classificador.
 * A API devolve as mensagens do mais novo pro mais antigo; a mensagem
 * que acabou de chegar pode ou nao ja estar na lista (corrida com o
 * webhook), entao ela e removida se for a mais recente e igual a `currentText`
 * — o classificador ja recebe essa mensagem separadamente.
 */
function buildTranscript(messages, currentText) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const ordered = [...messages].reverse(); // cronologico
  const last = ordered[ordered.length - 1];
  if (last && last.direction === 'inbound' && String(last.text || '').trim() === String(currentText || '').trim()) {
    ordered.pop();
  }
  const lines = ordered
    .slice(-MAX_TRANSCRIPT_MESSAGES)
    .filter((m) => m.text)
    .map((m) => `${m.direction === 'outbound' ? 'Us (Mark/Rob)' : 'Lead'}: ${m.text}`);
  return lines.length ? lines.join('\n') : null;
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

  // Pausa dura: PAUSED=true no Railway. Devolve 503 (em vez de 2xx) para
  // a Paladin nao considerar a mensagem entregue. (O liga/desliga do painel
  // e diferente: aceita a mensagem e so registra, ver processInboundMessage.)
  if (process.env.PAUSED === 'true') {
    console.log('[webhook] Automacao pausada (PAUSED=true) — evento nao processado.');
    return res.status(503).json({ error: 'paused' });
  }

  // Cookie do Paladin expirado: pausa ate renovar (ver lib/sessionState.js).
  if (sessionState.isExpired()) {
    console.log('[webhook] Sessao do Paladin expirada — evento nao processado.');
    return res.status(503).json({ error: 'paladin_session_expired' });
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

/** Nome(s) do advisor dono da lead, para o card da Chrysete. */
function ownerLabel(routing) {
  const adv = routing?.advisors || [];
  if (!adv.length) return 'unassigned (confirm location)';
  // Arizona: o rodizio escolhe o primeiro (Schubert e so backup).
  if (/^Arizona rotation/.test(routing.note || '')) return adv[0];
  return adv.join(' / ');
}

async function resolveRouting(contact) {
  if (contact.state) {
    return routeLead({
      stateCode: contact.state,
      city: contact.city,
      zip: contact.address,
      isLargeOrMultiPractice: Boolean(contact.isLargeOrMultiPractice),
    });
  }
  return {
    advisors: [],
    confidence: 'unresolved',
    note:
      contact.source === 'lookup_error'
        ? 'Could not load this contact from Paladin (session/login problem). Confirm the location manually.'
        : 'Contact has no state on file in Paladin. Confirm the location manually.',
  };
}

/** Manda o card da lead pronta (positiva ou presencial) por DM para a Chrysete. */
async function forwardToChrysete({ contact, urgent }) {
  if (!isLeadForwardingConfigured()) {
    console.warn('[webhook] SLACK_DM_TOKEN/LEAD_RECIPIENT_SLACK_ID nao configurados — lead nao enviada para a Chrysete.');
    return;
  }
  try {
    if (!contact.raw) throw new Error('contact data unavailable (Paladin lookup failed)');
    const routing = await resolveRouting(contact);
    const tagMap = await getTagNameMap().catch(() => null);
    await postDm(buildLeadCard({ contact: contact.raw, advisor: ownerLabel(routing), tagMap, urgent }));
  } catch (err) {
    console.error('[webhook] Falha ao enviar lead para a Chrysete:', err.message);
    notifyError(`Could not forward lead ${contact.contactId} to Chrysete — forward it manually`, err);
  }
}

async function processInboundMessage(data) {
  const { messageId, contactId, text, from } = data;

  if (!messageId) {
    console.warn('[webhook] Mensagem sem messageId — pulando dedupe, processando mesmo assim.');
  } else if (alreadyProcessed(messageId)) {
    console.log(`[webhook] messageId ${messageId} ja processado — ignorando retentativa.`);
    return;
  }

  if (!text) {
    // MMS sem texto (so midia): nao da pra classificar. Fica registrado no
    // painel como "attention" para revisao manual; sem aviso no Slack.
    await store.recordInbound({
      contactId,
      messageId,
      text: '[no text — possible media]',
      category: 'attention',
      reasoning: 'Message with no text (likely MMS with media only) — review manually in Paladin.',
    });
    if (messageId) markProcessed(messageId);
    return;
  }

  // Automacao desligada pelo painel: so registra a mensagem (para aparecer
  // no painel), sem classificar, star/archive, auto-reply nem envio a Chrysete.
  if (!(await store.getBool('automation_enabled'))) {
    console.log('[webhook] Automacao desligada no painel — mensagem so registrada.');
    await store.recordInbound({ contactId, messageId, text });
    if (messageId) markProcessed(messageId);
    return;
  }

  // Busca o contato antes de classificar para dar a conversa inteira ao
  // classificador.
  const contact = await lookupContact(contactId);

  // West Virginia: a Menlo nao pode transacionar la — so arquiva, sem
  // gastar chamada de IA e sem nunca responder.
  const classification =
    contact.state === 'WV'
      ? { category: 'silent', reasoning: 'West Virginia — Menlo cannot transact in this state; archive only.', suggested_reply: null, reply_kind: null }
      : await classifyMessage({ leadText: text, priorContext: buildTranscript(contact.messages, text) });

  if (messageId) markProcessed(messageId);

  await store.recordInbound({
    contactId,
    messageId,
    text,
    category: classification.category,
    reasoning: classification.reasoning,
    suggestion: classification.suggested_reply,
    contact,
  });

  console.log(`[webhook] Lead ${from}: ${classification.category} — ${classification.reasoning}`);

  if (classification.category === 'silent') {
    // Auto-archive. So chama o toggle se ainda nao estiver arquivada (e um
    // toggle, nao um set). Se o lookup falhou (null), nao mexe.
    if (contact.archived === false) {
      if (await safeToggleArchived(contactId)) await store.setFlags(contactId, { archived: true });
    }
    return;
  }

  if (classification.category === 'attention') return; // fica no painel para revisao

  // Auto-star: positivas e quem quer encontro presencial (mesma regra de
  // toggle: so se ainda nao estiver starred).
  const wantsStar = classification.category === 'positive' || classification.category === 'in_person';
  if (wantsStar && contact.starred === false) {
    if (await safeToggleStarred(contactId)) await store.setFlags(contactId, { starred: true });
  }

  // Resposta automatica: so texto PRONTO (canned), com a chave ligada no
  // painel, no maximo uma vez (nada enviado ao contato nos ultimos 10 min).
  // Rascunhos "custom" nunca saem sozinhos: ficam no painel para aprovacao.
  if (
    classification.reply_kind === 'canned' &&
    classification.suggested_reply &&
    contactId &&
    (await store.getBool('ai_autoreply_enabled')) &&
    !(await store.sentRecently(contactId, 10))
  ) {
    try {
      await sendMessage(contactId, classification.suggested_reply);
      await store.recordOutbound({ contactId, text: classification.suggested_reply, source: 'ai' });
    } catch (err) {
      console.error(`[webhook] Auto-reply falhou para ${contactId}:`, err.message);
      notifyError(`Auto-reply failed for contact ${contactId} — reply manually`, err);
    }
  }

  // Lead pronta (positiva ou presencial) vai direto para a Chrysete.
  if (wantsStar) {
    await forwardToChrysete({ contact, urgent: classification.category === 'in_person' });
  }
}

module.exports = router;
