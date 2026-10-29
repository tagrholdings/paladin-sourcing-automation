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
const { starredLabel, archivedLabel, postToSlack } = require('../services/slack');
const { buildLeadCard } = require('../services/leadCard');
const { postDm, openModal } = require('../services/slackDm');

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

  let payload;
  try {
    const params = new URLSearchParams(rawBody);
    payload = JSON.parse(params.get('payload'));
  } catch (err) {
    console.error('[slack-interactions] Payload invalido:', err);
    return res.status(200).send('');
  }

  // Envio do modal "Edit & send": valida o texto na hora (a resposta pode
  // devolver erro para o campo) e processa o envio de forma assincrona.
  if (payload.type === 'view_submission') {
    return handleViewSubmission(payload, res);
  }

  // Responde rapido (Slack exige <3s) e processa o envio de forma
  // assincrona, igual ao padrao ja usado no webhook da Paladin.
  res.status(200).send('');

  if (payload.type !== 'block_actions') return;

  const editAction = (payload.actions || []).find((a) => a.action_id === 'edit_send');
  if (editAction) {
    handleEditSendClick(editAction, payload).catch((err) => {
      console.error('[slack-interactions] Erro ao abrir Edit & send:', err);
    });
    return;
  }

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
 * "Edit & send": abre um modal com a resposta sugerida pre-preenchida.
 * Guarda os blocks da mensagem original (em memoria, 30 min) para, depois do
 * envio, trocar so os botoes Send/Edit por "Sent by ..." — o envio do modal
 * nao traz a mensagem original. Se o servidor reiniciar nesse intervalo, o
 * envio funciona igual e a confirmacao vai como mensagem nova.
 */
const pendingMessages = new Map();
const PENDING_TTL_MS = 30 * 60 * 1000;

function rememberMessage(payload) {
  const now = Date.now();
  pendingMessages.forEach((v, k) => { if (now - v.at > PENDING_TTL_MS) pendingMessages.delete(k); });
  const key = `${payload.container?.channel_id || payload.channel?.id}:${payload.container?.message_ts || payload.message?.ts}`;
  pendingMessages.set(key, { at: now, blocks: payload.message?.blocks, text: payload.message?.text });
  return key;
}

async function handleEditSendClick(action, payload) {
  let data;
  try {
    data = JSON.parse(action.value);
  } catch (err) {
    await respond(payload.response_url, '🛑 Internal error: could not read button data.');
    return;
  }
  const key = rememberMessage(payload);
  const input = {
    type: 'input',
    block_id: 'msg',
    label: { type: 'plain_text', text: 'Message to the lead' },
    element: { type: 'plain_text_input', action_id: 'text', multiline: true, max_length: 1000 },
  };
  if (data.text) input.element.initial_value = data.text;

  try {
    await openModal(payload.trigger_id, {
      type: 'modal',
      callback_id: 'edit_send_modal',
      title: { type: 'plain_text', text: 'Edit & send' },
      submit: { type: 'plain_text', text: 'Send' },
      close: { type: 'plain_text', text: 'Cancel' },
      private_metadata: JSON.stringify({ contactId: data.contactId, key, responseUrl: payload.response_url }),
      blocks: [
        input,
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: 'Sent to the lead as an SMS right away. Messages over 160 characters are split into several SMS.' }],
        },
      ],
    });
  } catch (err) {
    console.error('[slack-interactions] views.open falhou:', err.message);
    await respond(payload.response_url, `🛑 *Could not open the editor*: ${err.message}\nUse the Send button or reply in Paladin.`);
  }
}

function handleViewSubmission(payload, res) {
  if (payload.view?.callback_id !== 'edit_send_modal') return res.status(200).send('');
  const text = String(payload.view.state?.values?.msg?.text?.value || '').trim();
  if (!text) {
    return res.status(200).json({ response_action: 'errors', errors: { msg: 'Write a message before sending.' } });
  }
  res.status(200).send(''); // fecha o modal
  processEditSend(payload, text).catch((err) => {
    console.error('[slack-interactions] Erro ao enviar mensagem editada:', err);
  });
}

async function processEditSend(payload, text) {
  const clickedBy = payload.user?.username || payload.user?.name || 'someone';
  let meta;
  try {
    meta = JSON.parse(payload.view.private_metadata);
  } catch (err) {
    await postToSlack({ text: '🛑 Internal error: could not read the Edit & send data. Nothing was sent.' });
    return;
  }

  try {
    await sendMessage(meta.contactId, text);
  } catch (err) {
    console.error('[slack-interactions] sendMessage (editado) falhou:', err.message);
    await notifyOrFallback(meta.responseUrl, `🛑 *Failed to send* (edited message by ${clickedBy}): ${err.message}\nReply manually in Paladin instead.`);
    return;
  }

  const sentText = `✅ *Sent by ${clickedBy}:*\n>${text.replace(/\n/g, '\n>')}`;
  const pending = pendingMessages.get(meta.key);
  const blocks = afterSendBlocks(pending?.blocks, sentText);
  pendingMessages.delete(meta.key);
  const replaced = blocks && (await replaceMessage(meta.responseUrl, pending?.text || sentText, blocks));
  if (!replaced) await notifyOrFallback(meta.responseUrl, sentText);
}

// Mensagem nova via response_url; se ele ja expirou (30 min), cai no webhook do canal.
async function notifyOrFallback(responseUrl, text) {
  const ok = await respond(responseUrl, text);
  if (!ok) await postToSlack({ text }).catch((err) => console.error('[slack-interactions] Fallback do canal falhou:', err.message));
}

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
  if (!responseUrl) return false;
  try {
    const res = await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_type: 'in_channel', replace_original: false, text }),
    });
    return res.ok;
  } catch (err) {
    console.error('[slack-interactions] Falha ao responder via response_url:', err);
    return false;
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
  if (!responseUrl) return false;
  try {
    const res = await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(blocks ? { replace_original: true, text, blocks } : { replace_original: true, text }),
    });
    return res.ok;
  } catch (err) {
    console.error('[slack-interactions] Falha ao atualizar mensagem via response_url:', err);
    return false;
  }
}

/**
 * Depois de enviar uma resposta (Send ou Edit & send), tira os botoes de
 * envio e poe "Sent by ..." no lugar (evita enviar duas vezes); os outros
 * botoes da mensagem (Star/Archive, "Send as lead", que normalmente sao
 * clicados depois de responder) continuam la. Devolve null se a mensagem
 * original nao veio com blocks (cai no replace so com texto).
 */
const SEND_ACTION_IDS = ['send_reply', 'edit_send'];

function afterSendBlocks(blocks, sentText) {
  if (!Array.isArray(blocks)) return null;
  const sentSection = { type: 'section', text: { type: 'mrkdwn', text: sentText } };
  let placed = false;
  const out = [];
  blocks.forEach((b) => {
    if (b.type === 'actions' && (b.elements || []).some((e) => SEND_ACTION_IDS.includes(e.action_id))) {
      out.push(sentSection);
      placed = true;
      const rest = b.elements.filter((e) => !SEND_ACTION_IDS.includes(e.action_id));
      if (rest.length) out.push({ ...b, elements: rest });
    } else {
      out.push(b);
    }
  });
  if (!placed) out.push(sentSection);
  return out;
}

module.exports = router;
