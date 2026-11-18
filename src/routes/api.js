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
