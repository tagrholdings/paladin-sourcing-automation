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
 * LIMITACAO CONHECIDA (MVP): este modulo espera receber o cookie de
 * sessao pronto via PALADIN_SESSION_COOKIE (.env / Railway Variables),
 * copiado manualmente do DevTools (Application -> Cookies) depois de
 * logar no dashboard. Nao ha fluxo de login automatizado aqui ainda —
 * o cookie expira e precisa ser renovado manualmente de tempos em
 * tempos. Para producao de verdade, a evolucao natural e automatizar o
 * login (ex.: Playwright headless lendo PALADIN_EMAIL/PALADIN_SENHA de
 * variavel de ambiente, nunca hardcoded) e renovar o cookie sozinho
 * quando expirar. Ate la, se as chamadas comecarem a falhar com
 * 401/403, o cookie provavelmente expirou — renovar manualmente.
 */

const BASE_URL = 'https://crm.paladinsourcing.com/api/v1';

function getSessionCookie() {
  const cookie = process.env.PALADIN_SESSION_COOKIE;
  if (!cookie) {
    throw new Error(
      'PALADIN_SESSION_COOKIE nao configurado. Copie o cookie de sessao do DevTools ' +
      '(logado em crm.paladinsourcing.com) e coloque em .env / Railway Variables. ' +
      'Esse cookie expira periodicamente e precisa ser renovado manualmente (ver ' +
      'comentario de topo deste arquivo).'
    );
  }
  return cookie;
}

async function getCsrfToken() {
  const res = await fetch(`${BASE_URL}/auth/csrf`, {
    headers: { cookie: getSessionCookie() },
  });
  if (!res.ok) {
    throw new Error(`Falha ao obter CSRF token (status ${res.status}) — cookie de sessao provavelmente expirado.`);
  }
  const json = await res.json();
  if (!json.success || !json.data || !json.data.csrfToken) {
    throw new Error('Resposta inesperada de /auth/csrf: ' + JSON.stringify(json));
  }
  return json.data.csrfToken;
}

async function authedRequest(path, { method = 'GET', body } = {}) {
  const cookie = getSessionCookie();
  const headers = {
    cookie,
    accept: 'application/json, text/plain, */*',
  };
  let fetchBody;
  if (method !== 'GET') {
    const csrfToken = await getCsrfToken();
    headers['x-csrf-token'] = csrfToken;
    headers['content-type'] = 'application/json';
    fetchBody = JSON.stringify(body ?? {});
  }
  const res = await fetch(`${BASE_URL}${path}`, { method, headers, body: fetchBody });
  const json = await res.json().catch(() => null);
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

module.exports = {
  sendMessage,
  toggleStarred,
  toggleArchived,
  getContactWorkflows,
  findContactById,
};
