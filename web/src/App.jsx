import React, { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api.js';

const CATS = ['positive', 'in_person', 'details', 'attention', 'silent'];
const fmt = (d) => (d ? new Date(d).toLocaleString() : '');

export default function App() {
  const [auth, setAuth] = useState(null); // null = carregando
  const [tab, setTab] = useState('inbox');

  const refreshAuth = useCallback(() => api.me().then((m) => setAuth(m)).catch(() => setAuth({ authed: false })), []);
  useEffect(() => { refreshAuth(); }, [refreshAuth]);

  if (!auth) return <div className="center muted">Loading…</div>;
  if (!auth.authed) return <Login onDone={refreshAuth} />;
  if (!auth.dbEnabled) return <div className="center">DATABASE_URL is not configured on the server.</div>;

  return (
    <div className="app">
      <header>
        <strong>Paladin Panel</strong>
        <nav>
          {['inbox', 'insights', 'settings'].map((t) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>
          ))}
        </nav>
        <button className="link" onClick={() => api.logout().then(refreshAuth)}>Log out</button>
      </header>
      <main>
        {tab === 'inbox' && <Inbox onUnauthorized={refreshAuth} />}
        {tab === 'insights' && <Insights />}
        {tab === 'settings' && <Settings />}
      </main>
    </div>
  );
}

function Login({ onDone }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    try { await api.login(pw); onDone(); } catch (ex) { setErr(ex.status === 401 ? 'Wrong password' : ex.message); }
  };
  return (
    <form className="center login" onSubmit={submit}>
      <h2>Paladin Panel</h2>
      <input type="password" autoFocus placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} />
      <button type="submit">Log in</button>
      {err && <div className="error">{err}</div>}
    </form>
  );
}

function Inbox({ onUnauthorized }) {
  const [filters, setFilters] = useState({ category: '', starred: false, archived: 'false', q: '' });
  const [list, setList] = useState([]);
  const [sel, setSel] = useState(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    const p = {};
    if (filters.category) p.category = filters.category;
    if (filters.starred) p.starred = 'true';
    p.archived = filters.archived;
    if (filters.q) p.q = filters.q;
    try {
      setList((await api.conversations(p)).conversations);
      setErr('');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onUnauthorized();
      else setErr(e.message);
    }
  }, [filters, onUnauthorized]);

  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, [load]);

  return (
    <div className="inbox">
      <aside>
        <div className="filters">
          <input placeholder="Search name, text or id" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
          <select value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value })}>
            <option value="">All categories</option>
            {CATS.map((c) => <option key={c}>{c}</option>)}
          </select>
          <select value={filters.archived} onChange={(e) => setFilters({ ...filters, archived: e.target.value })}>
            <option value="false">Active</option>
            <option value="true">Archived</option>
            <option value="all">All</option>
          </select>
          <label><input type="checkbox" checked={filters.starred} onChange={(e) => setFilters({ ...filters, starred: e.target.checked })} /> ★ only</label>
        </div>
        {err && <div className="error">{err}</div>}
        <ul>
          {list.map((c) => (
            <li key={c.contact_id} className={sel === c.contact_id ? 'sel' : ''} onClick={() => setSel(c.contact_id)}>
              <div className="row">
                <span>{c.starred ? '★ ' : ''}{c.name || c.contact_id.slice(0, 8)}</span>
                {c.category && <span className={`tag ${c.category}`}>{c.category}</span>}
              </div>
              <div className="muted clip">{c.last_text}</div>
              <div className="muted small">{[c.city, c.state].filter(Boolean).join(', ')} · {fmt(c.last_message_at)}</div>
            </li>
          ))}
          {!list.length && <li className="muted">No conversations.</li>}
        </ul>
      </aside>
      <section>{sel ? <Thread id={sel} onChanged={load} /> : <div className="center muted">Select a conversation</div>}</section>
    </div>
  );
}

