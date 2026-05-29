const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const { buildFrozenIndexFromRows } = require('../utils/frozenMiniSearch');
const { streamMedicinalProducts } = require('../utils/streamMedicinalProductsXml');
const { loadMemoryMark } = require('../utils/memorySampler');
const {
  miniSearchOptions,
  normalizeSearchText,
  computeMatchPriority,
  matchQualityFromPriority
} = require('../utils/searchRanking');
const {
  VET_DATA_DIR,
  PRODUCTS_XML_NAME,
  DICT_XML_NAME
} = require('./vetDataDownloader');

const dataDir = process.env.VET_DATA_DIR || VET_DATA_DIR;
const productsFileName = process.env.VET_PRODUCTS_FILE || PRODUCTS_XML_NAME;
const dictFileName = process.env.VET_DICT_FILE || DICT_XML_NAME;

const ARRAY_TAGS = new Set([
  'medicinal-product',
  'compo',
  'sa',
  'mod-vte',
  'voie-admin',
  'code-atcvet',
  'entry',
  'term-esp'
]);

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  trimValues: true,
  isArray: (tagName) => ARRAY_TAGS.has(tagName),
  stopNodes: ['*.paragraphes-rcp', '*.lien-rcp']
});

let vetCache = {
  medicaments: [],
  compositions: [],
  presentations: [],
  tempsAttente: new Map(),
  metadata: {
    last_updated: null,
    source: 'base de données publique des médicaments vétérinaires autorisés en France - Anses/ANMV'
  }
};

let searchIndexes = {
  medicaments: null,
  compositions: null
};

let numIndexes = null;

const PRIMARY_FIELDS = {
  medicaments: 'nom',
  compositions: 'substance'
};

const ANMV_RCP_URL_PREFIX = 'http://www.ircp.anmv.anses.fr/rcp.aspx?NomMedicament=';

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function resolveTerm(dict, termKey, code) {
  if (code == null || code === '') return '';
  const map = dict[termKey];
  const key = String(code);
  return (map && map.get(key)) || key;
}

function dictionaryEntriesFromSection(section) {
  if (!section) return [];
  const entries = [];

  for (const block of asArray(section)) {
    if (block && block.entry != null) {
      entries.push(...asArray(block.entry));
    } else if (block && block['source-code'] != null) {
      entries.push(block);
    }
  }

  return entries;
}

function parseDictionary(xmlContent) {
  const parsed = xmlParser.parse(xmlContent);
  const root = parsed['donnees-reference-group'] || {};
  const dict = {};

  for (const [termKey, section] of Object.entries(root)) {
    if (!termKey.startsWith('term-')) continue;
    dict[termKey] = new Map();
    for (const entry of dictionaryEntriesFromSection(section)) {
      if (!entry || entry['source-code'] == null) continue;
      dict[termKey].set(String(entry['source-code']), entry['source-desc'] || '');
    }
  }

  return dict;
}

function parseDateAmm(value) {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const match = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(value);
  if (match) return `${match[3]}-${match[2]}-${match[1]}`;
  return value;
}

/** Même encodage que l’ANMV : + pour espaces, séquences %xx en minuscules. */
function buildLienRcpFromNom(nom) {
  if (!nom) return '';
  const param = encodeURIComponent(String(nom).trim())
    .replace(/%20/g, '+')
    .replace(/%[0-9a-f]{2}/gi, (hex) => hex.toLowerCase());
  return `${ANMV_RCP_URL_PREFIX}${param}`;
}

function enrichMedicamentForApi(medicament) {
  if (!medicament) return medicament;
  return {
    ...medicament,
    lien_rcp: medicament.maj_rcp ? buildLienRcpFromNom(medicament.nom) : ''
  };
}

function parseMajRcp(product) {
  return product['maj-rcp'] ? String(product['maj-rcp']) : '';
}

function parseAtcvetCodes(product) {
  const codes = new Set();
  for (const code of asArray(product['atcvet-code']?.['code-atcvet'])) {
    if (code) codes.add(String(code));
  }
  for (const code of asArray(product.atcvet?.['code-atcvet'])) {
    if (code) codes.add(String(code));
  }
  return [...codes];
}

