const crypto = require('crypto');

/**
 * Login do painel: senha unica (DASHBOARD_PASSWORD) -> cookie assinado com
 * HMAC (SESSION_SECRET, ou derivado da senha). Sem dependencias extras.
 */
const COOKIE = 'dash_session';
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

function secret() {
  return process.env.SESSION_SECRET || `dash:${process.env.DASHBOARD_PASSWORD || ''}`;
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function checkPassword(pw) {
  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected) return false;
  // compara hashes para nao vazar o tamanho
  const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(pw), h(expected));
}

function parseCookies(header) {
  const out = {};
  String(header || '')
    .split(';')
    .forEach((p) => {
      const i = p.indexOf('=');
      if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
    });
  return out;
}

function isAuthed(req) {
  if (!process.env.DASHBOARD_PASSWORD) return false;
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, sign(exp));
}

function setSession(res) {
  const exp = String(Date.now() + MAX_AGE_MS);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${exp}.${sign(exp)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE_MS / 1000}${secure}`
  );
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'unauthorized' });
}

// Rate limit simples de login: 10 tentativas / 15 min por IP.
const attempts = new Map();
function loginAllowed(ip) {
  const now = Date.now();
  const a = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  attempts.set(ip, a);
  return a.length < 10;
}
function recordFailedLogin(ip) {
  attempts.set(ip, [...(attempts.get(ip) || []), Date.now()]);
}

module.exports = { checkPassword, isAuthed, setSession, clearSession, requireAuth, loginAllowed, recordFailedLogin };
