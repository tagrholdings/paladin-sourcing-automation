import React, { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api.js';

const CATS = [
  ['', 'All'],
  ['positive', 'Positive'],
  ['in_person', 'In person'],
  ['details', 'Details'],
  ['attention', 'Attention'],
  ['silent', 'Archive'],
];
const label = (c) => (c === 'in_person' ? 'in person' : c === 'silent' ? 'archive' : c);

const fmt = (d) => {
  if (!d) return '';
  const dt = new Date(d);
  const today = new Date();
  const opts = dt.toDateString() === today.toDateString() ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  return dt.toLocaleString([], opts);
};

function Tag({ kind, children }) {
  return <span className={`tag ${kind}`}>{children || label(kind)}</span>;
}

export default function App() {
  const [auth, setAuth] = useState(null);
  const [tab, setTab] = useState('inbox');
  const refreshAuth = useCallback(() => api.me().then(setAuth).catch(() => setAuth({ authed: false })), []);
  useEffect(() => { refreshAuth(); }, [refreshAuth]);

  if (!auth) return <div className="center muted">Loading…</div>;
  if (!auth.authed) return <Login onDone={refreshAuth} />;
  if (!auth.dbEnabled) return <div className="center">DATABASE_URL is not configured on the server.</div>;

  return (
    <div className="app">
      <header>
        <span className="brand">Paladin</span>
        <nav>
          {['inbox', 'insights', 'settings'].map((t) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>
          ))}
        </nav>
        <button className="ghost" onClick={() => api.logout().then(refreshAuth)}>Log out</button>
      </header>
      <main className={tab === 'inbox' ? 'flush' : ''}>
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
      <h1>Paladin</h1>
      <input type="password" autoFocus placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} />
      <button className="primary" type="submit">Log in</button>
      {err && <div className="error">{err}</div>}
    </form>
  );
}

function Inbox({ onUnauthorized }) {
  const [f, setF] = useState({ category: '', starred: false, archived: false, sentAsLead: false, q: '' });
  const [list, setList] = useState([]);
  const [sel, setSel] = useState(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    const p = { archived: f.archived ? 'true' : 'false' };
    if (f.category) p.category = f.category;
    if (f.starred) p.starred = 'true';
    if (f.sentAsLead) p.sentAsLead = 'true';
    if (f.q) p.q = f.q;
    try { setList((await api.conversations(p)).conversations); setErr(''); }
    catch (e) { if (e instanceof ApiError && e.status === 401) onUnauthorized(); else setErr(e.message); }
  }, [f, onUnauthorized]);

  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, [load]);

  const toggle = (k) => setF((s) => ({ ...s, [k]: !s[k] }));

  return (
    <div className={`inbox ${sel ? 'has-sel' : ''}`}>
      <aside>
        <div className="filters">
          <input type="search" placeholder="Search name, text or id" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
          <div className="chips">
            {CATS.map(([v, l]) => (
              <button key={v} className={`chip ${f.category === v ? 'on' : ''}`} onClick={() => setF({ ...f, category: v })}>{l}</button>
            ))}
          </div>
          <div className="chips">
            <button className={`chip ${f.starred ? 'on' : ''}`} onClick={() => toggle('starred')}>★ Starred</button>
            <button className={`chip ${f.sentAsLead ? 'on' : ''}`} onClick={() => toggle('sentAsLead')}>Sent as lead</button>
            <button className={`chip ${f.archived ? 'on' : ''}`} onClick={() => toggle('archived')}>Archived</button>
          </div>
        </div>
        {err && <div className="error pad">{err}</div>}
        <ul className="list">
          {list.map((c) => (
            <li key={c.contact_id} className={sel === c.contact_id ? 'sel' : ''} onClick={() => setSel(c.contact_id)}>
              <div className="row">
                <span className="name">{c.starred ? '★ ' : ''}{c.name || c.contact_id.slice(0, 8)}</span>
                <span className="muted small">{fmt(c.last_message_at)}</span>
              </div>
              <div className="muted clip">{c.last_text}</div>
              <div className="tags">
                {c.category && <Tag kind={c.category} />}
                {c.sent_as_lead_at && <Tag kind="lead">sent as lead</Tag>}
                <span className="muted small">{[c.city, c.state].filter(Boolean).join(', ')}</span>
              </div>
            </li>
          ))}
          {!list.length && <li className="empty muted">No conversations.</li>}
        </ul>
      </aside>
      <section>
        {sel ? <Thread id={sel} onChanged={load} onBack={() => setSel(null)} /> : <div className="center muted desk-only">Select a conversation</div>}
      </section>
    </div>
  );
}

