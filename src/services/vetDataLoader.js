const fs = require('fs');
const path = require('path');
const { buildFrozenIndexFromRows } = require('../utils/frozenMiniSearch');
const { streamMedicinalProducts } = require('../utils/streamMedicinalProductsXml');
const {
  defaultProductParser,
  parseProductBlock
} = require('../utils/vetXmlParser');
const { loadMemoryMark } = require('../utils/memorySampler');
const { rankAndMaterializeSearch } = require('../utils/corpusSearch');
const {
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
const { intern } = require('../utils/stringPool');
const config = require('../config');
const { VET_INDEX_SPECS } = require('../search/indexSpecs');
const state = require('./vet/state');
const { exportVetSearchIndexes, exportVetCorpusDocuments } = require('./vet/exportApi');

function internElements(arr) {
  if (!arr || !arr.length) return arr;
  for (let i = 0; i < arr.length; i++) arr[i] = intern(arr[i]);
  return arr;
}

const dataDir = config.vetDataDir;
const productsFileName = config.vetProductsFile;
const dictFileName = config.vetDictFile;

const { corpus, metadata, searchIndexes, RELATED_BY_NUM_MAPS } = state;

/* ------------------------------------------------------------------ *
 * Parsing du dictionnaire ANMV (streaming, faible mémoire)
 * ------------------------------------------------------------------ */

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

/**
 * Tokeniseur streaming sur le dict ANMV : scan par regex sur des chunks lus
 * via un ReadStream, état maintenu entre chunks. Évite la matérialisation de
 * l'arbre JS complet que produirait `defaultDictionaryParser.parse(...)` (pic
 * ~90 Mo → ~1-2 Mo : buffer borné par le plus long token incomplet + Maps).
 *
 * Le format du dict est plat, sans attribut, sans CDATA : chaque `<entry>`
 * contient exactement un `<source-code>` et un `<source-desc>` (parfois un
 * `<ordre>` ignoré). Les sections `<term-XXX />` auto-fermantes (vides) sont
 * gérées. Le tokenizer est insensible au formatage (pretty-printed ou compact).
 */
const TOKEN_RE = /<\/term-([a-z][a-z0-9-]*)\s*>|<term-([a-z][a-z0-9-]*)\b[^>]*?\/>|<term-([a-z][a-z0-9-]*)\b[^>]*?>|<entry\b[^>]*?\/>|<entry\b[^>]*?>|<\/entry>|<source-code>([^<]*)<\/source-code>|<source-desc>([^<]*)<\/source-desc>/g;

async function parseDictionaryFromStream(filepath) {
  const dict = {};
  const stream = fs.createReadStream(filepath, { encoding: 'utf8' });

  let buffer = '';
  let currentTerm = null;
  let inEntry = false;
  let pendingCode = null;
  let pendingDesc = null;

  for await (const chunk of stream) {
    buffer += chunk;
    TOKEN_RE.lastIndex = 0;
    let lastEnd = 0;
    let match;
    while ((match = TOKEN_RE.exec(buffer)) !== null) {
      lastEnd = TOKEN_RE.lastIndex;
      const full = match[0];
      if (match[1] !== undefined) {
        currentTerm = null;
      } else if (match[2] !== undefined) {
        // <term-XXX /> auto-fermant : section vide, rien à faire
      } else if (match[3] !== undefined) {
        currentTerm = 'term-' + match[3];
        if (!dict[currentTerm]) dict[currentTerm] = new Map();
      } else if (match[4] !== undefined) {
        if (inEntry) pendingCode = match[4].trim();
      } else if (match[5] !== undefined) {
        if (inEntry) pendingDesc = match[5].trim();
      } else if (full === '</entry>') {
        if (inEntry && currentTerm && pendingCode !== null) {
          dict[currentTerm].set(pendingCode, pendingDesc || '');
        }
        inEntry = false;
      } else if (full.endsWith('/>')) {
        // <entry /> auto-fermant : ignoré
      } else {
        // <entry> ouvrant
        inEntry = true;
        pendingCode = null;
        pendingDesc = null;
      }
    }
    if (lastEnd > 0) {
      buffer = buffer.slice(lastEnd);
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
      internElements(parseAtcvetCodes(product)),
      parseEspeces(product, dict),
      intern(parseMajRcp(product))
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
      intern(sa.unite || resolveTerm(dict, 'term-unite', sa['term-unite']))
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
    conditions.push(intern(mod['lib-condp']));
  } else if (mod['term-cd']) {
    const label = resolveTerm(dict, 'term-cd', mod['term-cd']);
    if (label) conditions.push(label);
  }

  push(
    presentations,
    new PresentationVet(
      num,
      intern(libelle),
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

function buildNumIndexes() {
  state.setNumIndexes({
    medicamentsByNum: buildKeyIndex(corpus.medicaments, 'num', { unique: true }),
    compositionsByNum: buildKeyIndex(corpus.compositions, 'num'),
    presentationsByNum: buildKeyIndex(corpus.presentations, 'num')
  });
}

function clearLoadedData() {
  searchIndexes.medicaments = null;
  searchIndexes.compositions = null;
  clearCorpus(corpus.medicaments);
  clearCorpus(corpus.compositions);
  clearCorpus(corpus.presentations);
  state.setTempsAttente(new Map());
  state.setNumIndexes(null);
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

  const dict = await parseDictionaryFromStream(dictPath);
  loadMemoryMark('vet_dict_loaded');
  const dateJeu = extractDateJeuFromHeader(productsPath);
  if (dateJeu) {
    metadata.last_updated = new Date(dateJeu).toISOString();
  } else {
    metadata.last_updated = fs.statSync(productsPath).mtime.toISOString();
  }

  const medicamentFields = VET_INDEX_SPECS.medicaments.fields;
  const compositionFields = VET_INDEX_SPECS.compositions.fields;

  await streamMedicinalProducts(productsPath, async (blockXml) => {
    const product = parseProductBlock(blockXml, defaultProductParser);
    if (!product) return;

    const rowIndex = pushMedicament(corpus.medicaments, product, dict);
    pushCompositionRows(corpus.compositions, product, dict);
    pushPresentationRows(corpus.presentations, product, dict);

    const waiting = parseTempsAttente(product, dict);
    if (waiting.length > 0) {
      const medNum = corpus.medicaments[rowIndex].num;
      state.getTempsAttente().set(medNum, waiting);
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
    miniSearchIndexConfig(medicamentFields, VET_INDEX_SPECS.medicaments.boost)
  );
  loadMemoryMark('vet_index_medicaments_done');

  console.log('Indexation vétérinaire (compositions)...');
  loadMemoryMark('vet_index_compositions_start');
  searchIndexes.compositions = buildFrozenIndexFromRows(
    corpus.compositions,
    (item, rowIndex) => buildIndexDocument(item, rowIndex, compositionFields),
    miniSearchIndexConfig(compositionFields, VET_INDEX_SPECS.compositions.boost)
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
  const spec = VET_INDEX_SPECS[type];
  const results = searchIndexes[type].search(query);
  return rankAndMaterializeSearch(rows, results, query, {
    primaryField: spec.primaryField,
    idField: spec.idField
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
  const numIndexes = state.getNumIndexes();
  if (!numIndexes) return undefined;
  const rowIndex = numIndexes.medicamentsByNum.get(normalizeNum(num));
  if (rowIndex === undefined) return undefined;
  return corpus.medicaments[rowIndex].toJSON();
}

function getRelatedByNum(type, num, limit = 50) {
  if (!num) return [];
  const normalized = normalizeNum(num);
  if (type === 'temps_attente') {
    const entries = state.getTempsAttente().get(normalized) || [];
    return entries.map((e) => e.toJSON());
  }
  const numIndexes = state.getNumIndexes();
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

function getVetSearchIndexes() {
  return { medicaments: searchIndexes.medicaments, compositions: searchIndexes.compositions };
}

module.exports = {
  loadVetData,
  exportVetSearchIndexes,
  exportVetCorpusDocuments,
  searchVet,
  listVetCorpusPage,
  listPresentationsPage,
  getVetMetadata,
  getMedicamentByNum,
  getRelatedByNum,
  buildLienRcpFromNom,
  ANMV_RCP_URL_PREFIX,
  getVetCorpusStats,
  getVetSearchIndexes
};
