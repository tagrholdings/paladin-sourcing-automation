/**
 * Envia DM no Slack pela Web API (chat.postMessage). O Incoming Webhook
 * so posta em canal, entao DM precisa de um token:
 *   - SLACK_DM_TOKEN: token xoxb- (bot do app; a DM chega "do app") ou
 *     xoxp- (token de usuario com escopo chat:write; a DM chega como se
 *     fosse o dono do token — igual ao que e feito hoje, na mao).
 *   - LEAD_RECIPIENT_SLACK_ID: ID de membro (U...) de quem recebe as leads
 *     (Chrysete). Perfil no Slack -> "..." -> "Copy member ID".
 * Sem as duas variaveis o botao "Send as lead" simplesmente nao aparece.
 */
function isLeadForwardingConfigured() {
  return Boolean(process.env.SLACK_DM_TOKEN && process.env.LEAD_RECIPIENT_SLACK_ID);
}

async function postDm({ text, blocks }) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${process.env.SLACK_DM_TOKEN}`,
    },
    body: JSON.stringify({ channel: process.env.LEAD_RECIPIENT_SLACK_ID, text, blocks }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || !json.ok) {
    throw new Error(`Slack chat.postMessage falhou: ${json?.error || res.status}`);
  }
  return json;
}

module.exports = { isLeadForwardingConfigured, postDm };
