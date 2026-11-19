export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function req(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.message || data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  me: () => req('GET', '/me'),
  login: (password) => req('POST', '/login', { password }),
  logout: () => req('POST', '/logout'),
  conversations: (params) => req('GET', `/conversations?${new URLSearchParams(params)}`),
  conversation: (id) => req('GET', `/conversations/${id}`),
  send: (id, text) => req('POST', `/conversations/${id}/send`, { text }),
  leadOptions: (id) => req('GET', `/conversations/${id}/lead-options`),
  sendAsLead: (id, advisor, urgent) => req('POST', `/conversations/${id}/send-as-lead`, { advisor, urgent }),
  sentAsLead: (id, value) => req('POST', `/conversations/${id}/sent-as-lead`, { value }),
  star: (id, value) => req('POST', `/conversations/${id}/star`, { value }),
  archive: (id, value) => req('POST', `/conversations/${id}/archive`, { value }),
  commonMessages: (days) => req('GET', `/stats/common-messages?days=${days}`),
  commonReplies: (days) => req('GET', `/stats/common-replies?days=${days}`),
  startImport: (since) => req('POST', '/import', { since }),
  importStatus: () => req('GET', '/import/status'),
  settings: () => req('GET', '/settings'),
  saveSettings: (s) => req('PUT', '/settings', s),
};
