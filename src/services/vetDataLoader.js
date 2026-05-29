const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const { buildFrozenIndexFromRows } = require('../utils/frozenMiniSearch');
const { streamMedicinalProducts } = require('../utils/streamMedicinalProductsXml');
const { loadMemoryMark } = require('../utils/memorySampler');
const { VET_SCHEMAS } = require('../utils/corpusSchemas');
const { rankAndMaterializeSearch } = require('../utils/corpusSearch');
const {
  createStore,
  clearStore,
  rowCount,
  keyIndex,
  indexFieldIndices,
  pushRow,
  getRowValue,
  toObject,
  toObjects,
  materializeRowRange,
  buildIndexDocumentFromRow,
  buildKeyIndex
} = require('../utils/rowStore');
const { miniSearchOptions, normalizeSearchText } = require('../utils/searchRanking');
const {
  VET_DATA_DIR,
  PRODUCTS_XML_NAME,
  DICT_XML_NAME
} = require('./vetDataDownloader');

const dataDir = process.env.VET_DATA_DIR || VET_DATA_DIR;
const productsFileName = process.env.VET_PRODUCTS_FILE || PRODUCTS_XML_NAME;
const dictFileName = process.env.VET_DICT_FILE || DICT_XML_NAME;
const MAX_LIST_LIMIT = 1000;

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

const vetStores = {
  medicaments: createStore(VET_SCHEMAS.medicaments),
  compositions: createStore(VET_SCHEMAS.compositions),
  presentations: createStore(VET_SCHEMAS.presentations)
};

let tempsAttente = new Map();

