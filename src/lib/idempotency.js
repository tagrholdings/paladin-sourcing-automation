/**
 * Deduplicacao simples em memoria para o campo messageId do webhook.
 *
 * LIMITACAO CONHECIDA: isso vive apenas na memoria do processo. Se o
 * Railway reiniciar a instancia (deploy, crash, sleep), o historico
 * zera. Para o volume de uma automacao de leads isso e aceitavel no
 * MVP: na pior hipotese, uma retentativa do Paladin apos um restart
 * gera uma notificacao duplicada no Telegram, nunca uma perdida.
 * Se precisar de garantia forte, trocar por Redis ou uma tabela no
 * banco (ex.: Postgres do proprio Railway).
 */
const seen = new Map(); // messageId -> timestamp (ms)
const MAX_ENTRIES = 5000;
const TTL_MS = 1000 * 60 * 60 * 24; // 24h

function alreadyProcessed(messageId) {
  cleanup();
  return seen.has(messageId);
}

function markProcessed(messageId) {
  seen.set(messageId, Date.now());
  if (seen.size > MAX_ENTRIES) {
    const oldestKey = seen.keys().next().value;
    seen.delete(oldestKey);
  }
}

function cleanup() {
  const now = Date.now();
  for (const [id, ts] of seen) {
    if (now - ts > TTL_MS) seen.delete(id);
  }
}

module.exports = { alreadyProcessed, markProcessed };
