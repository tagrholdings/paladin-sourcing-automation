/**
 * Implementa a "Dental Lead Routing Matrix" da Menlo.
 *
 * REGRA ZERO (relacionamento existente no Pipedrive) NAO e verificada
 * aqui - este modulo nao tem acesso ao Pipedrive. Todo resultado desta
 * funcao deve ser tratado como "sugestao, pendente de confirmacao da
 * regra zero no Pipedrive", nunca como decisao final automatica.
 *
 * Estados/regioes codificados com certeza (citados explicitamente no
 * documento oficial): Texas, Colorado, Utah, Idaho, Wyoming, Nevada,
 * Arizona, California (Norte/Sul), Pacific Northwest (Washington e
 * Oregon).
 *
 * "Midwest", "Southeast" e "todos os estados do Nordeste" NAO vieram
 * com lista explicita de siglas no documento. Uso aqui as definicoes
 * de censo dos EUA mais comuns para preencher essas regioes, mas
 * marco o resultado com confidence:"inferred" para que a pessoa saiba
 * que isso nao veio literalmente do documento e vale confirmar.
 *
 * Estados que o documento original nao cobria foram confirmados
 * diretamente pelo Mitch (CEO) em 22/10/2026, fora do PDF oficial:
 *   - Alasca (AK) -> Rob Brian
 *   - Havai (HI) -> Rob Brian
 *   - Montana (MT) -> Luke Kapper
 *   - Novo Mexico (NM) -> 50/50 Craig Gibowicz / Mark Soelberg
 *   - Oklahoma (OK) -> 50/50 Craig Gibowicz / Rob Brian
 *   - Delaware (DE) -> Craig Gibowicz
 *   - Maryland (MD) -> Craig Gibowicz
 *   - Virginia (VA) -> Craig Gibowicz
 *   - Distrito de Columbia (DC) -> Craig Gibowicz
 *   - West Virginia (WV) -> NINGUEM. A Menlo nao pode transacionar
 *     nesse estado (restricao de licenca/legal, nao e so falta de
 *     advisor). Leads de WV devem ser recusados/sinalizados, nunca
 *     roteados.
 * Essas confirmacoes tem confidence:"explicit" porque vieram
 * diretamente do Mitch, mesmo nao estando no PDF da matriz.
 */

const EXPLICIT_SINGLE_STATE = {
  TX: { advisors: ['Craig Gibowicz'], note: 'Texas — all leads, no split' },
  CO: { advisors: ['Craig Gibowicz'], note: 'Colorado — all leads, no split' },
  UT: { advisors: ['Rob Brian'], note: 'Utah — all leads, no split' },
  ID: { advisors: ['Rob Brian'], note: 'Idaho — all leads, no split' },
  WY: { advisors: ['Rob Brian'], note: 'Wyoming — all leads, no split' },
  NV: { advisors: ['Mark Soelberg'], note: 'Nevada — all leads' },
  // Confirmed by Mitch on 2026-10-22 (outside the official PDF):
  AK: { advisors: ['Rob Brian'], note: 'Alaska — confirmed by Mitch (2026-10-22), all leads' },
  HI: { advisors: ['Rob Brian'], note: 'Hawaii — confirmed by Mitch (2026-10-22), all leads' },
  MT: { advisors: ['Luke Kapper'], note: 'Montana — confirmed by Mitch (2026-10-22), all leads' },
  DE: { advisors: ['Craig Gibowicz'], note: 'Delaware — confirmed by Mitch (2026-10-22), all leads' },
  MD: { advisors: ['Craig Gibowicz'], note: 'Maryland — confirmed by Mitch (2026-10-22), all leads' },
  VA: { advisors: ['Craig Gibowicz'], note: 'Virginia — confirmed by Mitch (2026-10-22), all leads' },
  DC: { advisors: ['Craig Gibowicz'], note: 'Washington DC — confirmed by Mitch (2026-10-22), all leads' },
};

