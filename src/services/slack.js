/**
 * Envia notificacoes para um canal do Slack via Incoming Webhook.
 * Usa o fetch nativo do Node 18+ — nenhuma dependencia extra necessaria.
 */
const { isLeadForwardingConfigured } = require('./slackDm');

const WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

function buildBlocks({ category, reasoning, suggestedReply, leadText, fromPhone, routing, contactId }) {
  const icon = category === 'positive' ? '📩' : '⚠️';
  const label = category === 'positive' ? 'Positive lead' : 'Needs attention';

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${icon} ${label}`, emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*From:*\n${fromPhone}` },
        { type: 'mrkdwn', text: `*Reason:*\n${reasoning}` },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Lead message:*\n>${leadText}` },
    },
  ];

  if (routing) {
    const flag = routing.confidence === 'explicit' ? '' : ' ⚠️';
    const advisorText = routing.advisors.length > 0 ? routing.advisors.join(' → ') : 'none (see note)';
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Suggested advisor${flag}:* ${advisorText}\n_${routing.note}_`,
      },
    });
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: '⚠️ Confirm rule zero (existing relationship) in Pipedrive before sending.',
      },
    ],
  });

  if (suggestedReply) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Suggested reply:*\n${suggestedReply}` },
    });

    // Botao "Send" so aparece se tivermos contactId (sem ele nao da
    // pra chamar a API do Paladin) e a mensagem couber no limite de
    // 2000 caracteres do campo "value" de um botao do Slack — ambos
    // praticamente sempre verdade pra respostas de SMS, mas melhor
    // nao quebrar silenciosamente se algum dia nao for.
    if (contactId) {
      const actionValue = JSON.stringify({ contactId, text: suggestedReply });
      if (actionValue.length <= 2000) {
        blocks.push({
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '✅ Send', emoji: true },
              style: 'primary',
              action_id: 'send_reply',
              value: actionValue,
              confirm: {
                title: { type: 'plain_text', text: 'Send this reply?' },
                text: { type: 'mrkdwn', text: `To: ${fromPhone}\n\n${suggestedReply}` },
                confirm: { type: 'plain_text', text: 'Send' },
                deny: { type: 'plain_text', text: 'Cancel' },
              },
            },
          ],
        });
      } else {
        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: '⚠️ Suggested reply too long for a one-click Send button — reply manually in Paladin.' }],
        });
      }
    }
  }

  // "Send as lead": um botao por advisor sugerido pela matriz. Em bloco
  // separado do "Send" para sobreviver quando o "Send" e substituido por
  // "Sent by ..." (ver routes/slackInteractions.js). O advisor vai no
  // value porque routeLead pode ter efeito colateral (rodizio do AZ) e
  // nao deve ser chamado de novo no clique.
  if (contactId && category === 'positive' && isLeadForwardingConfigured()) {
    const advisors = (routing?.advisors || []).slice(0, 5);
    if (advisors.length > 0) {
      blocks.push({
        type: 'actions',
        elements: advisors.map((advisor, i) => ({
          type: 'button',
          text: { type: 'plain_text', text: `📤 Send as lead → ${advisor}`, emoji: true },
          action_id: `send_as_lead_${i}`,
          value: JSON.stringify({ contactId, advisor }),
          confirm: {
            title: { type: 'plain_text', text: 'Send as lead?' },
            text: { type: 'mrkdwn', text: `Forward this lead and conversation to Chrysete as *${advisor}'s* lead.` },
            confirm: { type: 'plain_text', text: 'Send' },
            deny: { type: 'plain_text', text: 'Cancel' },
          },
        })),
      });
    }
  }

  return blocks;
}

async function postToSlack(payload) {
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Slack responded ${res.status}: ${body}`);
  }
}

/**
 * @param {Object} params
 * @param {'positive'|'attention'} params.category
 * @param {string} params.reasoning
 * @param {string|null} params.suggestedReply
 * @param {string} params.leadText
 * @param {string} params.fromPhone
 * @param {{advisors: string[], confidence: string, note: string}} [params.routing]
 */
async function notifyLead(params) {
  const fallbackText = `${params.category === 'positive' ? '📩 Positive lead' : '⚠️ Needs attention'} — ${params.fromPhone}`;
  await postToSlack({
    text: fallbackText, // usado em notificacoes push / previews que nao renderizam blocks
    blocks: buildBlocks(params),
  });
}

async function notifyError(contextLabel, error) {
  try {
    await postToSlack({
      text: `🛑 Automation error: ${contextLabel}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `🛑 *Automation error*\n${contextLabel}\n\`\`\`${String(error?.message || error)}\`\`\``,
          },
        },
      ],
    });
  } catch (err) {
    // Se nem a notificacao de erro consegue sair, so loga — nao ha
    // mais nenhum canal de fallback configurado neste MVP.
    console.error('[slack] Falha ao notificar erro:', err);
  }
}

module.exports = { notifyLead, notifyError };
