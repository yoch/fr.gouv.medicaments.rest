const fs = require('fs');
const path = require('path');
const { buildFrozenIndexFromRows, exportFrozenIndexes } = require('../utils/frozenMiniSearch');
const { streamMedicinalProducts } = require('../utils/streamMedicinalProductsXml');
const {
  defaultDictionaryParser,
  defaultProductParser,
  parseProductBlock
} = require('../utils/vetXmlParser');
const { loadMemoryMark } = require('../utils/memorySampler');
const { rankAndMaterializeSearch } = require('../utils/corpusSearch');
const {
  createCorpus,
  clearCorpus,
  push,
  rowCount,
  materializeRange,
  materializeIndices,
  buildKeyIndex,
  buildIndexDocument
} = require('../utils/corpusStore');
const { normalizeSearchText } = require('../utils/searchRanking');
const { parseListPaging } = require('../utils/corpusPaging');
const { miniSearchIndexConfig } = require('../utils/miniSearchIndexConfig');
const { MedicamentVet, CompositionVet, PresentationVet } = require('../models/vet');
const { TempsAttenteEntry } = require('../models/tempsAttente');
const { buildLienRcpFromNom, ANMV_RCP_URL_PREFIX } = require('../models/vet/rcp');
const {
  VET_DATA_DIR,
  PRODUCTS_XML_NAME,
  DICT_XML_NAME
} = require('./vetDataDownloader');

const dataDir = process.env.VET_DATA_DIR || VET_DATA_DIR;
const productsFileName = process.env.VET_PRODUCTS_FILE || PRODUCTS_XML_NAME;
const dictFileName = process.env.VET_DICT_FILE || DICT_XML_NAME;

