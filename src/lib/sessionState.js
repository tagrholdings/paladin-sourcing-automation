/**
 * Estado em memoria da sessao (cookie) da API nao oficial do Paladin.
 *
 * Quando o cookie expira (401/403 do Paladin), marcamos a sessao como
 * expirada: o webhook passa a devolver 503 (Paladin tenta de novo depois,
 * como no PAUSED=true) e um aviso e mandado ao Slack. Renovar o cookie no
 * Railway reinicia o servico e limpa o estado; o heartbeat em index.js
 * tambem limpa sozinho se a sessao voltar a funcionar.
 */
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // no maximo 1 aviso por hora

let expired = false;
let lastAlertAt = 0;

function isExpired() {
  return expired;
}

function markExpired(reason) {
  expired = true;
  const now = Date.now();
  if (now - lastAlertAt < ALERT_COOLDOWN_MS) return;
  lastAlertAt = now;
  // require tardio: evita dependencia circular e deixa o modulo testavel.
  const { notifyError } = require('../services/slack');
  notifyError(
    '⏸️ Paladin session cookie expired — automation PAUSED (webhook returns 503). ' +
      'Copy a fresh cookie from DevTools (crm.paladinsourcing.com → Application → Cookies) into ' +
      'PALADIN_SESSION_COOKIE on Railway; the redeploy resumes everything.',
    reason
  );
}

function clear() {
  expired = false;
}

module.exports = { isExpired, markExpired, clear };
