const db = require('../db');
const { authedRequest } = require('./paladinApiClient');
const { classifyMessage } = require('./classifier');
const { resolveLocation } = require('./contactLookup');
const store = require('./store');

/**
 * Importa do Paladin para o banco as conversas com resposta do lead desde
 * `since`: historico completo de cada uma, estado star/archive atual e (opcional)
 * a classificacao da ultima resposta. NAO executa nenhuma acao (nao arquiva,
 * nao da star, nao envia nada). Idempotente: mensagens ja gravadas sao ignoradas.
 */
const status = { running: false, total: 0, done: 0, startedAt: null, finishedAt: null, error: null };

function getStatus() {
  return { ...status };
}

async function fetchContactsSince(since) {
  const found = [];
  for (let page = 1; page <= 100; page += 1) {
    const data = await authedRequest(
      `/conversations?page=${page}&limit=100&recentOnly=true&sortBy=lastMessageAt&sortOrder=desc`
    );
    const list = data.contacts || [];
    for (const c of list) {
      const lastInbound = (c.messages || []).find((m) => m.direction === 'inbound');
      if (lastInbound && new Date(lastInbound.timestamp) >= since) found.push(c);
    }
    const oldest = list[list.length - 1];
    const oldestTs = oldest && (oldest.lastMessageAt || (oldest.messages || [])[0]?.timestamp);
    if (!data.hasMore || (oldestTs && new Date(oldestTs) < since)) break;
  }
  return found;
}

async function run(since, { classify }) {
  const contacts = await fetchContactsSince(since);
  status.total = contacts.length;
  for (const c of contacts) {
    const msgs = [...(c.messages || [])].reverse().filter((m) => m.text); // cronologico
    for (const m of msgs) {
      await db.query(
        `INSERT INTO messages (contact_id, message_id, direction, text, ts, source)
         VALUES ($1,$2,$3,$4,$5,'import') ON CONFLICT (message_id) DO NOTHING`,
        [c.id, m.messageId || m._id, m.direction, m.text, m.timestamp]
      );
    }
    const lastInbound = [...msgs].reverse().find((m) => m.direction === 'inbound');
    const last = msgs[msgs.length - 1];
    let cls = null;
    if (classify && lastInbound) {
      const prior = msgs
        .filter((m) => m !== lastInbound && new Date(m.timestamp) <= new Date(lastInbound.timestamp))
        .slice(-40)
        .map((m) => `${m.direction === 'outbound' ? 'Us (Mark/Rob)' : 'Lead'}: ${m.text}`)
        .join('\n');
      try {
        cls = await classifyMessage({ leadText: lastInbound.text, priorContext: prior || null });
        await db.query(
          `UPDATE messages SET category=$2, reasoning=$3, suggestion=$4 WHERE message_id=$1`,
          [lastInbound.messageId || lastInbound._id, cls.category, cls.reasoning, cls.suggested_reply]
        );
      } catch (err) {
        console.error('[import] classificacao falhou:', err.message);
      }
    }
    const { city, state } = resolveLocation(c);
    await store.upsertConversation({
      contactId: c.id,
      name: [c.firstName, c.lastName].filter(Boolean).join(' ') || null,
      state,
      city,
      category: cls?.category,
      starred: Boolean(c.starred),
      archived: Boolean(c.archived),
      lastText: last?.text,
      lastSuggestion: cls?.suggested_reply,
      lastMessageAt: last?.timestamp,
    });
    status.done += 1;
  }
}

function start(sinceIso, { classify = true } = {}) {
  if (status.running) return false;
  const since = new Date(sinceIso);
  if (Number.isNaN(since.getTime())) throw new Error('Data invalida');
  Object.assign(status, { running: true, total: 0, done: 0, startedAt: new Date().toISOString(), finishedAt: null, error: null });
  run(since, { classify })
    .catch((err) => {
      console.error('[import] falhou:', err);
      status.error = err.message;
    })
    .finally(() => {
      status.running = false;
      status.finishedAt = new Date().toISOString();
    });
  return true;
}

module.exports = { start, getStatus };