const corpus = {
  medicaments: createCorpus(),
  compositions: createCorpus(),
  presentations: createCorpus()
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

const ID_FIELDS = {
  medicaments: 'num',
  compositions: 'num'
};

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
  const parsed = defaultDictionaryParser.parse(xmlContent);
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

function pushMedicament(medicaments, product, dict) {
  return push(
    medicaments,
    new MedicamentVet(
      normalizeNum(product.num),
      product.nom || '',
      resolveTerm(dict, 'term-tit', product['term-tit']),
      resolveTerm(dict, 'term-fp', product['term-fp']),
      resolveTerm(dict, 'term-stat-auto', product['term-stat-auto']),
      parseAtcvetCodes(product),
      parseEspeces(product, dict),
      parseMajRcp(product)
    )
  );
}

function pushCompositionFromSa(compositions, num, sa, dict) {
  push(
    compositions,
    new CompositionVet(
      num,
      resolveTerm(dict, 'term-sa', sa['term-sa']),
      sa.quantite != null ? String(sa.quantite) : '',
      sa.unite || resolveTerm(dict, 'term-unite', sa['term-unite'])
    )
  );
}

function pushCompositionRows(compositions, product, dict) {
  const num = normalizeNum(product.num);
  const composition = product.composition;
  if (!composition) return;

  const compoBlocks = asArray(composition.compo);
  if (compoBlocks.length > 0) {
    for (const block of compoBlocks) {
      for (const sa of asArray(block.sa)) {
        pushCompositionFromSa(compositions, num, sa, dict);
      }
    }
    return;
  }

  for (const sa of asArray(composition.sa)) {
    pushCompositionFromSa(compositions, num, sa, dict);
  }
}

function pushPresentation(presentations, num, mod, dict) {
  const libelle = mod['lib-mod'];
  if (!libelle) return false;

  const conditions = [];
  if (mod['lib-condp']) {
    conditions.push(mod['lib-condp']);
  } else if (mod['term-cd']) {
    const label = resolveTerm(dict, 'term-cd', mod['term-cd']);
    if (label) conditions.push(label);
  }

  push(
    presentations,
    new PresentationVet(
      num,
      libelle,
      mod['code-gtin'] ? String(mod['code-gtin']) : '',
      conditions
    )
  );
  return true;
}

function pushPresentationRows(presentations, product, dict) {
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
    pushPresentation(presentations, num, mod, dict);
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
    items.push(
      new TempsAttenteEntry(
        resolveTerm(dict, 'term-va', route['term-va']),
        resolveTerm(dict, 'term-esp', route['term-esp']),
        resolveTerm(dict, 'term-denr', route['term-denr']),
        String(route['qte-ta']),
        resolveTerm(dict, 'term-unite', route['term-unite'])
      )
    );
  }
  return items;
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

const RELATED_BY_NUM_MAPS = {
  compositions: 'compositionsByNum',
  presentations: 'presentationsByNum'
};

function buildNumIndexes() {
  numIndexes = {
    medicamentsByNum: buildKeyIndex(corpus.medicaments, 'num', { unique: true }),
    compositionsByNum: buildKeyIndex(corpus.compositions, 'num'),
    presentationsByNum: buildKeyIndex(corpus.presentations, 'num')
  };
}

function clearLoadedData() {
  searchIndexes.medicaments = null;
  searchIndexes.compositions = null;
  clearCorpus(corpus.medicaments);
  clearCorpus(corpus.compositions);
  clearCorpus(corpus.presentations);
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

  await streamMedicinalProducts(productsPath, async (blockXml) => {
    const product = parseProductBlock(blockXml, defaultProductParser);
    if (!product) return;

    const rowIndex = pushMedicament(corpus.medicaments, product, dict);
    pushCompositionRows(corpus.compositions, product, dict);
    pushPresentationRows(corpus.presentations, product, dict);

    const waiting = parseTempsAttente(product, dict);
    if (waiting.length > 0) {
      const medNum = corpus.medicaments[rowIndex].num;
      tempsAttente.set(medNum, waiting);
    }
  });
  loadMemoryMark('vet_stream_done', {
    medicaments: rowCount(corpus.medicaments),
    compositions: rowCount(corpus.compositions)
  });

  console.log('Indexation vétérinaire (médicaments)...');
  loadMemoryMark('vet_index_medicaments_start');
  searchIndexes.medicaments = buildFrozenIndexFromRows(
    corpus.medicaments,
    (item, rowIndex) => buildIndexDocument(item, rowIndex, medicamentFields),
    miniSearchIndexConfig(medicamentFields, { nom: 3, num: 2 })
  );
  loadMemoryMark('vet_index_medicaments_done');

  console.log('Indexation vétérinaire (compositions)...');
  loadMemoryMark('vet_index_compositions_start');
  searchIndexes.compositions = buildFrozenIndexFromRows(
    corpus.compositions,
    (item, rowIndex) => buildIndexDocument(item, rowIndex, compositionFields),
    miniSearchIndexConfig(compositionFields, { substance: 3, num: 1 })
  );
  loadMemoryMark('vet_index_compositions_done');
  buildNumIndexes();
  loadMemoryMark('vet_done', { medicaments: rowCount(corpus.medicaments) });
  console.log(`Données vétérinaires chargées: ${rowCount(corpus.medicaments)} médicaments`);
}

function searchVet(type, query) {
  if (!query) return [];
  if (!searchIndexes[type]) return [];

  const rows = corpus[type];
  const results = searchIndexes[type].search(query);
  return rankAndMaterializeSearch(rows, results, query, {
    primaryField: PRIMARY_FIELDS[type],
    idField: ID_FIELDS[type]
  });
}

function collectPresentationMatchIndices(query) {
  const presentations = corpus.presentations;
  const normalizedQuery = normalizeSearchText(query);
  const indices = [];
  for (let i = 0; i < presentations.length; i++) {
    const row = presentations[i];
    const libelle = normalizeSearchText(row.libelle);
    const gtin = row.gtin;
    if (libelle.includes(normalizedQuery) || gtin.includes(query)) {
      indices.push(i);
    }
  }
  return indices;
}

function listVetCorpusPage(type, page = 1, limit = 100) {
  const rows = corpus[type];
  if (!rows) {
    return {
      data: [],
      pagination: { total: 0, page: 1, limit: 100, pages: 0 },
      metadata: { last_updated: metadata.last_updated, source: metadata.source }
    };
  }

  const { safePage, safeLimit, offset } = parseListPaging(page, limit);
  const total = rowCount(rows);
  const end = Math.min(offset + safeLimit, total);
  const data = materializeRange(rows, offset, end);

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

function listPresentationsPage(query, page = 1, limit = 100) {
  const indices = collectPresentationMatchIndices(query);
  const { safePage, safeLimit, offset } = parseListPaging(page, limit);
  const total = indices.length;
  const end = Math.min(offset + safeLimit, total);
  const pageIndices = indices.slice(offset, end);

  return {
    data: materializeIndices(corpus.presentations, pageIndices),
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
  return corpus.medicaments[rowIndex].toJSON();
}

function getRelatedByNum(type, num, limit = 50) {
  if (!num) return [];
  const normalized = normalizeNum(num);
  if (type === 'temps_attente') {
    const entries = tempsAttente.get(normalized) || [];
    return entries.map((e) => e.toJSON());
  }
  if (!numIndexes) return [];
  const mapKey = RELATED_BY_NUM_MAPS[type];
  if (!mapKey) return [];
  const rows = corpus[type];
  const indices = numIndexes[mapKey].get(normalized) || [];
  const slice = limit > 0 ? indices.slice(0, limit) : indices;
  return materializeIndices(rows, slice);
}

function getVetCorpusStats() {
  const byType = {};
  for (const type of Object.keys(corpus)) {
    byType[type] = { rows: rowCount(corpus[type]) };
  }
  return { byType, corpus };
}

function exportVetSearchIndexes(outDir) {
  return exportFrozenIndexes(searchIndexes, outDir, 'vet', {
    last_updated: metadata.last_updated,
    source: metadata.source
  });
}

module.exports = {
  loadVetData,
  exportVetSearchIndexes,
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