function parseEspeces(product, dict) {
  const especes = new Set();

  for (const code of asArray(product.especes?.['term-esp'])) {
    const label = resolveTerm(dict, 'term-esp', code);
    if (label) especes.add(label);
  }

  for (const route of asArray(product['voie-administration']?.['voie-admin'])) {
    const label = resolveTerm(dict, 'term-esp', route['term-esp']);
    if (label) especes.add(label);
  }

  return [...especes];
}

function parseCompositionLines(product, dict) {
  const lines = [];
  const composition = product.composition;
  if (!composition) return lines;

  const compoBlocks = asArray(composition.compo);
  if (compoBlocks.length > 0) {
    for (const block of compoBlocks) {
      for (const sa of asArray(block.sa)) {
        lines.push({
          num: normalizeNum(product.num),
          substance: resolveTerm(dict, 'term-sa', sa['term-sa']),
          quantite: sa.quantite != null ? String(sa.quantite) : '',
          unite: sa.unite || resolveTerm(dict, 'term-unite', sa['term-unite'])
        });
      }
    }
    return lines;
  }

  for (const sa of asArray(composition.sa)) {
    lines.push({
      num: normalizeNum(product.num),
      substance: resolveTerm(dict, 'term-sa', sa['term-sa']),
      quantite: sa.quantite != null ? String(sa.quantite) : '',
      unite: sa.unite || resolveTerm(dict, 'term-unite', sa['term-unite'])
    });
  }

  return lines;
}

function parsePresentationFromMod(product, mod, dict) {
  const libelle = mod['lib-mod'];
  if (!libelle) return null;

  const conditions = [];
  if (mod['lib-condp']) {
    conditions.push(mod['lib-condp']);
  } else if (mod['term-cd']) {
    const label = resolveTerm(dict, 'term-cd', mod['term-cd']);
    if (label) conditions.push(label);
  }

  return {
    num: normalizeNum(product.num),
    libelle,
    gtin: mod['code-gtin'] ? String(mod['code-gtin']) : '',
    conditions_delivrance: conditions
  };
}

function parsePresentations(product, dict) {
  const presentations = [];
  const seen = new Set();

  const add = (item) => {
    if (!item) return;
    const key = `${item.libelle}|${item.gtin}`;
    if (seen.has(key)) return;
    seen.add(key);
    presentations.push(item);
  };

  for (const mod of asArray(product['modele-destine-vente']?.['mod-vte'])) {
    add(parsePresentationFromMod(product, mod, dict));
  }

  for (const mod of asArray(product['mdv-codes-gtin']?.['mod-vte'])) {
    add(parsePresentationFromMod(product, mod, dict));
  }

  return presentations;
}

function parseTempsAttente(product, dict) {
  const items = [];
  for (const route of asArray(product['voie-administration']?.['voie-admin'])) {
    if (!route['qte-ta']) continue;
    items.push({
      voie: resolveTerm(dict, 'term-va', route['term-va']),
      espece: resolveTerm(dict, 'term-esp', route['term-esp']),
      denree: resolveTerm(dict, 'term-denr', route['term-denr']),
      quantite: String(route['qte-ta']),
      unite: resolveTerm(dict, 'term-unite', route['term-unite'])
    });
  }
  return items;
}

function normalizeNum(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.padStart(7, '0');
}

function parseMedicament(product, dict) {
  const num = normalizeNum(product.num);
  return {
    num,
    nom: product.nom || '',
    num_amm: product['num-amm'] || '',
    date_amm: parseDateAmm(product['date-amm']),
    titulaire: resolveTerm(dict, 'term-tit', product['term-tit']),
    forme_pharmaceutique: resolveTerm(dict, 'term-fp', product['term-fp']),
    statut_amm: resolveTerm(dict, 'term-stat-auto', product['term-stat-auto']),
    codes_atcvet: parseAtcvetCodes(product),
    especes: parseEspeces(product, dict),
    maj_rcp: parseMajRcp(product)
  };
}

