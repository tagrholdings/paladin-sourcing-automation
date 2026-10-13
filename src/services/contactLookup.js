/**
 * PLACEHOLDER. O payload do webhook message.inbound da Paladin traz
 * apenas contactId, texto, telefone de origem/destino e timestamp -
 * NAO traz nome, cidade, estado ou tamanho da pratica (ver resposta
 * do suporte da Paladin sobre API de contatos).
 *
 * Ate confirmarmos se existe uma API de contatos (pergunta enviada ao
 * suporte da Paladin), esta funcao nao inventa dados. Ela retorna
 * tudo como null/desconhecido, e o restante do sistema (slack.js,
 * routingMatrix.js) sabe lidar com isso mostrando um aviso em vez de
 * fingir que tem a informacao.
 *
 * Quando a API de contatos existir, substituir o corpo desta funcao
 * por uma chamada real (ex.: GET /contacts/:contactId) e preencher
 * state/city/isLargeOrMultiPractice a partir da resposta.
 */
async function lookupContact(contactId) {
  return {
    contactId,
    name: null,
    city: null,
    state: null,
    isLargeOrMultiPractice: null, // desconhecido ate confirmar fonte de dados
    source: 'unavailable',
  };
}

module.exports = { lookupContact };
