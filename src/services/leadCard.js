/**
 * Monta o "card" de lead que vai por DM no Slack para quem recebe as leads
 * positivas (hoje: Chrysete), no lugar do print manual da tela do Paladin:
 * dados do contato + conversa inteira + nome do advisor dono da lead.
 */
const MAX_SECTION_CHARS = 2800; // limite do Slack e 3000 por bloco de texto
const MAX_BLOCKS = 45; // limite do Slack e 50 por mensagem

function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Denver',
  });
}

const escapeSlack = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// O contato traz so IDs de tag; tagMap (id -> nome) vem de getTagNameMap().
function tagNames(tags, tagMap) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((t) => (typeof t === 'string' ? tagMap?.get(t) : t?.name || t?.label || tagMap?.get(t?._id)))
    .filter(Boolean);
}

const cleanText = (s) => escapeSlack(s).replace(/\\n/g, '\n').trim();

// Cronologico (a API devolve do mais novo pro mais antigo), so mensagens com texto.
const chronologicalMessages = (messages) => [...(messages || [])].reverse().filter((m) => m.text);
const chronological = (contact) => chronologicalMessages(contact.messages);

// Nossa mensagem: seta pra direita; da lead: seta pra esquerda + citacao, para
// bater o olho e ver quem falou o que.
function conversationLines(messages, leadName) {
  return messages.map((m) =>
    m.direction === 'outbound'
      ? `➡️ *Us* · ${fmtDate(m.timestamp)}\n${cleanText(m.text)}`
      : `⬅️ *${escapeSlack(leadName)}* · ${fmtDate(m.timestamp)}\n>${cleanText(m.text).replace(/\n/g, '\n>')}`
  );
}

// Ultima sequencia de mensagens da lead (mesmo que a gente ja tenha respondido
// depois — o botao costuma ser clicado depois do "Send").
function latestLeadReply(messages) {
  let i = messages.length - 1;
  while (i >= 0 && messages[i].direction === 'outbound') i -= 1;
  const out = [];
  for (; i >= 0 && messages[i].direction !== 'outbound'; i -= 1) out.unshift(messages[i]);
  return out;
}

function chunk(lines) {
  const chunks = [];
  let cur = '';
  for (const line of lines) {
    if (cur && cur.length + line.length + 2 > MAX_SECTION_CHARS) {
      chunks.push(cur);
      cur = '';
    }
    cur += (cur ? '\n\n' : '') + line.slice(0, MAX_SECTION_CHARS);
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/**
 * Blocos do historico completo da conversa, para a notificacao de lead
 * positiva (no lugar de "Reason"/"Lead message"). Devolve null se nao ha
 * historico (ex.: o lookup do contato falhou) — quem chama cai no texto
 * da mensagem recebida.
 *
 * A mensagem que acabou de chegar pode ainda nao estar na lista do Paladin
 * (corrida com o webhook); se faltar, e acrescentada ao fim.
 *
 * @param {Object} params
 * @param {Array} params.messages - mensagens cruas da API (mais novo primeiro)
 * @param {string} params.leadName - primeiro nome da lead
 * @param {string} [params.currentText] - texto da mensagem que disparou o webhook
 * @param {number} params.maxBlocks - quantos blocos cabem na notificacao
 */
function historyBlocks({ messages, leadName, currentText, maxBlocks }) {
  const list = chronologicalMessages(messages);
  if (list.length === 0) return null;
  const last = list[list.length - 1];
  if (currentText && !(last.direction === 'inbound' && String(last.text).trim() === String(currentText).trim())) {
    list.push({ direction: 'inbound', text: currentText, timestamp: new Date().toISOString() });
  }
  const parts = chunk(conversationLines(list, leadName || 'Lead'));
  // Conversa enorme: mantem o comeco e o fim (o que mais importa).
  const room = Math.max(2, maxBlocks - 1);
  const shown = parts.length > room ? [parts[0], ...parts.slice(-(room - 1))] : parts;
  return [
    { type: 'context', elements: [{ type: 'mrkdwn', text: `*Full conversation* · ${list.length} messages` }] },
    ...shown.map((p) => ({ type: 'section', text: { type: 'mrkdwn', text: p } })),
  ];
}

/**
 * @param {Object} params
 * @param {Object} params.contact - contato cru da API do Paladin (com messages)
 * @param {string} params.advisor - nome do advisor dono da lead
 * @param {string} [params.sentBy] - quem clicou no botao no Slack
 */
function buildLeadCard({ contact, advisor, sentBy, tagMap }) {
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'Unknown';
  const location = [contact.city, contact.state].filter(Boolean).join(', ');
  const tags = tagNames(contact.tags, tagMap);

  const fields = [
    ['Phone', contact.phone],
    ['Email', contact.email],
    ['Company', contact.company],
    ['Location', location || contact.address],
    ['Tags', tags.join(', ')],
    ['Sent from', contact.userNumberPhone],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => ({ type: 'mrkdwn', text: `*${k}:*\n${escapeSlack(v)}` }));

  const messages = chronological(contact);
  const leadName = contact.firstName || 'Lead';
  const replied = latestLeadReply(messages);

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `📤 New lead for ${advisor}`, emoji: true } },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${escapeSlack(name)}*${contact.occupation ? `\n${escapeSlack(contact.occupation)}` : ''}` },
    },
  ];
  if (fields.length) blocks.push({ type: 'section', fields: fields.slice(0, 10) });

  if (replied.length) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*💬 ${escapeSlack(leadName)} replied* · ${fmtDate(replied[replied.length - 1].timestamp)}\n>${replied
          .map((m) => cleanText(m.text))
          .join('\n')
          .replace(/\n/g, '\n>')}`,
      },
    });
  }

  blocks.push({ type: 'divider' });
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `*Full conversation* · ${messages.length} messages` }] });

  const parts = chunk(conversationLines(messages, leadName));
  // Se a conversa for enorme, mantem o comeco e o fim (o que mais importa).
  const room = MAX_BLOCKS - blocks.length - 1;
  const shown = parts.length > room ? [...parts.slice(0, 1), ...parts.slice(-(room - 1))] : parts;
  shown.forEach((p) => blocks.push({ type: 'section', text: { type: 'mrkdwn', text: p } }));

  if (sentBy) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Forwarded by ${escapeSlack(sentBy)}` }] });
  }

  return { text: `Lead for ${advisor}: ${name}`, blocks };
}

module.exports = { buildLeadCard, historyBlocks };
