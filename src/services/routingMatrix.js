/**
 * Implementa a "Dental Lead Routing Matrix" da Menlo.
 *
 * REGRA ZERO (relacionamento existente no Pipedrive) NAO e verificada
 * aqui - este modulo nao tem acesso ao Pipedrive. Todo resultado desta
 * funcao deve ser tratado como "sugestao, pendente de confirmacao da
 * regra zero no Pipedrive", nunca como decisao final automatica.
 *
 * Estados/regioes codificados com certeza (citados explicitamente no
 * documento): Texas, Colorado, Utah, Idaho, Wyoming, Nevada, Arizona,
 * California (Norte/Sul), Pacific Northwest (Washington e Oregon).
 *
 * "Midwest", "Southeast" e "todos os estados do Nordeste" NAO vieram
 * com lista explicita de siglas no documento. Uso aqui as definicoes
 * de censo dos EUA mais comuns para preencher essas regioes, mas
 * marco o resultado com confidence:"inferred" para que a pessoa saiba
 * que isso nao veio literalmente do documento e vale confirmar.
 *
 * Estados que apareceram nos leads processados e que o documento
 * simplesmente nao cobre (Virginia, West Virginia, Oklahoma, Havai,
 * Montana, Novo Mexico, Alasca, Kansas, Meio-Atlantico em geral) ficam
 * como confidence:"unresolved" - a funcao nao arrisca um advisor.
 */

const EXPLICIT_SINGLE_STATE = {
  TX: { advisors: ['Craig Gibowicz'], note: 'Texas — todos os leads, sem split' },
  CO: { advisors: ['Craig Gibowicz'], note: 'Colorado — todos os leads, sem split' },
  UT: { advisors: ['Rob Brian'], note: 'Utah — todos os leads, sem split' },
  ID: { advisors: ['Rob Brian'], note: 'Idaho — todos os leads, sem split' },
  WY: { advisors: ['Rob Brian'], note: 'Wyoming — todos os leads, sem split' },
  NV: { advisors: ['Mark Soelberg'], note: 'Nevada — todos os leads' },
};

// Definicao de censo dos EUA (comum, nao explicita no documento).
const INFERRED_MIDWEST = ['ND', 'SD', 'NE', 'KS', 'MN', 'IA', 'MO', 'WI', 'IL', 'IN', 'MI', 'OH'];
const INFERRED_SOUTHEAST = ['AL', 'AR', 'FL', 'GA', 'KY', 'LA', 'MS', 'NC', 'SC', 'TN'];
const INFERRED_NORTHEAST = ['CT', 'ME', 'MA', 'NH', 'RI', 'VT', 'NJ', 'NY', 'PA'];
const INFERRED_PACIFIC_NORTHWEST = ['WA', 'OR'];

// Estados leste/oeste do Mississippi, para a regra de lead grande/multi-pratica.
// Geografia objetiva (nao depende de interpretacao do documento).
const WEST_OF_MISSISSIPPI = new Set([
  'WA', 'OR', 'CA', 'NV', 'ID', 'UT', 'AZ', 'MT', 'WY', 'CO', 'NM',
  'ND', 'SD', 'NE', 'KS', 'OK', 'TX', 'MN', 'IA', 'MO', 'AR', 'LA',
  'HI', 'AK',
]);
// Estados do leste ficam implicitos: tudo que nao esta no set acima
// E que tambem nao e HI/AK (que nao fazem sentido nessa regra de
// Mississippi — ver aviso no retorno).

const ARIZONA_TUCSON_SOUTHERN_NOTE =
  'Arizona Tucson/Sul do AZ precisa ser diferenciado do resto do Arizona pela cidade, nao so pela sigla do estado.';

/**
 * Armazenamento do contador de rodizio do Arizona.
 * MVP: arquivo JSON local. NAO e durevel entre deploys no Railway a
 * menos que um volume persistente esteja anexado. Para producao real,
 * mover para um campo no Pipedrive ou um banco (Postgres do Railway).
 */
const fs = require('fs');
const path = require('path');
const COUNTER_FILE = path.join(__dirname, '..', '..', 'data', 'az-rotation-counter.json');

function readAzCounter() {
  try {
    const raw = fs.readFileSync(COUNTER_FILE, 'utf8');
    return JSON.parse(raw).index || 0;
  } catch {
    return 0;
  }
}

function writeAzCounter(index) {
  fs.mkdirSync(path.dirname(COUNTER_FILE), { recursive: true });
  fs.writeFileSync(COUNTER_FILE, JSON.stringify({ index }), 'utf8');
}

/**
 * Sequencia de rodizio: Haynes, Haynes, Soelberg, repete. Schubert é
 * backup (nunca entra pelo rodizio automatico, so se os dois nao
 * tiverem capacidade — isso exige confirmacao humana).
 */
function nextArizonaRotation() {
  const sequence = ['David Haynes', 'David Haynes', 'Mark Soelberg'];
  const idx = readAzCounter();
  const advisor = sequence[idx % sequence.length];
  writeAzCounter(idx + 1);
  return advisor;
}

/**
 * @param {Object} params
 * @param {string} params.stateCode - sigla de 2 letras (ex.: "TX"), maiuscula
 * @param {string} [params.city] - nome da cidade, usado so para o caso Tucson/AZ
 * @param {boolean} [params.isLargeOrMultiPractice] - sinalizado por humano ou heuristica externa
 * @returns {{advisors: string[], confidence: 'explicit'|'inferred'|'unresolved', note: string}}
 */
