/**
 * O payload do webhook message.inbound da Paladin traz apenas
 * contactId, texto, telefone de origem/destino e timestamp - NAO traz
 * nome, cidade, estado ou tamanho da pratica.
 *
 * ATUALIZACAO (28/10/2026): a API oficial documentada do Paladin ainda
 * nao tem um endpoint de contatos (suporte contatado 14/10 e 20/10,
 * sem resposta). Enquanto isso, usamos o cliente NAO OFICIAL em
 * src/services/paladinApiClient.js (engenharia reversa do dashboard,
 * ver comentario de topo daquele arquivo para limitacoes e riscos) para
 * buscar os dados de verdade. Se o Paladin responder com uma API
 * oficial de contatos, PREFERIR migrar para ela.
 *
 * isLargeOrMultiPractice continua null/desconhecido: nenhum dos
 * endpoints descobertos ate agora sinaliza isso automaticamente -
 * continua dependendo de confirmacao humana (ex.: pela bio/company do
 * contato, que normalmente da pra ler isso, mas nao e um campo
 * estruturado).
 */
const { findContactById } = require('./paladinApiClient');

const US_STATE_CODES = new Set((
  'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY ' +
  'NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'
).split(' '));

/**
 * Alguns contatos vem do Paladin sem o campo "state" e com o estado colado
 * no fim do "city" (ex.: city "Mount Juliet TN"). Sem isso o roteamento
 * ficava "unresolved" mesmo com a localizacao conhecida.
 */
function resolveLocation(contact) {
  let state = contact.state ? String(contact.state).trim().toUpperCase() : null;
  let city = contact.city ? String(contact.city).trim() : null;
  if (state && !US_STATE_CODES.has(state)) state = null;
  if (!state && city) {
    const m = city.match(/^(.*?)[,\s]+([A-Za-z]{2})$/);
    if (m && US_STATE_CODES.has(m[2].toUpperCase())) {
      state = m[2].toUpperCase();
      city = m[1].trim() || null;
    }
  }
  return { city, state };
}

async function lookupContact(contactId) {
  try {
    const contact = await findContactById(contactId);
    if (!contact) {
      return {
        contactId,
        name: null,
        city: null,
        state: null,
        isLargeOrMultiPractice: null,
        source: 'not_found_in_recent_conversations',
      };
    }
    const { city, state } = resolveLocation(contact);
    return {
      contactId,
      name: [contact.firstName, contact.lastName].filter(Boolean).join(' ') || null,
      firstName: contact.firstName || null,
      city,
      state,
      occupation: contact.occupation || null,
      bio: contact.company || null, // campo "company" da API e na verdade a bio/descricao longa
      isLargeOrMultiPractice: null, // ver comentario acima - continua exigindo confirmacao humana
      // starred/archived vem direto da API — usados em webhook.js para
      // decidir se vale a pena chamar toggleStarred/toggleArchived (sao
      // toggles, nao sets; chamar sem checar o estado atual desfaria
      // uma marcacao ja feita por outra mensagem do mesmo contato).
      starred: Boolean(contact.starred),
      archived: Boolean(contact.archived),
      // Historico completo da conversa (a API devolve do mais novo pro mais
      // antigo) — usado pelo classificador para sugerir respostas com contexto.
      messages: Array.isArray(contact.messages) ? contact.messages : [],
      source: 'paladin_unofficial_api',
    };
  } catch (err) {
    console.error('[contactLookup] Falha ao buscar contato via API nao oficial do Paladin:', err.message);
    return {
      contactId,
      name: null,
      city: null,
      state: null,
      isLargeOrMultiPractice: null,
      starred: null, // desconhecido — webhook.js nao deve tentar toggle sem saber o estado atual
      archived: null,
      source: 'lookup_error',
    };
  }
}

module.exports = { lookupContact, resolveLocation };
