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
const { sendMessage, findContactById, getTagNameMap, toggleStarred, toggleArchived } = require('../services/paladinApiClient');
const { starredLabel, archivedLabel } = require('../services/slack');
const { buildLeadCard } = require('../services/leadCard');
const { postDm } = require('../services/slackDm');

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
  if (action) {
    handleSendReplyClick(action, payload).catch((err) => {
      console.error('[slack-interactions] Erro ao processar clique de Send:', err);
    });
    return;
  }

  const toggleAction = (payload.actions || []).find((a) => a.action_id === 'toggle_star' || a.action_id === 'toggle_archive');
  if (toggleAction) {
    handleToggleClick(toggleAction, payload).catch((err) => {
      console.error('[slack-interactions] Erro ao processar clique de Star/Archive:', err);
    });
    return;
  }

  const leadAction = (payload.actions || []).find((a) => String(a.action_id).startsWith('send_as_lead_'));
  if (leadAction) {
    handleSendAsLeadClick(leadAction, payload).catch((err) => {
      console.error('[slack-interactions] Erro ao processar clique de Send as lead:', err);
    });
  }
});

/**
 * Star/Archive: chama o toggle do Paladin e atualiza so o rotulo do botao
 * na propria mensagem (o resto — inclusive os outros botoes — fica igual).
 * Como e um toggle, o estado real vem na resposta do Paladin.
 */
async function handleToggleClick(action, payload) {
  const clickedBy = payload.user?.username || payload.user?.name || 'someone';
  const isStar = action.action_id === 'toggle_star';
  let contactId;
  try {
    ({ contactId } = JSON.parse(action.value));
  } catch (err) {
    await respond(payload.response_url, '🛑 Internal error: could not read button data.');
    return;
  }

  try {
    const result = isStar ? await toggleStarred(contactId) : await toggleArchived(contactId);
    const label = isStar ? starredLabel(result.starred) : archivedLabel(result.archived);
    const blocks = (payload.message?.blocks || []).map((b) =>
      b.type === 'actions'
        ? {
            ...b,
            elements: (b.elements || []).map((e) =>
              e.action_id === action.action_id ? { ...e, text: { type: 'plain_text', text: label, emoji: true } } : e
            ),
          }
        : b
    );
    await replaceMessage(payload.response_url, payload.message?.text || 'Lead update', blocks);
  } catch (err) {
    console.error('[slack-interactions] toggle falhou:', err.message);
    await respond(payload.response_url, `🛑 *Failed to ${isStar ? 'star' : 'archive'}* (clicked by ${clickedBy}): ${err.message}`);
  }
}

/**
 * "Send as lead": monta o card (dados do contato + conversa inteira + advisor)
 * e manda por DM para quem recebe as leads. O resultado e avisado como uma
 * mensagem nova no canal (replace_original:false), sem mexer nos botoes.
 */
async function handleSendAsLeadClick(action, payload) {
  const clickedBy = payload.user?.username || payload.user?.name || 'someone';
  let data;
  try {
    data = JSON.parse(action.value);
  } catch (err) {
    await respond(payload.response_url, '🛑 Internal error: could not read button data.');
    return;
  }
  const { contactId, advisor } = data;

  try {
    const contact = await findContactById(contactId);
    if (!contact) {
      await respond(payload.response_url, `🛑 *Could not send as lead*: contact not found in recent Paladin conversations. Forward it manually.`);
      return;
    }
    // Tags sao so um enfeite do card: se falhar, manda sem elas.
    const tagMap = await getTagNameMap().catch(() => null);
    const card = buildLeadCard({ contact, advisor, sentBy: clickedBy, tagMap });
    await postDm(card);
    await respond(payload.response_url, `📤 *${clickedBy}* sent this lead to Chrysete as *${advisor}'s* lead.`);
  } catch (err) {
    console.error('[slack-interactions] send as lead falhou:', err.message);
    await respond(payload.response_url, `🛑 *Failed to send as lead* (clicked by ${clickedBy}): ${err.message}\nForward it manually instead.`);
  }
}

// Mensagem nova no canal (nao substitui a original, ao contrario de replaceMessage).
async function respond(responseUrl, text) {
  if (!responseUrl) return;
  try {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_type: 'in_channel', replace_original: false, text }),
    });
  } catch (err) {
    console.error('[slack-interactions] Falha ao responder via response_url:', err);
  }
}

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
      `✅ *Sent by ${clickedBy}:*\n>${text}`,
      afterSendBlocks(payload.message?.blocks, `✅ *Sent by ${clickedBy}:*\n>${text}`)
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
async function replaceMessage(responseUrl, text, blocks) {
  if (!responseUrl) return;
  try {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(blocks ? { replace_original: true, text, blocks } : { replace_original: true, text }),
    });
  } catch (err) {
    console.error('[slack-interactions] Falha ao atualizar mensagem via response_url:', err);
  }
}

/**
 * Depois do "Send", tira so o botao Send e poe "Sent by ..." no lugar; os
 * outros botoes da mensagem (Star/Archive, "Send as lead", que normalmente
 * sao clicados depois de responder) continuam la. Devolve null se a
 * mensagem original nao veio com blocks (cai no replace so com texto).
 */
function afterSendBlocks(blocks, sentText) {
  if (!Array.isArray(blocks)) return null;
  const out = [];
  blocks.forEach((b) => {
    if (b.type === 'actions' && (b.elements || []).some((e) => e.action_id === 'send_reply')) {
      out.push({ type: 'section', text: { type: 'mrkdwn', text: sentText } });
      const rest = b.elements.filter((e) => e.action_id !== 'send_reply');
      if (rest.length) out.push({ ...b, elements: rest });
    } else {
      out.push(b);
    }
  });
  return out;
}

module.exports = router;