// States with a fixed 50/50 split between two advisors, confirmed by
// Mitch on 2026-10-22. Neither the document nor Mitch specified a
// rotation order (unlike Arizona), so we return both names and leave
// it to the person to pick/alternate manually.
const EXPLICIT_FIFTY_FIFTY_STATE = {
  NM: { advisors: ['Craig Gibowicz', 'Mark Soelberg'], note: 'New Mexico — 50/50 split confirmed by Mitch (2026-10-22), no defined rotation order' },
  OK: { advisors: ['Craig Gibowicz', 'Rob Brian'], note: 'Oklahoma — 50/50 split confirmed by Mitch (2026-10-22), no defined rotation order' },
};

// West Virginia: Menlo cannot transact in this state (legal/licensing
// restriction, confirmed by Mitch on 2026-10-22) — this is not a
// missing advisor, it's a block. WV leads must be flagged for decline,
// never routed.
const BLOCKED_STATES = {
  WV: 'West Virginia — Menlo cannot transact in this state (confirmed by Mitch, 2026-10-22). Do not route; flag the lead for decline.',
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
  'Tucson/Southern AZ must be told apart from the rest of Arizona by city, not just by state code.';

/**
 * Armazenamento do contador de rodizio do Arizona.
 * MVP: arquivo JSON local. NAO e durevel entre deploys no Railway a
 * menos que um volume persistente esteja anexado. Para producao real,
 * mover para um campo no Pipedrive ou um banco (Postgres do Railway).
 */
const fs = require('fs');
const path = require('path');
const db = require('../db');
const COUNTER_FILE = path.join(__dirname, '..', '..', 'data', 'az-rotation-counter.json');

// Fallback local (sem DATABASE_URL): arquivo JSON, como antes.
function nextIndexFromFile(peek = false) {
  let idx = 0;
  try {
    idx = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8')).index || 0;
  } catch {
    idx = 0;
  }
  if (peek) return idx;
  fs.mkdirSync(path.dirname(COUNTER_FILE), { recursive: true });
  fs.writeFileSync(COUNTER_FILE, JSON.stringify({ index: idx + 1 }), 'utf8');
  return idx;
}

/**
 * Pega o indice atual do rodizio e incrementa, de forma atomica, no
 * Postgres (tabela settings, chave az_rotation_index). Sobrevive a deploys.
 */
async function nextIndex(peek = false) {
  if (!db.enabled()) return nextIndexFromFile(peek);
  try {
    if (peek) {
      // So consulta (nao avanca o rodizio): usado para sugerir advisor no painel.
      const cur = await db.query(`SELECT value::int AS v FROM settings WHERE key='az_rotation_index'`);
      return cur.rowCount ? cur.rows[0].v : 0;
    }
    const r = await db.query(
      `INSERT INTO settings (key, value) VALUES ('az_rotation_index', '1')
       ON CONFLICT (key) DO UPDATE SET value = (settings.value::int + 1)::text
       RETURNING value::int AS next`
    );
    return r.rows[0].next - 1; // indice usado nesta chamada
  } catch (err) {
    console.error('[routing] Contador do AZ no banco falhou, usando arquivo:', err.message);
    return nextIndexFromFile(peek);
  }
}

/**
 * Sequencia de rodizio: Haynes, Haynes, Soelberg, repete. Schubert é
 * backup (nunca entra pelo rodizio automatico, so se os dois nao
 * tiverem capacidade — isso exige confirmacao humana).
 */
async function nextArizonaRotation(peek = false) {
  const sequence = ['David Haynes', 'David Haynes', 'Mark Soelberg'];
  return sequence[(await nextIndex(peek)) % sequence.length];
}

// --- California: Norte x Sul, dividida "no meio" do estado (definido por
// Matheus, 18/11/2026). Corte pelo CEP: 900-939 = Sul (inclui Fresno,
// Bakersfield, Santa Barbara, SLO, Monterey/Salinas); 940-961 = Norte
// (Bay Area, Sacramento, Central Valley norte, Redding...). Sem CEP, cai
// numa lista de cidades; sem match, fica unresolved.
const CA_SOUTH_ADVISORS = ['David Haynes', 'Mark Soelberg', 'Rob Brian', 'Marc Schubert'];
const CA_NORTH_ADVISORS = ['Mark Soelberg', 'Rob Brian', 'Marc Schubert'];
const CA_SOUTH_CITIES = new Set((
  'los angeles,san diego,anaheim,irvine,santa ana,long beach,riverside,san bernardino,upland,banning,ontario,pasadena,glendale,burbank,' +
  'torrance,redondo beach,west hollywood,beverly hills,santa monica,culver city,inglewood,pomona,fontana,corona,temecula,murrieta,' +
  'oceanside,carlsbad,escondido,chula vista,el cajon,la jolla,newport beach,huntington beach,costa mesa,fullerton,orange,tustin,' +
  'mission viejo,lake forest,laguna niguel,santa barbara,ventura,oxnard,thousand oaks,simi valley,santa clarita,palmdale,lancaster,' +
  'bakersfield,fresno,clovis,visalia,san luis obispo,paso robles,palm springs,palm desert,indio,victorville,hesperia,rancho cucamonga,' +
  'south san gabriel,san gabriel,rosemead,el monte,monterey park,diamond bar,walnut,chino,chino hills,mission hills,northridge,woodland hills,calabasas,' +
  'monterey,salinas,carmel,el centro,yucaipa,redlands,whittier,downey,west covina,covina,alhambra,arcadia,encino,sherman oaks,van nuys'
).split(','));
const CA_NORTH_CITIES = new Set((
  'san francisco,oakland,san jose,sacramento,berkeley,fremont,hayward,santa rosa,napa,vallejo,concord,walnut creek,palo alto,mountain view,' +
  'sunnyvale,santa clara,redwood city,san mateo,san rafael,petaluma,stockton,modesto,merced,turlock,tracy,manteca,lodi,elk grove,roseville,' +
  'folsom,davis,woodland,yuba city,chico,redding,eureka,santa cruz,gilroy,morgan hill,pleasanton,livermore,antioch,fairfield,vacaville,' +
  'menlo park,south san francisco,daly city,san bruno,burlingame,foster city,los altos,cupertino,campbell,los gatos,milpitas,dublin,san ramon,danville,' +
  'auburn,rocklin,truckee,placerville,red bluff,ukiah,medford'
).split(','));

function routeCalifornia(city, zip) {
  const z = zip && String(zip).match(/\b9[0-6]\d{3}\b/);
  let side = null;
  let basis = null;
  if (z) {
    const prefix = Number(z[0].slice(0, 3));
    side = prefix <= 939 ? 'south' : 'north';
    basis = `ZIP ${z[0]}`;
  } else if (city) {
    const c = String(city).toLowerCase().trim();
    if (CA_SOUTH_CITIES.has(c)) { side = 'south'; basis = `city "${city}"`; }
    else if (CA_NORTH_CITIES.has(c)) { side = 'north'; basis = `city "${city}"`; }
  }
  if (!side) {
    return {
      advisors: CA_SOUTH_ADVISORS,
      confidence: 'unresolved',
      note: `California — could not tell Northern from Southern${city ? ` for "${city}"` : ''}. South = Haynes, Soelberg, Rob Brian, Schubert; North = Soelberg, Rob Brian, Schubert. Confirm manually.`,
    };
  }
  return {
    advisors: side === 'south' ? CA_SOUTH_ADVISORS : CA_NORTH_ADVISORS,
    confidence: 'inferred',
    note: `${side === 'south' ? 'Southern' : 'Northern'} California (by ${basis}; state split in the middle, defined by Matheus 2026-11-18).`,
  };
}

/**
 * @param {Object} params
 * @param {string} params.stateCode - sigla de 2 letras (ex.: "TX"), maiuscula
 * @param {string} [params.city] - nome da cidade, usado so para o caso Tucson/AZ
 * @param {boolean} [params.isLargeOrMultiPractice] - sinalizado por humano ou heuristica externa
 * @returns {{advisors: string[], confidence: 'explicit'|'inferred'|'unresolved', note: string}}
 */
async function routeLead({ stateCode, city, zip, isLargeOrMultiPractice = false, peek = false }) {
  if (!stateCode) {
    return {
      advisors: [],
      confidence: 'unresolved',
      note: 'State not provided — cannot route without it.',
    };
  }
  const state = stateCode.trim().toUpperCase();

  // West Virginia: bloqueio legal/de licenca, nao falta de advisor.
  // Confirmado pelo Mitch (22/10/2026). Isso vale mesmo que o lead
  // seja grande/multi-pratica — nao ha advisor nenhum que possa
  // transacionar nesse estado, entao o bloqueio vem antes de tudo.
  if (BLOCKED_STATES[state]) {
    return {
      advisors: [],
      confidence: 'blocked',
      note: BLOCKED_STATES[state],
    };
  }

  // --- Passo 1: lead grande ou multi-pratica tem prioridade sobre geografia ---
  if (isLargeOrMultiPractice) {
    const isWest = WEST_OF_MISSISSIPPI.has(state);
    return {
      advisors: isWest ? ['David Haynes', 'Craig Gibowicz'] : ['Craig Gibowicz', 'David Haynes'],
      confidence: 'explicit',
      note: isWest
        ? 'Large/multi-practice lead west of the Mississippi (includes all of California) — Haynes first.'
        : 'Large/multi-practice lead east of the Mississippi — Craig first.',
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
        note: 'Tucson / Southern Arizona — straight to Schubert.',
      };
    }
    if (!city) {
      return {
        advisors: ['David Haynes', 'Mark Soelberg', 'Marc Schubert'],
        confidence: 'unresolved',
        note: `Arizona with no city provided — cannot confirm whether it is Tucson/Southern AZ. ${ARIZONA_TUCSON_SOUTHERN_NOTE}`,
      };
    }
    const nextAdvisor = await nextArizonaRotation(peek);
    return {
      advisors: [nextAdvisor, 'Marc Schubert'],
      confidence: 'explicit',
      note: `Arizona rotation (outside Tucson/Southern AZ): next in sequence is ${nextAdvisor}. Schubert is backup if they lack capacity.`,
    };
  }

  // --- California (Norte/Sul) ---
  if (state === 'CA') return routeCalifornia(city, zip);

  // --- Pacific Northwest (inferido: WA, OR) ---
  if (INFERRED_PACIFIC_NORTHWEST.includes(state)) {
    return {
      advisors: ['Luke Kapper'],
      confidence: 'inferred',
      note: 'Pacific Northwest (WA/OR, inferred definition — document does not list state codes) — Luke Kapper exclusively.',
    };
  }

  // --- Midwest / Southeast / Northeast (inferidos) ---
  if (INFERRED_MIDWEST.includes(state)) {
    return {
      advisors: ['Craig Gibowicz'],
      confidence: 'inferred',
      note: 'Midwest (inferred from US Census definition — document does not list state codes) — Craig Gibowicz.',
    };
  }
  if (INFERRED_SOUTHEAST.includes(state)) {
    return {
      advisors: ['Craig Gibowicz'],
      confidence: 'inferred',
      note: 'Southeast (inferred definition — document does not list state codes) — Craig Gibowicz.',
    };
  }
  if (INFERRED_NORTHEAST.includes(state)) {
    return {
      advisors: ['Rob Brian'],
      confidence: 'inferred',
      note: 'Northeast (inferred definition — document does not list state codes) — Rob Brian.',
    };
  }

  // --- Estados com split 50/50 confirmados pelo Mitch (22/10/2026) ---
  if (EXPLICIT_FIFTY_FIFTY_STATE[state]) {
    const { advisors, note } = EXPLICIT_FIFTY_FIFTY_STATE[state];
    return { advisors, confidence: 'explicit', note };
  }

  // --- Qualquer outro estado: documento nao cobre ---
  return {
    advisors: [],
    confidence: 'unresolved',
    note: `State "${state}" is not covered by the matrix (not Midwest/Southeast/Northeast/TX/CO/UT/ID/WY/NV/AZ/CA/PNW/AK/HI/MT/DE/MD/VA/DC/NM/OK/WV under the definitions used). Confirm manually with the manager.`,
  };
}

module.exports = { routeLead };
