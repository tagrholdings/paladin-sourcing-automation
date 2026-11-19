const express = require('express');
const db = require('../db');
const store = require('../services/store');
const auth = require('../lib/dashboardAuth');
const { sendMessage, toggleStarred, toggleArchived, findContactById } = require('../services/paladinApiClient');

/**
 * API JSON do painel (/api). Tudo exige sessao, exceto login/me.
 */
const router = express.Router();

router.post('/login', (req, res) => {
  const ip = req.ip;
  if (!process.env.DASHBOARD_PASSWORD) return res.status(503).json({ error: 'DASHBOARD_PASSWORD nao configurado' });
  if (!auth.loginAllowed(ip)) return res.status(429).json({ error: 'too_many_attempts' });
  if (!auth.checkPassword(req.body?.password || '')) {
    auth.recordFailedLogin(ip);
    return res.status(401).json({ error: 'wrong_password' });
  }
  auth.setSession(res);
  res.json({ ok: true });
});

router.post('/logout', (_req, res) => {
  auth.clearSession(res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => res.json({ authed: auth.isAuthed(req), dbEnabled: db.enabled() }));

router.use(auth.requireAuth);
router.use((_req, res, next) => (db.enabled() ? next() : res.status(503).json({ error: 'DATABASE_URL nao configurado' })));

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error('[api]', err);
    res.status(500).json({ error: err.message });
  });

// ---------- Conversas ----------
router.get('/conversations', wrap(async (req, res) => {
  const { category, starred, archived, q } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = 50;
  const where = [];
  const params = [];
  const bind = (v) => { params.push(v); return `$${params.length}`; };
  if (category) where.push(`category = ${bind(category)}`);
  if (starred === 'true') where.push('starred = true');
  if (req.query.sentAsLead === 'true') where.push('sent_as_lead_at IS NOT NULL');
  if (req.query.sentAsLead === 'false') where.push('sent_as_lead_at IS NULL');
  // por padrao esconde arquivadas; archived=true mostra so arquivadas; archived=all mostra tudo
  if (archived === 'true') where.push('archived = true');
  else if (archived !== 'all') where.push('COALESCE(archived,false) = false');
  if (q) {
    const like = bind(`%${q}%`);
    where.push(`(COALESCE(name,'') ILIKE ${like} OR COALESCE(last_text,'') ILIKE ${like} OR contact_id = ${bind(String(q))})`);
  }
  const lim = bind(limit);
  const off = bind((page - 1) * limit);
  const r = await db.query(
    `SELECT * FROM conversations ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY last_message_at DESC NULLS LAST LIMIT ${lim} OFFSET ${off}`,
    params
  );
  res.json({ conversations: r.rows, page, hasMore: r.rows.length === limit });
}));

router.get('/conversations/:id', wrap(async (req, res) => {
  const c = await db.query('SELECT * FROM conversations WHERE contact_id=$1', [req.params.id]);
  if (!c.rowCount) return res.status(404).json({ error: 'not_found' });
  const m = await db.query('SELECT * FROM messages WHERE contact_id=$1 ORDER BY ts ASC, id ASC', [req.params.id]);
  res.json({ conversation: c.rows[0], messages: m.rows });
}));

router.post('/conversations/:id/send', wrap(async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'empty_text' });
  if (text.length > 1600) return res.status(400).json({ error: 'text_too_long' });
  await sendMessage(req.params.id, text);
  await store.recordOutbound({ contactId: req.params.id, text, source: 'panel' });
  res.json({ ok: true });
}));

/**
 * Star/Archive com semantica de SET sobre um toggle do Paladin: so chama o
 * toggle se o estado atual (banco; se desconhecido, consulta o Paladin) for
 * diferente do desejado.
 */
async function setFlag(req, res, flag) {
  const desired = Boolean(req.body?.value);
  const contactId = req.params.id;
  const col = flag; // 'starred' | 'archived'
  const r = await db.query(`SELECT ${col} AS v FROM conversations WHERE contact_id=$1`, [contactId]);
  let current = r.rowCount ? r.rows[0].v : null;
  if (current === null) {
    const contact = await findContactById(contactId);
    if (!contact) return res.status(409).json({ error: 'state_unknown', message: 'Contato nao encontrado no Paladin para confirmar o estado atual.' });
    current = Boolean(contact[col]);
  }
  let result = desired;
  if (current !== desired) {
    const out = flag === 'starred' ? await toggleStarred(contactId) : await toggleArchived(contactId);
    result = Boolean(out[col]);
  }
  await store.setFlags(contactId, { [col]: result });
  res.json({ [col]: result });
}
// ---------- Send as lead (card para a Chrysete por DM, igual ao botao do Slack) ----------
const { buildLeadCard } = require('../services/leadCard');
const { postDm, isLeadForwardingConfigured } = require('../services/slackDm');
const { getTagNameMap } = require('../services/paladinApiClient');
const { routeLead } = require('../services/routingMatrix');
const { resolveLocation } = require('../services/contactLookup');
const ALL_ADVISORS = ['Craig Gibowicz', 'Rob Brian', 'David Haynes', 'Mark Soelberg', 'Marc Schubert', 'Luke Kapper'];