const metadata = {
  last_updated: null,
  source: 'base de données publique des médicaments vétérinaires autorisés en France - Anses/ANMV'
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

const primaryFieldIdx = {
  medicaments: keyIndex(vetStores.medicaments, 'nom'),
  compositions: keyIndex(vetStores.compositions, 'substance')
};

const numFieldIdx = {
  medicaments: keyIndex(vetStores.medicaments, 'num'),
  compositions: keyIndex(vetStores.compositions, 'num')
};

const presentationFilterIdx = {
  libelle: keyIndex(vetStores.presentations, 'libelle'),
  gtin: keyIndex(vetStores.presentations, 'gtin')
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

function enrichMedicamentRow(obj) {
  return enrichMedicamentForApi(obj);
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

function normalizeNum(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.padStart(7, '0');
}

function pushMedicamentRow(store, product, dict) {
  return pushRow(store, [
    normalizeNum(product.num),
    product.nom || '',
    product['num-amm'] || '',
    parseDateAmm(product['date-amm']),
    resolveTerm(dict, 'term-tit', product['term-tit']),
    resolveTerm(dict, 'term-fp', product['term-fp']),
    resolveTerm(dict, 'term-stat-auto', product['term-stat-auto']),
    parseAtcvetCodes(product),
    parseEspeces(product, dict),
    parseMajRcp(product)
  ]);
}

function pushCompositionFromSa(store, num, sa, dict) {
  pushRow(store, [
    num,
    resolveTerm(dict, 'term-sa', sa['term-sa']),
    sa.quantite != null ? String(sa.quantite) : '',
    sa.unite || resolveTerm(dict, 'term-unite', sa['term-unite'])
  ]);
}

function pushCompositionRows(store, product, dict) {
  const num = normalizeNum(product.num);
  const composition = product.composition;
  if (!composition) return;

  const compoBlocks = asArray(composition.compo);
  if (compoBlocks.length > 0) {
    for (const block of compoBlocks) {
      for (const sa of asArray(block.sa)) {
        pushCompositionFromSa(store, num, sa, dict);
      }
    }
    return;
  }

  for (const sa of asArray(composition.sa)) {
    pushCompositionFromSa(store, num, sa, dict);
  }
}

function pushPresentationRow(store, num, mod, dict) {
  const libelle = mod['lib-mod'];
  if (!libelle) return false;

  const conditions = [];
  if (mod['lib-condp']) {
    conditions.push(mod['lib-condp']);
  } else if (mod['term-cd']) {
    const label = resolveTerm(dict, 'term-cd', mod['term-cd']);
    if (label) conditions.push(label);
  }

  pushRow(store, [
    num,
    libelle,
    mod['code-gtin'] ? String(mod['code-gtin']) : '',
    conditions
  ]);
  return true;
}

function pushPresentationRows(store, product, dict) {
  const num = normalizeNum(product.num);
  const seen = new Set();

  const tryAdd = (mod) => {
    if (!mod) return;
    const libelle = mod['lib-mod'];
    if (!libelle) return;
    const gtin = mod['code-gtin'] ? String(mod['code-gtin']) : '';
    const key = `${libelle}|${gtin}`;
    if (seen.has(key)) return;
    seen.add(key);
    pushPresentationRow(store, num, mod, dict);
  };

  for (const mod of asArray(product['modele-destine-vente']?.['mod-vte'])) {
    tryAdd(mod);
  }
  for (const mod of asArray(product['mdv-codes-gtin']?.['mod-vte'])) {
    tryAdd(mod);
  }
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

const RELATED_BY_NUM_MAPS = {
  compositions: 'compositionsByNum',
  presentations: 'presentationsByNum'
};

function buildNumIndexes() {
  numIndexes = {
    medicamentsByNum: buildKeyIndex(vetStores.medicaments, 'num', { unique: true }),
    compositionsByNum: buildKeyIndex(vetStores.compositions, 'num'),
    presentationsByNum: buildKeyIndex(vetStores.presentations, 'num')
  };
}

function clearLoadedData() {
  searchIndexes.medicaments = null;
  searchIndexes.compositions = null;
  clearStore(vetStores.medicaments);
  clearStore(vetStores.compositions);
  clearStore(vetStores.presentations);
  tempsAttente = new Map();
  numIndexes = null;
}

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
    metadata.last_updated = new Date(dateJeu).toISOString();
  } else {
    metadata.last_updated = fs.statSync(productsPath).mtime.toISOString();
  }

  const medicamentFields = ['nom', 'num'];
  const compositionFields = ['substance', 'num'];
  const medFieldIndices = indexFieldIndices(vetStores.medicaments, medicamentFields);
  const compFieldIndices = indexFieldIndices(vetStores.compositions, compositionFields);

  await streamMedicinalProducts(productsPath, async (blockXml) => {
    const product = parseProductBlock(blockXml);
    if (!product) return;

    const num = pushMedicamentRow(vetStores.medicaments, product, dict);
    pushCompositionRows(vetStores.compositions, product, dict);
    pushPresentationRows(vetStores.presentations, product, dict);

    const waiting = parseTempsAttente(product, dict);
    if (waiting.length > 0) {
      const medNum = getRowValue(vetStores.medicaments, num, numFieldIdx.medicaments);
      tempsAttente.set(medNum, waiting);
    }
  });
  loadMemoryMark('vet_stream_done', {
    medicaments: rowCount(vetStores.medicaments),
    compositions: rowCount(vetStores.compositions)
  });

  console.log('Indexation vétérinaire (médicaments)...');
  loadMemoryMark('vet_index_medicaments_start');
  const medStore = vetStores.medicaments;
  searchIndexes.medicaments = buildFrozenIndexFromRows(
    medStore.rows,
    (_row, rowIndex) => buildIndexDocumentFromRow(medStore, rowIndex, medFieldIndices),
    vetIndexConfig(medicamentFields, { nom: 3, num: 2 })
  );
  loadMemoryMark('vet_index_medicaments_done');

  console.log('Indexation vétérinaire (compositions)...');
  loadMemoryMark('vet_index_compositions_start');
  const compStore = vetStores.compositions;
  searchIndexes.compositions = buildFrozenIndexFromRows(
    compStore.rows,
    (_row, rowIndex) => buildIndexDocumentFromRow(compStore, rowIndex, compFieldIndices),
    vetIndexConfig(compositionFields, { substance: 3, num: 1 })
  );
  loadMemoryMark('vet_index_compositions_done');
  buildNumIndexes();
  loadMemoryMark('vet_done', { medicaments: rowCount(vetStores.medicaments) });
  console.log(`Données vétérinaires chargées: ${rowCount(vetStores.medicaments)} médicaments`);
}

function searchVet(type, query) {
  if (!query) return [];
  if (!searchIndexes[type]) return [];

  const store = vetStores[type];
  const results = searchIndexes[type].search(query);
  const mapRow =
    type === 'medicaments'
      ? (obj, _i, match_quality) => Object.assign(enrichMedicamentForApi(obj), { match_quality })
      : null;

  return rankAndMaterializeSearch(
    store,
    results,
    query,
    { primaryIdx: primaryFieldIdx[type], idIdx: numFieldIdx[type] },
    mapRow
  );
}

function collectPresentationMatchIndices(query) {
  const store = vetStores.presentations;
  const normalizedQuery = normalizeSearchText(query);
  const libIdx = presentationFilterIdx.libelle;
  const gtinIdx = presentationFilterIdx.gtin;
  const indices = [];
  for (let i = 0; i < store.rows.length; i++) {
    const libelle = normalizeSearchText(getRowValue(store, i, libIdx));
    const gtin = getRowValue(store, i, gtinIdx);
    if (libelle.includes(normalizedQuery) || gtin.includes(query)) {
      indices.push(i);
    }
  }
  return indices;
}

function parseListPaging(page, limit) {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(MAX_LIST_LIMIT, Math.max(1, parseInt(limit, 10) || 100));
  const offset = (safePage - 1) * safeLimit;
  return { safePage, safeLimit, offset };
}

function listVetCorpusPage(type, page = 1, limit = 100) {
  const store = vetStores[type];
  if (!store) {
    return {
      data: [],
      pagination: { total: 0, page: 1, limit: 100, pages: 0 },
      metadata: { last_updated: metadata.last_updated, source: metadata.source }
    };
  }

  const { safePage, safeLimit, offset } = parseListPaging(page, limit);
  const total = rowCount(store);
  const end = Math.min(offset + safeLimit, total);
  const mapRow = type === 'medicaments' ? enrichMedicamentRow : null;
  const data = materializeRowRange(store, offset, end, mapRow);

  return {
    data,
    pagination: {
      total,
      page: safePage,
      limit: safeLimit,
      pages: Math.ceil(total / safeLimit) || 0
    },
    metadata: {
      last_updated: metadata.last_updated,
      source: metadata.source
    }
  };
}

/** Présentations filtrées par requête, paginées (indices d’abord, objets seulement sur la page). */
function listPresentationsPage(query, page = 1, limit = 100) {
  const indices = collectPresentationMatchIndices(query);
  const { safePage, safeLimit, offset } = parseListPaging(page, limit);
  const total = indices.length;
  const end = Math.min(offset + safeLimit, total);
  const pageIndices = indices.slice(offset, end);
  const store = vetStores.presentations;

  return {
    data: toObjects(store, pageIndices),
    pagination: {
      total,
      page: safePage,
      limit: safeLimit,
      pages: Math.ceil(total / safeLimit) || 0
    },
    metadata: {
      last_updated: metadata.last_updated,
      source: metadata.source
    }
  };
}

function getVetMetadata() {
  return metadata;
}

function getMedicamentByNum(num) {
  if (!numIndexes) return undefined;
  const rowIndex = numIndexes.medicamentsByNum.get(normalizeNum(num));
  if (rowIndex === undefined) return undefined;
  return enrichMedicamentForApi(toObject(vetStores.medicaments, rowIndex));
}

function getRelatedByNum(type, num, limit = 50) {
  if (!num) return [];
  const normalized = normalizeNum(num);
  if (type === 'temps_attente') {
    return tempsAttente.get(normalized) || [];
  }
  if (!numIndexes) return [];
  const mapKey = RELATED_BY_NUM_MAPS[type];
  if (!mapKey) return [];
  const store = vetStores[type];
  const indices = numIndexes[mapKey].get(normalized) || [];
  const slice = limit > 0 ? indices.slice(0, limit) : indices;
  return toObjects(store, slice);
}

function getVetCorpusStats() {
  const byType = {};
  for (const type of Object.keys(vetStores)) {
    byType[type] = { rows: rowCount(vetStores[type]), keys: vetStores[type].keys };
  }
  return { byType, stores: vetStores };
}

module.exports = {
  loadVetData,
  searchVet,
  listVetCorpusPage,
  listPresentationsPage,
  getVetMetadata,
  getMedicamentByNum,
  getRelatedByNum,
  buildLienRcpFromNom,
  ANMV_RCP_URL_PREFIX,
  getVetCorpusStats
};
