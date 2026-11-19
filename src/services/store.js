const db = require('../db');

/**
 * Camada de persistencia do painel. Nenhuma funcao de gravacao lanca erro:
 * o painel e secundario, nunca pode derrubar o fluxo do webhook/Slack.
 */

async function safe(label, fn) {
  if (!db.enabled()) return null;
  try {
    return await fn();
  } catch (err) {
    console.error(`[store] ${label} falhou:`, err.message);
    return null;
  }
}

function recordInbound({ contactId, messageId, text, category, reasoning, suggestion, contact }) {
  return safe('recordInbound', async () => {
    await db.query(
      `INSERT INTO messages (contact_id, message_id, direction, text, source, category, reasoning, suggestion)
       VALUES ($1,$2,'inbound',$3,'webhook',$4,$5,$6)
       ON CONFLICT (message_id) DO NOTHING`,
      [contactId, messageId || null, text, category || null, reasoning || null, suggestion || null]
    );
    await upsertConversation({
      contactId,
      name: contact?.name,
      state: contact?.state,
      city: contact?.city,
      category,
      starred: contact?.starred,
      archived: contact?.archived,
      lastText: text,
      lastSuggestion: suggestion || null,
      touch: true,
    });
  });
}

function recordOutbound({ contactId, text, source }) {
  return safe('recordOutbound', async () => {
    await db.query(
      `INSERT INTO messages (contact_id, direction, text, source) VALUES ($1,'outbound',$2,$3)`,
      [contactId, text, source]
    );
    await upsertConversation({ contactId, lastText: text, touch: true });
  });
}

function upsertConversation({ contactId, name, state, city, category, starred, archived, lastText, lastSuggestion, touch, lastMessageAt }) {
  return safe('upsertConversation', () =>
    db.query(
      `INSERT INTO conversations (contact_id, name, state, city, category, starred, archived, last_text, last_suggestion, last_message_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, $10::timestamptz)
       ON CONFLICT (contact_id) DO UPDATE SET
         name = COALESCE(EXCLUDED.name, conversations.name),
         state = COALESCE(EXCLUDED.state, conversations.state),
         city = COALESCE(EXCLUDED.city, conversations.city),
         category = COALESCE(EXCLUDED.category, conversations.category),
         starred = COALESCE(EXCLUDED.starred, conversations.starred),
         archived = COALESCE(EXCLUDED.archived, conversations.archived),
         last_text = COALESCE(EXCLUDED.last_text, conversations.last_text),
         last_suggestion = CASE WHEN EXCLUDED.category IS NOT NULL THEN EXCLUDED.last_suggestion ELSE conversations.last_suggestion END,
         last_message_at = COALESCE(EXCLUDED.last_message_at, conversations.last_message_at),
         updated_at = now()`,
      [contactId, name ?? null, state ?? null, city ?? null, category ?? null, starred ?? null, archived ?? null, lastText ?? null, lastSuggestion ?? null, touch ? new Date().toISOString() : lastMessageAt ?? null]
    )
  );
}

/** Marca (ou desmarca, com value=false) a conversa como "sent as lead" (enviada para a Chrysete). */
function markSentAsLead(contactId, to, value = true) {
  return safe('markSentAsLead', async () => {
    await upsertConversation({ contactId });
    await db.query(
      value
        ? `UPDATE conversations SET sent_as_lead_at = COALESCE(sent_as_lead_at, now()), sent_as_lead_to = COALESCE($2, sent_as_lead_to) WHERE contact_id=$1`
        : `UPDATE conversations SET sent_as_lead_at = NULL, sent_as_lead_to = NULL WHERE contact_id=$1`,
      [contactId, to || null]
    );
  });
}

function setFlags(contactId, { starred, archived }) {
  return upsertConversation({ contactId, starred, archived });
}

/** True se ja enviamos algo para esse contato nos ultimos `minutes` (guarda do auto-reply). */
async function sentRecently(contactId, minutes = 10) {
  const r = await safe('sentRecently', () =>
    db.query(
      `SELECT 1 FROM messages WHERE contact_id=$1 AND direction='outbound' AND ts > now() - ($2 || ' minutes')::interval LIMIT 1`,
      [contactId, String(minutes)]
    )
  );
  return r ? r.rowCount > 0 : true; // sem banco / erro: assume que sim (nao auto-responde)
}

// ---------- Settings ----------
const DEFAULTS = {
  // Com banco: nasce DESLIGADA (so liga quando voce ativar no painel).
  // Sem banco nao ha painel para ligar, entao segue o PAUSED como antes.
  automation_enabled: () => (db.enabled() || process.env.PAUSED === 'true' ? 'false' : 'true'),
  ai_autoreply_enabled: () => 'false',
};
const cache = new Map(); // key -> {v, at}
const TTL = 5000;

async function getSetting(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.v;
  let v = null;
  if (db.enabled()) {
    try {
      const r = await db.query('SELECT value FROM settings WHERE key=$1', [key]);
      if (r.rowCount) v = r.rows[0].value;
    } catch (err) {
      console.error('[store] getSetting falhou:', err.message);
    }
  }
  if (v === null) v = DEFAULTS[key] ? DEFAULTS[key]() : null;
  cache.set(key, { v, at: Date.now() });
  return v;
}

async function getBool(key) {
  return (await getSetting(key)) === 'true';
}

async function setSetting(key, value) {
  if (!DEFAULTS[key]) throw new Error(`Setting desconhecida: ${key}`);
  if (!db.enabled()) throw new Error('DATABASE_URL nao configurado.');
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
    [key, String(value)]
  );
  cache.set(key, { v: String(value), at: Date.now() });
}

async function allSettings() {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = await getBool(k);
  return out;
}

module.exports = {
  recordInbound,
  recordOutbound,
  upsertConversation,
  setFlags,
  markSentAsLead,
  sentRecently,
  getBool,
  setSetting,
  allSettings,
};