function Thread({ id, onChanged }) {
  const [data, setData] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(() => api.conversation(id).then(setData).catch((e) => setErr(e.message)), [id]);
  useEffect(() => { setData(null); setText(''); setErr(''); load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  if (!data) return <div className="center muted">{err || 'Loading…'}</div>;
  const { conversation: c, messages } = data;

  const act = async (fn) => {
    setBusy(true); setErr('');
    try { await fn(); await load(); onChanged(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const send = () => text.trim() && act(async () => { await api.send(id, text.trim()); setText(''); });

  return (
    <div className="thread">
      <div className="thead">
        <div>
          <strong>{c.name || c.contact_id}</strong>
          <div className="muted small">{[c.city, c.state].filter(Boolean).join(', ')} {c.category && <span className={`tag ${c.category}`}>{c.category}</span>}</div>
        </div>
        <div className="btns">
          <button disabled={busy} onClick={() => act(() => api.star(id, !c.starred))}>{c.starred ? '★ Starred' : '☆ Star'}</button>
          <button disabled={busy} onClick={() => act(() => api.archive(id, !c.archived))}>{c.archived ? 'Unarchive' : 'Archive'}</button>
        </div>
      </div>
      <div className="msgs">
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.direction}`}>
            <div className="bubble">{m.text}</div>
            <div className="muted small">
              {m.direction === 'outbound' ? `Us (${m.source})` : 'Lead'} · {fmt(m.ts)}
              {m.category && <> · <span className={`tag ${m.category}`}>{m.category}</span></>}
            </div>
            {m.reasoning && <div className="muted small">Why: {m.reasoning}</div>}
          </div>
        ))}
      </div>
      {c.last_suggestion && (
        <div className="suggestion">
          <div className="small muted">AI suggestion</div>
          <div>{c.last_suggestion}</div>
          <button onClick={() => setText(c.last_suggestion)}>Use suggestion</button>
        </div>
      )}
      {err && <div className="error">{err}</div>}
      <div className="compose">
        <textarea rows={3} placeholder="Write a reply…" value={text} onChange={(e) => setText(e.target.value)} />
        <button disabled={busy || !text.trim()} onClick={() => confirm('Send this SMS to the lead?') && send()}>Send</button>
      </div>
    </div>
  );
}

function Insights() {
  const [days, setDays] = useState(30);
  const [msgs, setMsgs] = useState(null);
  const [replies, setReplies] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    Promise.all([api.commonMessages(days), api.commonReplies(days)])
      .then(([m, r]) => { setMsgs(m); setReplies(r); setErr(''); })
      .catch((e) => setErr(e.message));
  }, [days]);

  return (
    <div className="insights">
      <div className="row">
        <h3>Insights</h3>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={0}>All time</option>
        </select>
      </div>
      {err && <div className="error">{err}</div>}
      <div className="cols">
        <div>
          <h4>Most common lead messages</h4>
          {msgs?.categories?.length > 0 && (
            <div className="chips">{msgs.categories.map((c) => <span key={c.category} className={`tag ${c.category}`}>{c.category}: {c.n}</span>)}</div>
          )}
          <table>
            <thead><tr><th>#</th><th>Message</th><th>Category</th></tr></thead>
            <tbody>{msgs?.messages.map((m) => (
              <tr key={m.key}><td>{m.n}</td><td>{m.example}</td><td>{m.category && <span className={`tag ${m.category}`}>{m.category}</span>}</td></tr>
            ))}</tbody>
          </table>
        </div>
        <div>
          <h4>Most common replies we sent</h4>
          <table>
            <thead><tr><th>#</th><th>Reply</th><th>Lead answered</th><th>AI</th></tr></thead>
            <tbody>{replies?.replies.map((r) => (
              <tr key={r.key}><td>{r.n}</td><td>{r.example}</td><td>{Math.round((100 * r.answered) / r.n)}%</td><td>{r.by_ai}</td></tr>
            ))}</tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function ImportBox() {
  const [since, setSince] = useState('2026-11-16');
  const [st, setSt] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.importStatus().then(setSt).catch(() => {});
  }, []);
  useEffect(() => {
    if (!st?.running) return undefined;
    const t = setInterval(() => api.importStatus().then(setSt).catch(() => {}), 2000);
    return () => clearInterval(t);
  }, [st?.running]);
  const start = async () => {
    try { setErr(''); const r = await api.startImport(since); setSt(r); } catch (e) { setErr(e.message); }
  };
  return (
    <div className="switch" style={{ flexDirection: 'column' }}>
      <strong>Import history from Paladin</strong>
      <span className="muted small">Copies conversations with a lead reply since the chosen date (full history + AI classification). Read-only: it does not archive, star or send anything.</span>
      <div className="row" style={{ justifyContent: 'flex-start' }}>
        <input type="date" value={since} onChange={(e) => setSince(e.target.value)} />
        <button disabled={st?.running} onClick={start}>{st?.running ? 'Importing…' : 'Import'}</button>
      </div>
      {st && (st.running || st.finishedAt) && <span className="small">{st.done}/{st.total} conversations{st.finishedAt && !st.running ? ' · done' : ''}{st.error ? ` · error: ${st.error}` : ''}</span>}
      {err && <div className="error">{err}</div>}
    </div>
  );
}

function Settings() {
  const [s, setS] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.settings().then(setS).catch((e) => setErr(e.message)); }, []);
  const set = async (key, value) => {
    if (key === 'ai_autoreply_enabled' && value && !confirm('Turn ON auto-reply? Ready-made replies will be texted to leads without human review.')) return;
    try { setS(await api.saveSettings({ [key]: value })); setErr(''); } catch (e) { setErr(e.message); }
  };
  if (!s) return <div className="muted">{err || 'Loading…'}</div>;
  return (
    <div className="settings">
      <h3>Settings</h3>
      {err && <div className="error">{err}</div>}
      <label className="switch">
        <input type="checkbox" checked={s.automation_enabled} onChange={(e) => set('automation_enabled', e.target.checked)} />
        <span><strong>Automation</strong><br /><span className="muted small">When off, inbound messages are only recorded: no classification, star/archive, Slack alert or AI reply.</span></span>
      </label>
      <ImportBox />
      <label className="switch">
        <input type="checkbox" checked={s.ai_autoreply_enabled} disabled={!s.automation_enabled} onChange={(e) => set('ai_autoreply_enabled', e.target.checked)} />
        <span><strong>Auto-reply (ready-made texts)</strong><br /><span className="muted small">Sends the playbook replies (positive, details, in-person) automatically, at most once per 10 minutes per contact. Custom drafts are never sent automatically.</span></span>
      </label>
    </div>
  );
}