function buildVetIndexDocument(item, rowIndex, fields) {
  const doc = { id: rowIndex };
  for (const field of fields) {
    const value = item[field];
    if (value != null && value !== '') {
      doc[field] = value;
    }
  }
  return doc;
}

function vetIndexConfig(fields, boost = null) {
  const indexConfig = {
    fields,
    storeFields: ['id'],
    ...miniSearchOptions
  };
  if (boost) indexConfig.boost = boost;
  return indexConfig;
}

function extractDateJeuFromHeader(filepath) {
  try {
    const fd = fs.openSync(filepath, 'r');
    const buffer = Buffer.alloc(8192);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    const header = buffer.slice(0, bytes).toString('utf8');
    const match = header.match(/<date-jeu-de-donnees>([^<]+)<\/date-jeu-de-donnees>/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function parseProductBlock(blockXml) {
  const wrapped = `<?xml version="1.0" encoding="UTF-8"?><root>${blockXml}</root>`;
  const parsed = xmlParser.parse(wrapped);
  const raw = parsed.root?.['medicinal-product'] ?? parsed.root;
  const product = Array.isArray(raw) ? raw[0] : raw;
  if (!product || !product.num || !product.nom) return null;
  return product;
}

function appendToNumList(map, num, item) {
  if (!num) return;
  if (!map.has(num)) map.set(num, []);
  map.get(num).push(item);
}

const RELATED_BY_NUM_MAPS = {
  compositions: 'compositionsByNum',
  presentations: 'presentationsByNum'
};

function buildNumIndexes() {
  const medicamentsByNum = new Map();
  for (const item of vetCache.medicaments) {
    if (item.num) medicamentsByNum.set(item.num, item);
  }

  const compositionsByNum = new Map();
  for (const item of vetCache.compositions) {
    appendToNumList(compositionsByNum, item.num, item);
  }

  const presentationsByNum = new Map();
  for (const item of vetCache.presentations) {
    appendToNumList(presentationsByNum, item.num, item);
  }

  numIndexes = { medicamentsByNum, compositionsByNum, presentationsByNum };
}

function clearLoadedData() {
  searchIndexes.medicaments = null;
  searchIndexes.compositions = null;
  vetCache.medicaments = [];
  vetCache.compositions = [];
  vetCache.presentations = [];
  vetCache.tempsAttente = new Map();
  numIndexes = null;
}

/**
 * Chargement vétérinaire en deux temps (fast-xml-parser) :
 * 1. Stream XML → vetCache (sans indexation) ;
 * 2. buildFrozenIndexFromRows sur medicaments / compositions.
 * Les blocs <paragraphes-rcp> et <lien-rcp> sont ignorés au parse (stopNodes) ;
 * lien_rcp API est reconstruit depuis nom + maj_rcp.
 */
async function loadVetData() {
  const productsPath = path.join(dataDir, productsFileName);
  const dictPath = path.join(dataDir, dictFileName);

  if (!fs.existsSync(productsPath)) {
    throw new Error(`Fichier produits vétérinaires introuvable: ${productsPath}`);
  }
  if (!fs.existsSync(dictPath)) {
    throw new Error(`Dictionnaire vétérinaire introuvable: ${dictPath}`);
  }

  console.log('Chargement des données vétérinaires (streaming)...');
  clearLoadedData();
  loadMemoryMark('vet_start');

  const dict = parseDictionary(fs.readFileSync(dictPath, 'utf8'));
  loadMemoryMark('vet_dict_loaded');
  const dateJeu = extractDateJeuFromHeader(productsPath);
  if (dateJeu) {
    vetCache.metadata.last_updated = new Date(dateJeu).toISOString();
  } else {
    vetCache.metadata.last_updated = fs.statSync(productsPath).mtime.toISOString();
  }

  const medicamentFields = ['nom', 'num'];
  const compositionFields = ['substance', 'num'];

  await streamMedicinalProducts(productsPath, async (blockXml) => {
    const product = parseProductBlock(blockXml);
    if (!product) return;

    const medicament = parseMedicament(product, dict);
    vetCache.medicaments.push(medicament);

    for (const line of parseCompositionLines(product, dict)) {
      vetCache.compositions.push(line);
    }

    for (const presentation of parsePresentations(product, dict)) {
      vetCache.presentations.push(presentation);
    }

    const waiting = parseTempsAttente(product, dict);
    if (waiting.length > 0) {
      vetCache.tempsAttente.set(medicament.num, waiting);
    }
  });
  loadMemoryMark('vet_stream_done', {
    medicaments: vetCache.medicaments.length,
    compositions: vetCache.compositions.length
  });

  console.log('Indexation vétérinaire (médicaments)...');
  loadMemoryMark('vet_index_medicaments_start');
  searchIndexes.medicaments = buildFrozenIndexFromRows(
    vetCache.medicaments,
    (item, rowIndex) => buildVetIndexDocument(item, rowIndex, medicamentFields),
    vetIndexConfig(medicamentFields, { nom: 3, num: 2 })
  );
  loadMemoryMark('vet_index_medicaments_done');

  console.log('Indexation vétérinaire (compositions)...');
  loadMemoryMark('vet_index_compositions_start');
  searchIndexes.compositions = buildFrozenIndexFromRows(
    vetCache.compositions,
    (item, rowIndex) => buildVetIndexDocument(item, rowIndex, compositionFields),
    vetIndexConfig(compositionFields, { substance: 3, num: 1 })
  );
  loadMemoryMark('vet_index_compositions_done');
  buildNumIndexes();
  loadMemoryMark('vet_done', { medicaments: vetCache.medicaments.length });
  console.log(`Données vétérinaires chargées: ${vetCache.medicaments.length} médicaments`);
}

function searchVet(type, query) {
  if (!query) return getVetCorpus(type);
  if (!searchIndexes[type]) return [];

  const results = searchIndexes[type].search(query);
  const primaryField = PRIMARY_FIELDS[type];

  const rankedResults = results.map((res) => {
    const item = vetCache[type][res.id];
    const primaryValue = item && item[primaryField] ? item[primaryField] : '';
    const idValue = item && item.num ? item.num : '';
    const priority = computeMatchPriority(primaryValue, query, { idValue });

    return { item, score: res.score, priority, match_quality: matchQualityFromPriority(priority) };
  });

  rankedResults.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return b.score - a.score;
  });

  return rankedResults.map((r) => {
    const row =
      type === 'medicaments' ? enrichMedicamentForApi(r.item) : { ...r.item };
    return { ...row, match_quality: r.match_quality };
  });
}

function filterPresentationsLinear(query) {
  if (!query) return vetCache.presentations;
  const normalizedQuery = normalizeSearchText(query);
  return vetCache.presentations.filter((item) => {
    const libelle = normalizeSearchText(item.libelle || '');
    const gtin = item.gtin || '';
    return libelle.includes(normalizedQuery) || gtin.includes(query);
  });
}

function getVetCorpus(type) {
  return vetCache[type] || [];
}

function getVetData(type) {
  const rows = getVetCorpus(type);
  if (type !== 'medicaments') return rows;
  return rows.map(enrichMedicamentForApi);
}

function getVetMetadata() {
  return vetCache.metadata;
}

function getMedicamentByNum(num) {
  if (!numIndexes) return undefined;
  const row = numIndexes.medicamentsByNum.get(normalizeNum(num));
  return row ? enrichMedicamentForApi(row) : undefined;
}

function getRelatedByNum(type, num, limit = 50) {
  if (!num) return [];
  const normalized = normalizeNum(num);
  if (type === 'temps_attente') {
    return vetCache.tempsAttente.get(normalized) || [];
  }
  if (!numIndexes) return [];
  const mapKey = RELATED_BY_NUM_MAPS[type];
  if (!mapKey) return [];
  const rows = numIndexes[mapKey].get(normalized) || [];
  return limit > 0 ? rows.slice(0, limit) : rows;
}

module.exports = {
  loadVetData,
  searchVet,
  getVetCorpus,
  getVetData,
  getVetMetadata,
  getMedicamentByNum,
  getRelatedByNum,
  filterPresentationsLinear,
  buildLienRcpFromNom,
  ANMV_RCP_URL_PREFIX
};
