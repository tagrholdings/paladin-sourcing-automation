/**
 * Cliente NAO OFICIAL da API interna do Paladin Sourcing (crm.paladinsourcing.com).
 *
 * ORIGEM: nao existe documentacao publica desses endpoints. Foram
 * descobertos em 28/10/2026 via engenharia reversa (captura de HAR do
 * trafego de rede do dashboard web, enquanto o usuario fazia manualmente
 * as 3 acoes abaixo). O suporte do Paladin (Arjun) foi contatado em
 * 14/10 e novamente em 20/10 perguntando sobre uma API oficial para
 * essas mesmas 3 coisas e nao respondeu ainda — ver e-mail no
 * CRM/thread "Support". Se/quando eles responderem com uma API oficial
 * documentada, PREFERIR migrar para ela e aposentar este arquivo: este
 * cliente usa endpoints internos do frontend deles, sem contrato de
 * estabilidade, podem mudar ou quebrar sem aviso a qualquer deploy do
 * lado do Paladin.
 *
 * ENDPOINTS CONFIRMADOS (por captura real de HAR, nao por suposicao):
 *   POST  /api/v1/conversations/:contactId/send            { messageText }
 *   PATCH /api/v1/conversations/:contactId/toggle-starred   {}
 *   PATCH /api/v1/conversations/:contactId/toggle-archived  {}
 *   GET   /api/v1/conversations?...&recentOnly|starredOnly|unreadOnly=true
 *         -> ja devolve o contato completo embutido (nome, telefone,
 *         endereco, cidade, estado, ocupacao, idade, bio da empresa,
 *         historico de mensagens) — NAO existe um GET /contacts/:id
 *         direto confirmado no HAR capturado; so vimos
 *         GET /api/v1/contacts/:id/workflows (historico de workflow).
 *         Dado o padrao REST do resto da API, e provavel que
 *         GET /api/v1/contacts/:id tambem exista, mas isso e uma
 *         HIPOTESE NAO CONFIRMADA — testar antes de depender dela.
 *
 * AUTENTICACAO: cookie de sessao (HttpOnly, nao veio no HAR exportado —
 * o exportador parece tirar cookies de proposito por seguranca) + header
 * x-csrf-token, obtido via GET /api/v1/auth/csrf (que por sua vez exige
 * o cookie de sessao ja valido).
 *
 * LOGIN AUTOMATICO: se PALADIN_EMAIL e PALADIN_PASSWORD estiverem
 * configurados (Railway Variables), o modulo faz login sozinho via
 * POST /api/v1/auth/login {email, password, rememberMe} — endpoint e
 * payload lidos do bundle JS publico do dashboard (nao do HAR). Isso
 * acontece quando nao ha cookie nenhum ou quando uma chamada volta
 * 401/403; o cookie novo fica so em memoria e a chamada e repetida uma
 * vez. Se o login falhar (senha trocada, etc.), a sessao e marcada como
 * expirada (ver lib/sessionState.js: pausa o webhook e avisa no Slack).
 * Sem essas variaveis, vale o modo antigo: PALADIN_SESSION_COOKIE copiado
 * manualmente do DevTools, que precisa ser renovado na mao.
 */

const sessionState = require('../lib/sessionState');

const BASE_URL = 'https://crm.paladinsourcing.com/api/v1';

// Cookie obtido pelo login automatico (so em memoria); tem prioridade sobre
// PALADIN_SESSION_COOKIE.
let loginCookie = null;
let loginPromise = null;

function hasCredentials() {
  return Boolean(process.env.PALADIN_EMAIL && process.env.PALADIN_PASSWORD);
}

function parseSetCookies(res) {
  const jar = new Map();
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  list.forEach((c) => {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  });
  return jar;
}

const jarToCookie = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