function Thread({ id, onChanged, onBack }) {
  const [data, setData] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [leadOpen, setLeadOpen] = useState(false);

  const load = useCallback(() => api.conversation(id).then(setData).catch((e) => setErr(e.message)), [id]);
  useEffect(() => { setData(null); setText(''); setErr(''); load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  if (!data) return <div className="center muted">{err || 'Loading…'}</div>;
  const { conversation: c, messages } = data;

  const act = async (fn) => {
    setBusy(true); setErr('');
    try { await fn(); await load(); onChanged(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const send = () => {
    if (!text.trim() || !window.confirm('Send this SMS to the lead?')) return;
    act(async () => { await api.send(id, text.trim()); setText(''); });
  };

  return (
    <div className="thread">
      <div className="thead">
        <button className="ghost back" onClick={onBack} aria-label="Back">←</button>
        <div className="who">
          <div className="name">{c.name || c.contact_id}</div>
          <div className="tags">
            {c.category && <Tag kind={c.category} />}
            {c.sent_as_lead_at && <Tag kind="lead">sent as lead</Tag>}
            <span className="muted small">{[c.city, c.state].filter(Boolean).join(', ')}</span>
          </div>
        </div>
        <div className="acts">
          <button disabled={busy} onClick={() => act(() => api.star(id, !c.starred))}>{c.starred ? '★' : '☆'}<span className="desk-only"> {c.starred ? 'Starred' : 'Star'}</span></button>
          <button disabled={busy} onClick={() => act(() => api.archive(id, !c.archived))}>{c.archived ? 'Unarchive' : 'Archive'}</button>
          <button className="primary" disabled={busy} onClick={() => setLeadOpen(true)}>Send as lead</button>
          {c.sent_as_lead_at && (
            <button className="ghost" disabled={busy} title="Removes the tag in this panel only" onClick={() => act(() => api.sentAsLead(id, false))}>Unmark</button>
          )}
        </div>
      </div>

      <div className="msgs">
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.direction}`}>
            <div className="bubble">{m.text}</div>
            <div className="meta muted small">
              {m.direction === 'outbound' ? `Us · ${m.source}` : 'Lead'} · {fmt(m.ts)}
              {m.category && <> · <Tag kind={m.category} /></>}
            </div>
            {m.reasoning && <div className="why muted small">{m.reasoning}</div>}
          </div>
        ))}
      </div>

      {c.last_suggestion && (
        <div className="suggestion">
          <div className="muted small">Suggested reply</div>
          <div>{c.last_suggestion}</div>
          <button onClick={() => setText(c.last_suggestion)}>Use suggestion</button>
        </div>
      )}
      {err && <div className="error pad">{err}</div>}
      <div className="compose">
        <textarea rows={2} placeholder="Write a reply…" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="primary" disabled={busy || !text.trim()} onClick={send}>Send</button>
      </div>
      {leadOpen && <LeadDialog conversation={c} onClose={() => setLeadOpen(false)} onSent={() => { setLeadOpen(false); load(); onChanged(); }} />}
    </div>
  );
}

/** Envia o card da lead para a Chrysete por DM no Slack (mesma coisa do botao do Slack). */
function LeadDialog({ conversation: c, onClose, onSent }) {
  const [opts, setOpts] = useState(null);
  const [advisor, setAdvisor] = useState('');
  const [urgent, setUrgent] = useState(c.category === 'in_person');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.leadOptions(c.contact_id)
      .then((o) => { setOpts(o); if (o.advisors.length === 1) setAdvisor(o.advisors[0]); })
      .catch((e) => setErr(e.message));
  }, [c.contact_id]);

  const send = async () => {
    setBusy(true); setErr('');
    try { await api.sendAsLead(c.contact_id, advisor, urgent); onSent(); }
    catch (e) { setErr(e.message); setBusy(false); }
  };
  const others = opts ? opts.allAdvisors.filter((a) => !opts.advisors.includes(a)) : [];

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Send as lead to Chrysete</h3>
        <p className="muted small">Posts the lead card (contact info + full conversation) to Chrysete on Slack.</p>
        {c.sent_as_lead_at && <p className="warn small">Already sent{c.sent_as_lead_to ? ` to ${c.sent_as_lead_to}` : ''} on {fmt(c.sent_as_lead_at)}. Sending again will post a second card.</p>}
        {!opts && !err && <p className="muted">Loading…</p>}
        {opts && (
          <>
            <p className="small muted">{opts.note}</p>
            <label className="field">Advisor
              <select value={advisor} onChange={(e) => setAdvisor(e.target.value)}>
                <option value="">Choose…</option>
                {opts.advisors.length > 0 && <optgroup label="Suggested">{opts.advisors.map((a) => <option key={a}>{a}</option>)}</optgroup>}
                <optgroup label="Others">{others.map((a) => <option key={a}>{a}</option>)}</optgroup>
              </select>
            </label>
            <label className="check"><input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} /> Urgent: wants to meet in person</label>
          </>
        )}
        {err && <div className="error">{err}</div>}
        <div className="row dialog-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || !advisor} onClick={send}>{busy ? 'Sending…' : 'Send'}</button>
        </div>
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
    <div className="page">
      <div className="row">
        <h2>Insights</h2>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={0}>All time</option>
        </select>
      </div>
      {err && <div className="error">{err}</div>}

      <div className="card">
        <h3>Most common lead messages</h3>
        {msgs?.categories?.length > 0 && <div className="tags pad-b">{msgs.categories.map((c) => <Tag key={c.category} kind={c.category}>{label(c.category)} · {c.n}</Tag>)}</div>}
        <ul className="rank">
          {msgs?.messages.map((m) => (
            <li key={m.key}><b>{m.n}</b><span>{m.example}</span>{m.category && <Tag kind={m.category} />}</li>
          ))}
          {msgs && !msgs.messages.length && <li className="muted">No data yet.</li>}
        </ul>
      </div>

      <div className="card">
        <h3>Most common replies we sent</h3>
        <ul className="rank">
          {replies?.replies.map((r) => (
            <li key={r.key}>
              <b>{r.n}</b>
              <span>{r.example}<span className="muted small block">{Math.round((100 * r.answered) / r.n)}% answered again{r.by_ai ? ` · ${r.by_ai} by automation` : ''}</span></span>
            </li>
          ))}
          {replies && !replies.replies.length && <li className="muted">No data yet.</li>}
        </ul>
      </div>
    </div>
  );
}

function Switch({ checked, onChange, disabled, title, desc }) {
  return (
    <label className={`switch ${disabled ? 'disabled' : ''}`}>
      <span><b>{title}</b><span className="muted small block">{desc}</span></span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <i aria-hidden="true" />
    </label>
  );
}

function ImportBox() {
  const [since, setSince] = useState('2026-11-16');
  const [st, setSt] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.importStatus().then(setSt).catch(() => {}); }, []);
  useEffect(() => {
    if (!st?.running) return undefined;
    const t = setInterval(() => api.importStatus().then(setSt).catch(() => {}), 2000);
    return () => clearInterval(t);
  }, [st?.running]);
  const start = async () => {
    try { setErr(''); setSt(await api.startImport(since)); } catch (e) { setErr(e.message); }
  };
  return (
    <div className="card">
      <h3>Import history</h3>
      <p className="muted small">Copies conversations with a lead reply since the chosen date from Paladin (full thread + classification). Read-only: nothing is archived, starred or sent.</p>
      <div className="row left">
        <input type="date" value={since} onChange={(e) => setSince(e.target.value)} />
        <button className="primary" disabled={st?.running} onClick={start}>{st?.running ? 'Importing…' : 'Import'}</button>
      </div>
      {st && (st.running || st.finishedAt) && <p className="small">{st.done}/{st.total} conversations{st.finishedAt && !st.running ? ' · done' : ''}{st.error ? ` · error: ${st.error}` : ''}</p>}
      {err && <div className="error">{err}</div>}
    </div>
  );
}

function Settings() {
  const [s, setS] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.settings().then(setS).catch((e) => setErr(e.message)); }, []);
  const set = async (key, value) => {
    if (key === 'ai_autoreply_enabled' && value && !window.confirm('Turn ON auto-reply? Ready-made replies will be texted to leads without human review.')) return;
    try { setS(await api.saveSettings({ [key]: value })); setErr(''); } catch (e) { setErr(e.message); }
  };
  if (!s) return <div className="page muted">{err || 'Loading…'}</div>;
  return (
    <div className="page">
      <h2>Settings</h2>
      {err && <div className="error">{err}</div>}
      <div className="card">
        <Switch title="Automation" checked={s.automation_enabled} onChange={(v) => set('automation_enabled', v)}
          desc="Classifies replies, archives dead ends, stars interested leads and sends them to Chrysete. When off, new messages are only recorded." />
        <Switch title="Auto-reply" checked={s.ai_autoreply_enabled} disabled={!s.automation_enabled} onChange={(v) => set('ai_autoreply_enabled', v)}
          desc="Sends the approved reply texts automatically (once per contact every 10 min). Custom drafts are never sent automatically." />
      </div>
      <ImportBox />
    </div>
  );
}
