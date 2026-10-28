/**
 * Le data/conversations.json e gera:
 *  - data/response-bank.json     : estatisticas por intencao do lead (analise completa)
 *  - data/response-examples.json : melhores exemplos, carregados pelo classificador
 *
 * "Engajamento" = % das vezes em que o lead respondeu de novo depois da nossa
 * resposta (ignorando "1"/STOP). Nomes "Dr X" viram {{lastName}}.
 * Os exemplos escolhidos exigem uso minimo (MIN_USES) para nao premiar sorte.
 *
 * Uso: npm run build-response-bank
 */
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const MIN_USES = 5;
const EXAMPLES_PER_CATEGORY = 3;
// Categorias com resposta util para sugerir (as demais so entram na analise).
const EXAMPLE_CATEGORIES = ['positive_yes', 'who_is_this', 'call_me_now', 'buyer_investor', 'thanks_ack'];

const CATS = [
  ['wrong_number', /wrong (number|person)|not (the )?(dr|doctor)|doesn'?t work here|no longer (work|practic)/],
  ['who_is_this', /\bwho (is|are|r)\b|what company|which company|who do you work|mark who|about what|what is this|what('s| is) this about|where are you/],
  ['buyer_investor', /\b(buyer|investor|investors|buying|dso)\b/],
  ['not_interested', /^(no|nope|no thanks|no thank you|not interested|not at this time|no not interested|not now)\b|not interested|not (looking|selling)|no thank/],
  ['call_me_now', /call me|available now|\bnow\b|give me a call|call (me )?(at|after|tomorrow)/],
  ['positive_yes', /^(yes|yeah|yep|sure|ok|okay|absolutely|sounds good|maybe|possibly|definitely|of course|yes i (would|am))\b/],
  ['thanks_ack', /^(thank you|thanks|hi|hello|hey)\b/],
];

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
const catOf = (t) => { const n = norm(t); if (!n) return 'empty'; for (const [k, re] of CATS) if (re.test(n)) return k; return 'other'; };
const anon = (s) => String(s || '').replace(/\\n/g, '\n').replace(/\b(Dr\.?|Doctor)\s+[A-Z][a-zA-Z'-]+/g, '$1 {{lastName}}').trim();
const key = (s) => norm(anon(s)).replace(/\{\{lastname\}\}/g, 'x').slice(0, 90);

function main() {
  const file = path.join(DATA, 'conversations.json');
  if (!fs.existsSync(file)) throw new Error('data/conversations.json nao existe — rode npm run export-conversations antes.');
  const contacts = JSON.parse(fs.readFileSync(file, 'utf8'));

  const by = {};
  for (const c of contacts) {
    for (let i = 0; i < c.messages.length; i += 1) {
      const m = c.messages[i];
      if (m.d !== 'inbound') continue;
      const cat = catOf(m.text);
      by[cat] = by[cat] || { n: 0, replies: new Map(), lead: new Map() };
      by[cat].n += 1;
      by[cat].lead.set(norm(m.text), (by[cat].lead.get(norm(m.text)) || 0) + 1);
      const rest = c.messages.slice(i + 1);
      const idx = rest.findIndex((x) => x.d === 'outbound');
      if (idx < 0) continue;
      const engaged = rest.slice(idx + 1).some((x) => x.d === 'inbound' && !/^(1|stop)$/.test(norm(x.text)));
      const k = key(rest[idx].text);
      const e = by[cat].replies.get(k) || { text: anon(rest[idx].text), n: 0, engaged: 0 };
      e.n += 1;
      if (engaged) e.engaged += 1;
      by[cat].replies.set(k, e);
    }
  }

  const bank = {};
  const examples = {};
  for (const [cat, v] of Object.entries(by)) {
    const replies = [...v.replies.values()].map((r) => ({
      text: r.text, used: r.n, leadRepliedAgainPct: Math.round((100 * r.engaged) / r.n),
    }));
    bank[cat] = {
      leadMessages: v.n,
      answeredByUs: replies.reduce((a, r) => a + r.used, 0),
      commonLeadTexts: [...v.lead].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([text, count]) => ({ text: text.slice(0, 80), count })),
      topReplies: replies.filter((r) => r.used >= 2).sort((a, b) => b.used - a.used).slice(0, 10),
    };
    if (EXAMPLE_CATEGORIES.includes(cat)) {
      examples[cat] = {
        leadSays: bank[cat].commonLeadTexts.slice(0, 5).map((l) => l.text),
        goodReplies: replies
          .filter((r) => r.used >= MIN_USES)
          .sort((a, b) => b.leadRepliedAgainPct - a.leadRepliedAgainPct || b.used - a.used)
          .slice(0, EXAMPLES_PER_CATEGORY),
      };
    }
  }
  fs.writeFileSync(path.join(DATA, 'response-bank.json'), JSON.stringify(bank, null, 2));
  fs.writeFileSync(path.join(DATA, 'response-examples.json'), JSON.stringify({ generatedAt: new Date().toISOString(), examples }, null, 2));
  for (const [cat, e] of Object.entries(examples)) {
    console.log(`\n## ${cat}`);
    e.goodReplies.forEach((r) => console.log(`  [${r.used}x, ${r.leadRepliedAgainPct}%] ${r.text.replace(/\n/g, ' ').slice(0, 200)}`));
  }
}

try { main(); } catch (err) { console.error('ERRO:', err.message); process.exit(1); }