// Sugestao de advisor para o dialogo do painel (nao avanca o rodizio do Arizona).
router.get('/conversations/:id/lead-options', wrap(async (req, res) => {
  const contact = await findContactById(req.params.id);
  if (!contact) return res.status(404).json({ error: 'not_found', message: 'Contact not found in recent Paladin conversations.' });
  const { state, city } = resolveLocation(contact);
  const routing = state
    ? await routeLead({ stateCode: state, city, zip: contact.address, peek: true })
    : { advisors: [], confidence: 'unresolved', note: 'No state on file for this contact. Pick the advisor manually.' };
  res.json({ advisors: routing.advisors, allAdvisors: ALL_ADVISORS, note: routing.note, confidence: routing.confidence, configured: isLeadForwardingConfigured() });
}));

router.post('/conversations/:id/send-as-lead', wrap(async (req, res) => {
  if (!isLeadForwardingConfigured()) {
    return res.status(503).json({ error: 'not_configured', message: 'SLACK_DM_TOKEN / LEAD_RECIPIENT_SLACK_ID are not set on the server.' });
  }
  const advisor = String(req.body?.advisor || '').trim().slice(0, 120);
  if (!advisor) return res.status(400).json({ error: 'advisor_required', message: 'Pick an advisor.' });
  const contact = await findContactById(req.params.id);
  if (!contact) return res.status(404).json({ error: 'not_found', message: 'Contact not found in recent Paladin conversations.' });
  const tagMap = await getTagNameMap().catch(() => null);
  await postDm(buildLeadCard({ contact, advisor, tagMap, urgent: Boolean(req.body?.urgent), sentBy: 'panel' }));
  await store.markSentAsLead(req.params.id, advisor);
  // Arizona: se foi escolhido alguem do rodizio, avanca o contador.
  const { state, city } = resolveLocation(contact);
  if (state === 'AZ' && ['David Haynes', 'Mark Soelberg'].includes(advisor)) {
    await routeLead({ stateCode: 'AZ', city }).catch(() => {});
  }
  res.json({ ok: true });
}));

// Marcar/desmarcar manualmente como "sent as lead" (so a tag no painel; nao envia nada)
router.post('/conversations/:id/sent-as-lead', wrap(async (req, res) => {
  await store.markSentAsLead(req.params.id, req.body?.to || 'manual', Boolean(req.body?.value));
  const r = await db.query('SELECT sent_as_lead_at, sent_as_lead_to FROM conversations WHERE contact_id=$1', [req.params.id]);
  res.json(r.rows[0] || {});
}));

router.post('/conversations/:id/star', wrap((req, res) => setFlag(req, res, 'starred')));
router.post('/conversations/:id/archive', wrap((req, res) => setFlag(req, res, 'archived')));

// ---------- Insights ----------
const NORM = `left(btrim(regexp_replace(lower(text), '[^a-z0-9'' ]+', ' ', 'g')), 120)`;

function sinceClause(req) {
  const days = Number(req.query.days);
  return Number.isFinite(days) && days > 0 ? `AND ts > now() - interval '${Math.floor(days)} days'` : '';
}

router.get('/stats/common-messages', wrap(async (req, res) => {
  const r = await db.query(
    `SELECT ${NORM} AS key, (array_agg(text ORDER BY ts DESC))[1] AS example, count(*)::int AS n,
            mode() WITHIN GROUP (ORDER BY category) AS category
     FROM messages WHERE direction='inbound' AND btrim(text) <> '' ${sinceClause(req)}
     GROUP BY 1 ORDER BY n DESC LIMIT 30`
  );
  const cats = await db.query(
    `SELECT COALESCE(category,'unclassified') AS category, count(*)::int AS n
     FROM messages WHERE direction='inbound' ${sinceClause(req)} GROUP BY 1 ORDER BY n DESC`
  );
  res.json({ messages: r.rows, categories: cats.rows });
}));

router.get('/stats/common-replies', wrap(async (req, res) => {
  const r = await db.query(
    `SELECT ${NORM.replace(/text/g, 'o.text')} AS key,
            (array_agg(o.text ORDER BY o.ts DESC))[1] AS example,
            count(*)::int AS n,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM messages i WHERE i.contact_id=o.contact_id AND i.direction='inbound' AND i.ts > o.ts
            ))::int AS answered,
            count(*) FILTER (WHERE o.source='ai')::int AS by_ai
     FROM messages o WHERE o.direction='outbound' ${sinceClause(req).replace('AND ts', 'AND o.ts')}
     GROUP BY 1 ORDER BY n DESC LIMIT 30`
  );
  res.json({ replies: r.rows });
}));

// ---------- Importar historico do Paladin (so leitura + gravacao no banco) ----------
const importHistory = require('../services/importHistory');

router.post('/import', wrap(async (req, res) => {
  const date = String(req.body?.since || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'since deve ser YYYY-MM-DD' });
  const started = importHistory.start(`${date}T00:00:00-05:00`, { classify: req.body?.classify !== false });
  res.status(started ? 202 : 409).json({ started, ...importHistory.getStatus() });
}));

router.get('/import/status', wrap(async (_req, res) => res.json(importHistory.getStatus())));

// ---------- Settings ----------
router.get('/settings', wrap(async (_req, res) => res.json(await store.allSettings())));

router.put('/settings', wrap(async (req, res) => {
  for (const key of ['automation_enabled', 'ai_autoreply_enabled']) {
    if (typeof req.body?.[key] === 'boolean') await store.setSetting(key, req.body[key]);
  }
  res.json(await store.allSettings());
}));

module.exports = router;
