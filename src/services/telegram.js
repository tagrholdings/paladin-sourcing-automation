const TelegramBot = require('node-telegram-bot-api');

// polling:false — este processo so ENVIA mensagens, nao fica escutando
// comandos recebidos. Isso evita manter uma conexao de long-polling
// aberta desnecessariamente no servidor do webhook.
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function escapeHtml(str = '') {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Monta e envia a notificacao de um lead classificado.
 *
 * @param {Object} params
 * @param {'positive'|'attention'} params.category
 * @param {string} params.reasoning
 * @param {string|null} params.suggestedReply
 * @param {string} params.leadText
 * @param {string} params.fromPhone
 * @param {{advisors: string[], confidence: string, note: string}} [params.routing]
 */
async function notifyLead({ category, reasoning, suggestedReply, leadText, fromPhone, routing }) {
  const icon = category === 'positive' ? '📩' : '⚠️';
  const label = category === 'positive' ? 'Lead positiva' : 'Precisa de atencao';

  let msg = `${icon} <b>${label}</b>\n`;
  msg += `De: <code>${escapeHtml(fromPhone)}</code>\n\n`;
  msg += `<b>Mensagem do lead:</b>\n${escapeHtml(leadText)}\n\n`;
  msg += `<b>Por que:</b> ${escapeHtml(reasoning)}\n`;

  if (routing) {
    const flag = routing.confidence === 'explicit' ? '' : ' ⚠️';
    const advisorText = routing.advisors.length > 0 ? routing.advisors.join(' → ') : 'nenhum (ver nota)';
    msg += `\n<b>Advisor sugerido${flag}:</b> ${escapeHtml(advisorText)}\n`;
    msg += `<i>${escapeHtml(routing.note)}</i>\n`;
  }

  msg += `\n⚠️ <i>Confirme a regra zero (relacionamento existente) no Pipedrive antes de enviar.</i>`;

  if (suggestedReply) {
    msg += `\n\n<b>Sugestao de resposta:</b>\n${escapeHtml(suggestedReply)}`;
  }

  await bot.sendMessage(CHAT_ID, msg, { parse_mode: 'HTML' });
}

async function notifyError(contextLabel, error) {
  try {
    await bot.sendMessage(
      CHAT_ID,
      `🛑 <b>Erro na automacao</b>\n${escapeHtml(contextLabel)}\n<code>${escapeHtml(String(error?.message || error))}</code>`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    // Se nem a notificacao de erro consegue sair, so loga — nao ha
    // mais nenhum canal de fallback configurado neste MVP.
    console.error('[telegram] Falha ao notificar erro:', err);
  }
}

module.exports = { notifyLead, notifyError };
