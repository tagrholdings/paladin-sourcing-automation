/**
 * Guarda localmente todas as conversas do Paladin em data/conversations.json
 * (gitignored: contem texto de leads). Roda de tempos em tempos e MESCLA com o
 * que ja foi salvo, entao o historico cresce mesmo que o Paladin apague algo.
 * Sem telefone, nome ou endereco — so o necessario para analisar respostas.
 *
 * Uso: npm run export-conversations
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });
require('dotenv').config();

// Usa o cliente do Paladin: faz login sozinho (PALADIN_EMAIL/PASSWORD) quando preciso.
const { authedRequest } = require('../src/services/paladinApiClient');

const OUT = path.join(__dirname, '..', 'data', 'conversations.json');
const FILTERS = ['recentOnly', 'starredOnly', 'unreadOnly', 'none'];

async function fetchAllContacts() {
  const all = new Map();
  for (const flt of FILTERS) {
    for (let page = 1; page <= 500; page += 1) {
      const q = flt === 'none' ? '' : `&${flt}=true`;
      const data = await authedRequest(`/conversations?page=${page}&limit=100${q}&sortBy=lastMessageAt&sortOrder=desc`);
      for (const c of data.contacts || []) all.set(c.id, c);
      if (!data.hasMore) break;
    }
  }
  return [...all.values()];
}

const msgKey = (m) => `${m.t}|${m.d}|${m.text}`;

function slim(c) {
  return {
    id: c.id,
    occupation: c.occupation,
    state: String(c.state || '').slice(0, 2),
    starred: Boolean(c.starred),
    optedOut: Boolean(c.optedOut),
    messages: (c.messages || [])
      .map((m) => ({ t: m.timestamp, d: m.direction, text: m.text, s: m.status }))
      .reverse(), // cronologico
  };
}

async function main() {
  const previous = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : [];
  const byId = new Map(previous.map((c) => [c.id, c]));
  for (const raw of await fetchAllContacts()) {
    const fresh = slim(raw);
    const old = byId.get(fresh.id);
    if (!old) { byId.set(fresh.id, fresh); continue; }
    const seen = new Map(old.messages.map((m) => [msgKey(m), m]));
    fresh.messages.forEach((m) => seen.set(msgKey(m), m)); // status mais novo vence
    byId.set(fresh.id, { ...fresh, messages: [...seen.values()].sort((a, b) => (a.t < b.t ? -1 : 1)) });
  }
  const contacts = [...byId.values()];
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(contacts));
  const msgs = contacts.flatMap((c) => c.messages);
  console.log(`Salvo em data/conversations.json: ${contacts.length} contatos, ${msgs.length} mensagens (${msgs.filter((m) => m.d === 'inbound').length} de leads).`);
}

main().catch((err) => { console.error('ERRO:', err.message); process.exit(1); });
