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
    return {
      contactId,
      name: [contact.firstName, contact.lastName].filter(Boolean).join(' ') || null,
      city: contact.city || null,
      state: contact.state || null,
      occupation: contact.occupation || null,
      bio: contact.company || null, // campo "company" da API e na verdade a bio/descricao longa
      isLargeOrMultiPractice: null, // ver comentario acima - continua exigindo confirmacao humana
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
      source: 'lookup_error',
    };
  }
}

module.exports = { lookupContact };