async function doLogin() {
  const jar = new Map();
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/plain, */*' };
  const body = JSON.stringify({
    email: process.env.PALADIN_EMAIL.toLowerCase(),
    password: process.env.PALADIN_PASSWORD,
    rememberMe: true,
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await fetch(`${BASE_URL}/auth/login`, { method: 'POST', headers, body });
    parseSetCookies(res).forEach((v, k) => jar.set(k, v));
    if (res.status === 419 && attempt === 0) {
      // Login exigiu CSRF: pega token + cookie csrf e repete.
      const csrfRes = await fetch(`${BASE_URL}/auth/csrf`, { headers: jar.size ? { cookie: jarToCookie(jar) } : {} });
      parseSetCookies(csrfRes).forEach((v, k) => jar.set(k, v));
      const csrfJson = await csrfRes.json().catch(() => null);
      if (!csrfJson?.data?.csrfToken) throw new Error('Login: nao foi possivel obter o CSRF token.');
      headers['x-csrf-token'] = csrfJson.data.csrfToken;
      headers.cookie = jarToCookie(jar);
      continue;
    }
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || json.success === false) {
      throw new Error(`Login no Paladin falhou (status ${res.status}): ${JSON.stringify(json)}`);
    }
    if (![...jar.keys()].some((k) => /session/i.test(k))) {
      throw new Error('Login no Paladin respondeu OK mas nao devolveu cookie de sessao.');
    }
    loginCookie = jarToCookie(jar);
    sessionState.clear();
    console.log('[paladin] Login automatico realizado com sucesso.');
    return;
  }
  throw new Error('Login no Paladin falhou apos retentativa de CSRF.');
}

// Uma tentativa de login por vez, mesmo com varias chamadas expiradas juntas.
async function login() {
  if (!hasCredentials()) throw new Error('PALADIN_EMAIL / PALADIN_PASSWORD nao configurados.');
  if (!loginPromise) {
    loginPromise = doLogin().finally(() => { loginPromise = null; });
  }
  return loginPromise;
}

async function getSessionCookie() {
  const cookie = loginCookie || process.env.PALADIN_SESSION_COOKIE;
  if (cookie) return cookie;
  if (hasCredentials()) {
    try {
      await login();
    } catch (err) {
      sessionState.markExpired(err.message);
      throw err;
    }
    return loginCookie;
  }
  throw new Error(
    'Nenhuma credencial do Paladin configurada. Defina PALADIN_EMAIL e PALADIN_PASSWORD ' +
    '(login automatico, recomendado) ou PALADIN_SESSION_COOKIE (copiado do DevTools; expira).'
  );
}

class AuthError extends Error {}

// /auth/csrf devolve um token no body E seta um cookie "csrf" novo; os dois
// formam um par (double-submit), entao o cookie antigo guardado em
// PALADIN_SESSION_COOKIE nao serve — precisa ser substituido pelo novo.
async function getCsrf() {
  const sessionCookie = await getSessionCookie();
  const res = await fetch(`${BASE_URL}/auth/csrf`, {
    headers: { cookie: sessionCookie },
  });
  if (!res.ok) {
    const msg = `Falha ao obter CSRF token (status ${res.status}) — cookie de sessao provavelmente expirado.`;
    if (res.status === 401 || res.status === 403) throw new AuthError(msg);
    throw new Error(msg);
  }
  const json = await res.json();
  if (!json.success || !json.data || !json.data.csrfToken) {
    throw new Error('Resposta inesperada de /auth/csrf: ' + JSON.stringify(json));
  }
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const newCsrf = setCookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('csrf='));
  const cookie = newCsrf
    ? [...sessionCookie.split(';').map((s) => s.trim()).filter((c) => c && !c.startsWith('csrf=')), newCsrf].join('; ')
    : sessionCookie;
  return { token: json.data.csrfToken, cookie };
}

// Em 401/403 tenta relogar (se houver credenciais) e repete a chamada uma vez;
// sem credenciais, ou se o login falhar, marca a sessao como expirada.
async function authedRequest(path, opts = {}, retried = false) {
  try {
    return await doAuthedRequest(path, opts);
  } catch (err) {
    if (!(err instanceof AuthError)) throw err;
    if (!retried && hasCredentials()) {
      loginCookie = null;
      try {
        await login();
      } catch (loginErr) {
        sessionState.markExpired(loginErr.message);
        throw loginErr;
      }
      return authedRequest(path, opts, true);
    }
    sessionState.markExpired(err.message);
    throw err;
  }
}

async function doAuthedRequest(path, { method = 'GET', body } = {}) {
  const cookie = await getSessionCookie();
  const headers = {
    cookie,
    accept: 'application/json, text/plain, */*',
  };
  let fetchBody;
  if (method !== 'GET') {
    const csrf = await getCsrf();
    headers.cookie = csrf.cookie;
    headers['x-csrf-token'] = csrf.token;
    headers['content-type'] = 'application/json';
    fetchBody = JSON.stringify(body ?? {});
  }
  const res = await fetch(`${BASE_URL}${path}`, { method, headers, body: fetchBody });
  const json = await res.json().catch(() => null);
  if (res.status === 401 || res.status === 403) {
    throw new AuthError(`${method} ${path} retornou ${res.status}`);
  }
  if (!res.ok || !json || json.success === false) {
    throw new Error(
      `Chamada ${method} ${path} falhou (status ${res.status}): ${JSON.stringify(json)}`
    );
  }
  return json.data;
}

/**
 * Envia uma mensagem SMS/MMS de resposta para um contato.
 * Confirmado via HAR: POST /api/v1/conversations/:contactId/send
 * @param {string} contactId
 * @param {string} messageText
 * @returns {Promise<{message: string, jobId: string}>} ex.: mensagem fica "queued", nao confirma entrega na hora
 */
async function sendMessage(contactId, messageText) {
  if (!contactId || !messageText) {
    throw new Error('sendMessage requer contactId e messageText.');
  }
  return authedRequest(`/conversations/${contactId}/send`, {
    method: 'POST',
    body: { messageText },
  });
}