function routeLead({ stateCode, city, isLargeOrMultiPractice = false }) {
  if (!stateCode) {
    return {
      advisors: [],
      confidence: 'unresolved',
      note: 'Estado nao informado — nao e possivel rotear sem ele.',
    };
  }
  const state = stateCode.trim().toUpperCase();

  // Hawaii e Alaska: o documento nao cobre nenhum dos dois para fins
  // de roteamento padrao de dentista vendendo pratica. Ver caso real
  // registrado (lead do Havai) — nao assumir nada.
  if (state === 'HI' || state === 'AK') {
    return {
      advisors: [],
      confidence: 'unresolved',
      note: `${state} nao esta coberto pela matriz de roteamento. Confirmar com o gestor antes de atribuir.`,
    };
  }

  // --- Passo 1: lead grande ou multi-pratica tem prioridade sobre geografia ---
  if (isLargeOrMultiPractice) {
    const isWest = WEST_OF_MISSISSIPPI.has(state);
    return {
      advisors: isWest ? ['David Haynes', 'Craig Gibowicz'] : ['Craig Gibowicz', 'David Haynes'],
      confidence: 'explicit',
      note: isWest
        ? 'Lead grande/multi-pratica a oeste do Mississippi (inclui toda a California) — Haynes primeiro.'
        : 'Lead grande/multi-pratica a leste do Mississippi — Craig primeiro.',
    };
  }

  // --- Passo 2: geografia padrao, estados explicitos de 1 advisor ---
  if (EXPLICIT_SINGLE_STATE[state]) {
    const { advisors, note } = EXPLICIT_SINGLE_STATE[state];
    return { advisors, confidence: 'explicit', note };
  }

  // --- Arizona (fora de Tucson/Sul vs. dentro) ---
  if (state === 'AZ') {
    const cityLower = (city || '').toLowerCase();
    const isTucsonSouthern = cityLower.includes('tucson');
    if (isTucsonSouthern) {
      return {
        advisors: ['Marc Schubert'],
        confidence: 'explicit',
        note: 'Tucson / Sul do Arizona — direto para Schubert.',
      };
    }
    if (!city) {
      return {
        advisors: ['David Haynes', 'Mark Soelberg', 'Marc Schubert'],
        confidence: 'unresolved',
        note: `Arizona sem cidade informada — nao da para confirmar se e Tucson/Sul. ${ARIZONA_TUCSON_SOUTHERN_NOTE}`,
      };
    }
    const nextAdvisor = nextArizonaRotation();
    return {
      advisors: [nextAdvisor, 'Marc Schubert'],
      confidence: 'explicit',
      note: `Rodizio Arizona (fora de Tucson/Sul): proximo da sequencia e ${nextAdvisor}. Schubert e backup se ele nao tiver capacidade.`,
    };
  }

  // --- California (Norte/Sul) ---
  if (state === 'CA') {
    if (!city) {
      return {
        advisors: ['David Haynes', 'Mark Soelberg', 'Rob Brian', 'Marc Schubert'],
        confidence: 'unresolved',
        note: 'California sem cidade informada — nao da para saber se e Norte ou Sul. Confirmar manualmente.',
      };
    }
    // Heuristica simples e deliberadamente conservadora: nao tenta
    // adivinhar a partir so do nome da cidade sem uma lista confiavel
    // de qual cidade pertence a qual metade do estado. Devolve
    // unresolved e pede confirmacao humana, exatamente como fizemos
    // manualmente para os leads de Fresno/San Diego hoje.
    return {
      advisors: ['David Haynes', 'Mark Soelberg', 'Rob Brian', 'Marc Schubert'],
      confidence: 'unresolved',
      note: `California — cidade "${city}" informada, mas este modulo nao tem uma lista confiavel de Norte vs. Sul da California. Confirmar manualmente: Sul = Haynes, Soelberg, Rob Brian, Schubert; Norte = Soelberg, Rob Brian, Schubert.`,
    };
  }

  // --- Pacific Northwest (inferido: WA, OR) ---
  if (INFERRED_PACIFIC_NORTHWEST.includes(state)) {
    return {
      advisors: ['Luke Kapper'],
      confidence: 'inferred',
      note: 'Pacific Northwest (WA/OR, definicao inferida — documento nao lista siglas) — exclusivo do Luke Kapper.',
    };
  }

  // --- Midwest / Southeast / Northeast (inferidos) ---
  if (INFERRED_MIDWEST.includes(state)) {
    return {
      advisors: ['Craig Gibowicz'],
      confidence: 'inferred',
      note: 'Midwest (definicao inferida pelo censo dos EUA — documento nao lista siglas) — Craig Gibowicz.',
    };
  }
  if (INFERRED_SOUTHEAST.includes(state)) {
    return {
      advisors: ['Craig Gibowicz'],
      confidence: 'inferred',
      note: 'Southeast (definicao inferida — documento nao lista siglas) — Craig Gibowicz.',
    };
  }
  if (INFERRED_NORTHEAST.includes(state)) {
    return {
      advisors: ['Rob Brian'],
      confidence: 'inferred',
      note: 'Northeast (definicao inferida — documento nao lista siglas) — Rob Brian.',
    };
  }

  // --- Qualquer outro estado: documento nao cobre ---
  return {
    advisors: [],
    confidence: 'unresolved',
    note: `Estado "${state}" nao esta coberto pela matriz (nao e Midwest/Southeast/Northeast/TX/CO/UT/ID/WY/NV/AZ/CA/PNW nas definicoes usadas). Confirmar manualmente com o gestor.`,
  };
}

module.exports = { routeLead };
