/**
 * Envia notificacoes para um canal do Slack via Incoming Webhook.
 * Usa o fetch nativo do Node 18+ — nenhuma dependencia extra necessaria.
 */
const WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

function buildBlocks({ category, reasoning, suggestedReply, leadText, fromPhone, routing }) {
  const icon = category === 'positive' ? '📩' : '⚠️';
  const label = category === 'positive' ? 'Lead positiva' : 'Precisa de atenção';

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${icon} ${label}`, emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*De:*\n${fromPhone}` },
        { type: 'mrkdwn', text: `*Motivo:*\n${reasoning}` },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Mensagem do lead:*\n>${leadText}` },
    },
  ];

  if (routing) {
    const flag = routing.confidence === 'explicit' ? '' : ' ⚠️';
    const advisorText = routing.advisors.length > 0 ? routing.advisors.join(' → ') : 'nenhum (ver nota)';
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Advisor sugerido${flag}:* ${advisorText}\n_${routing.note}_`,
      },
    });
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: '⚠️ Confirme a regra zero (relacionamento existente) no Pipedrive antes de enviar.',
      },
    ],
  });

  if (suggestedReply) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Sugestão de resposta:*\n${suggestedReply}` },
    });
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
    throw new Error(`Slack respondeu ${res.status}: ${body}`);
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
  const fallbackText = `${params.category === 'positive' ? '📩 Lead positiva' : '⚠️ Precisa de atenção'} — ${params.fromPhone}`;
  await postToSlack({
    text: fallbackText, // usado em notificacoes push / previews que nao renderizam blocks
    blocks: buildBlocks(params),
  });
}

async function notifyError(contextLabel, error) {
  try {
    await postToSlack({
      text: `🛑 Erro na automação: ${contextLabel}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `🛑 *Erro na automação*\n${contextLabel}\n\`\`\`${String(error?.message || error)}\`\`\``,
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