/**
 * Alterna o status "starred" (favoritado) de uma conversa.
 * Confirmado via HAR: PATCH /api/v1/conversations/:contactId/toggle-starred
 * E um toggle, nao um set explicito — chamar duas vezes desfaz. Nao ha
 * (no HAR capturado) um jeito de setar starred:true/false diretamente.
 * @param {string} contactId
 * @returns {Promise<{starred: boolean}>}
 */
async function toggleStarred(contactId) {
  if (!contactId) throw new Error('toggleStarred requer contactId.');
  return authedRequest(`/conversations/${contactId}/toggle-starred`, { method: 'PATCH' });
}

/**
 * Alterna o status "archived" de uma conversa.
 * Confirmado via HAR: PATCH /api/v1/conversations/:contactId/toggle-archived
 * Mesma observacao do toggleStarred: e toggle, nao set explicito.
 * @param {string} contactId
 * @returns {Promise<{archived: boolean}>}
 */
async function toggleArchived(contactId) {
  if (!contactId) throw new Error('toggleArchived requer contactId.');
  return authedRequest(`/conversations/${contactId}/toggle-archived`, { method: 'PATCH' });
}

/**
 * Historico de workflows automatizados do contato (ex.: a campanha de
 * outreach "Dental v2" que o Mark roda). Confirmado via HAR:
 * GET /api/v1/contacts/:contactId/workflows
 * @param {string} contactId
 */
async function getContactWorkflows(contactId) {
  if (!contactId) throw new Error('getContactWorkflows requer contactId.');
  return authedRequest(`/contacts/${contactId}/workflows`, { method: 'GET' });
}

/**
 * Busca os dados completos de um contato (nome, telefone, endereco,
 * cidade, estado, ocupacao, idade, bio, mensagens) varrendo as listas
 * de conversas ate achar o contactId.
 *
 * LIMITACAO IMPORTANTE: nao existe (no HAR capturado) um endpoint do
 * tipo "GET /contacts/:id" que devolva isso direto por ID. O frontend
 * so busca via listas paginadas (recentOnly/starredOnly/unreadOnly).
 * Essa funcao varre a lista "recentOnly" paginada ate achar o contato —
 * funciona, mas NAO escala bem (quanto mais leads, mais paginas
 * percorridas por lookup). Para o volume atual da automacao isso e
 * aceitavel. Se o volume crescer muito, vale testar a hipotese de que
 * GET /api/v1/contacts/:contactId existe direto (ver comentario de
 * topo do arquivo) antes de continuar escalando essa varredura.
 *
 * @param {string} contactId
 * @param {Object} [opts]
 * @param {number} [opts.pageLimit=100] - itens por pagina
 * @param {number} [opts.maxPages=20] - paginas maximas a varrer antes de desistir
 * @returns {Promise<Object|null>} o objeto do contato, ou null se nao achado dentro do limite de paginas
 */
async function findContactById(contactId, { pageLimit = 100, maxPages = 20 } = {}) {
  if (!contactId) throw new Error('findContactById requer contactId.');
  for (let page = 1; page <= maxPages; page += 1) {
    const data = await authedRequest(
      `/conversations?page=${page}&limit=${pageLimit}&recentOnly=true&sortBy=lastMessageAt&sortOrder=desc`,
      { method: 'GET' }
    );
    const found = (data.contacts || []).find((c) => c.id === contactId);
    if (found) return found;
    if (!data.hasMore) break;
  }
  return null;
}

/**
 * Mapa id -> nome das tags (o contato so traz os IDs das tags).
 * GET /api/v1/tags, lido do bundle do dashboard e confirmado com chamada real.
 * Cache curto em memoria para nao bater na API a cada clique.
 */
let tagCache = { at: 0, map: new Map() };
async function getTagNameMap() {
  if (Date.now() - tagCache.at < 10 * 60 * 1000) return tagCache.map;
  const data = await authedRequest('/tags');
  const list = Array.isArray(data) ? data : data?.tags || [];
  tagCache = { at: Date.now(), map: new Map(list.map((t) => [t._id || t.id, t.name])) };
  return tagCache.map;
}

/**
 * Heartbeat: confirma que o cookie ainda vale (so um GET /auth/csrf).
 * Marca a sessao como expirada se nao valer, e limpa o estado se voltou.
 */
async function checkSession() {
  if (!loginCookie && !process.env.PALADIN_SESSION_COOKIE && !hasCredentials()) return;
  try {
    // authedRequest ja relogia sozinho (se houver credenciais) e marca a
    // sessao como expirada se nao der.
    await authedRequest('/auth/csrf');
    sessionState.clear();
  } catch (err) {
    console.error('[session] Heartbeat falhou:', err.message);
  }
}

module.exports = {
  checkSession,
  getTagNameMap,
  sendMessage,
  toggleStarred,
  toggleArchived,
  getContactWorkflows,
  findContactById,
};
