const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const { buildFrozenIndexFromAsyncIterable, buildFrozenIndexFromRows } = require('../utils/frozenMiniSearch');
const { miniSearchOptions } = require('../utils/searchRanking');
const { loadMemoryMark } = require('../utils/memorySampler');
const { BDPM_SCHEMAS } = require('../utils/corpusSchemas');
const { rankAndMaterializeSearch } = require('../utils/corpusSearch');
const {
  createStore,
  clearStore,
  rowCount,
  keyIndex,
  indexFieldIndices,
  pushFromRecord,
  getRowValue,
  toObject,
  toObjects,
  materializeRowRange,
  buildIndexDocumentFromRow,
  buildKeyIndex
} = require('../utils/rowStore');

const DATA_DIR = path.join(__dirname, '../../data');
const BDPM_MEDICAMENT_BASE_URL = 'https://base-donnees-publique.medicaments.gouv.fr/medicament';
const MAX_LIST_LIMIT = 1000;

const HYDRATE_RELATED_LIMIT = Math.max(
  1,
  parseInt(process.env.SEARCH_HYDRATE_RELATED_LIMIT || '50', 10)
);

const DETAIL_HYDRATE_RELATED_LIMIT = Math.max(
  0,
  parseInt(process.env.DETAIL_HYDRATE_RELATED_LIMIT || '0', 10)
);

const LOAD_HAS_AVIS = process.env.LOAD_HAS_AVIS !== 'false';

const corpusStores = {};
for (const type of Object.keys(BDPM_SCHEMAS)) {
  corpusStores[type] = createStore(BDPM_SCHEMAS[type]);
}

const metadata = {
  last_updated: null,
  source: 'base de données publique des médicaments - gouv.fr'
};

let searchIndexes = {
  specialites: null,
  presentations: null,
  compositions: null,
  avis_smr: null,
  avis_asmr: null,
  generiques: null,
  conditions: null,
  ruptures: null,
  substances: null,
  mitm: null
};

let cisIndexes = null;

const RELATED_BY_CIS_MAPS = {
  presentations: 'presentationsByCis',
  compositions: 'compositionsByCis',
  avis_smr: 'avisSmrByCis',
  avis_asmr: 'avisAsmrByCis',
  conditions: 'conditionsByCis'
};

const PRIMARY_FIELDS = {
  specialites: 'denomination',
  presentations: 'libelle',
  compositions: 'denomination_substance',
  avis_smr: 'libelle_smr',
  avis_asmr: 'libelle_asmr',
  generiques: 'libelle_groupe',
  conditions: 'condition',
  ruptures: 'libelle_statut',
  mitm: 'denomination',
  substances: 'denomination'
};

const primaryFieldIdx = {};
const cisFieldIdx = {};
for (const type of Object.keys(BDPM_SCHEMAS)) {
  primaryFieldIdx[type] = keyIndex(corpusStores[type], PRIMARY_FIELDS[type]);
  const cisIdx = keyIndex(corpusStores[type], 'cis');
  cisFieldIdx[type] = cisIdx >= 0 ? cisIdx : -1;
}

function bdpmExtraitUrl(cis) {
  return `${BDPM_MEDICAMENT_BASE_URL}/${cis}/extrait`;
}

function csvParserOptions(columns) {
  return {
    delimiter: '\t',
    columns,
    skip_empty_lines: true,
    trim: true,
    quote: false,
    escape: false,
    relax_quotes: true,
    relax_column_count: true
  };
}

function indexConfigFor(fields, boost = null) {
  const indexConfig = {
    fields,
    storeFields: ['id'],
    ...miniSearchOptions
  };
  if (boost) indexConfig.boost = boost;
  return indexConfig;
}

async function loadParseAndIndex(type, filename, fields, boost = null) {
  const filepath = path.join(DATA_DIR, filename);
  console.log(`Chargement et indexation de ${type}...`);

  const store = corpusStores[type];
  clearStore(store);
  const fieldIndices = indexFieldIndices(store, fields);
  const options = indexConfigFor(fields, boost);

  if (!fs.existsSync(filepath)) {
    console.warn(`Fichier ${filename} non trouvé`);
    searchIndexes[type] = null;
    return;
  }

  async function* documents() {
    const parser = fs
      .createReadStream(filepath, { encoding: 'utf8' })
      .pipe(parse(csvParserOptions(store.keys)));

    let rowIndex = 0;
    for await (const record of parser) {
      pushFromRecord(store, record);
      yield buildIndexDocumentFromRow(store, rowIndex, fieldIndices);
      rowIndex++;
    }
  }

  searchIndexes[type] = await buildFrozenIndexFromAsyncIterable(documents(), options);
}

async function indexInMemoryStore(type, fields, boost = null) {
  console.log(`Indexation de ${type}...`);
  const store = corpusStores[type];
  const fieldIndices = indexFieldIndices(store, fields);
  const options = indexConfigFor(fields, boost);
  searchIndexes[type] = buildFrozenIndexFromRows(
    store.rows,
    (_row, rowIndex) => buildIndexDocumentFromRow(store, rowIndex, fieldIndices),
    options
  );
}

function buildCisIndexes() {
  cisIndexes = {
    specialitesByCis: buildKeyIndex(corpusStores.specialites, 'cis', { unique: true }),
    presentationsByCis: buildKeyIndex(corpusStores.presentations, 'cis'),
    compositionsByCis: buildKeyIndex(corpusStores.compositions, 'cis'),
    avisSmrByCis: buildKeyIndex(corpusStores.avis_smr, 'cis'),
    avisAsmrByCis: buildKeyIndex(corpusStores.avis_asmr, 'cis'),
    conditionsByCis: buildKeyIndex(corpusStores.conditions, 'cis'),
    generiquesByCis: buildKeyIndex(corpusStores.generiques, 'cis'),
    generiquesByGroupe: buildKeyIndex(corpusStores.generiques, 'id_groupe')
  };
}

function clearLoadedData() {
  for (const key of Object.keys(searchIndexes)) {
    searchIndexes[key] = null;
  }
  for (const type of Object.keys(corpusStores)) {
    clearStore(corpusStores[type]);
  }
  cisIndexes = null;
}

async function loadData() {
  const mainFilePath = path.join(DATA_DIR, 'CIS_bdpm.txt');
  try {
    const stats = fs.statSync(mainFilePath);
    metadata.last_updated = stats.mtime.toISOString();
  } catch {
    metadata.last_updated = new Date().toISOString();
  }

  console.log('Chargement des données...');
  clearLoadedData();
  loadMemoryMark('bdpm_start');

  await loadParseAndIndex(
    'specialites',
    'CIS_bdpm.txt',
    ['cis', 'denomination', 'forme_pharma', 'titulaire'],
    { denomination: 3, cis: 2, forme_pharma: 0.5, titulaire: 1 }
  );

  await loadParseAndIndex(
    'presentations',
    'CIS_CIP_bdpm.txt',
    ['cis', 'cip7', 'cip13', 'libelle', 'indications'],
    { libelle: 3, indications: 2, cis: 2, cip7: 1.5, cip13: 1.5 }
  );

  await loadParseAndIndex(
    'compositions',
    'CIS_COMPO_bdpm.txt',
    ['cis', 'denomination_substance', 'dosage'],
    { denomination_substance: 3, cis: 2, dosage: 1 }
  );

  if (LOAD_HAS_AVIS) {
    await loadParseAndIndex('avis_smr', 'CIS_HAS_SMR_bdpm.txt', ['libelle_smr', 'valeur_smr']);
    await loadParseAndIndex('avis_asmr', 'CIS_HAS_ASMR_bdpm.txt', ['libelle_asmr', 'valeur_asmr']);
  } else {
    clearStore(corpusStores.avis_smr);
    clearStore(corpusStores.avis_asmr);
    searchIndexes.avis_smr = null;
    searchIndexes.avis_asmr = null;
  }

  await loadParseAndIndex('generiques', 'CIS_GENER_bdpm.txt', ['libelle_groupe']);
  await loadParseAndIndex('conditions', 'CIS_CPD_bdpm.txt', ['condition']);
  await loadParseAndIndex('ruptures', 'CIS_CIP_Dispo_Spec.txt', ['libelle_statut']);
  await loadParseAndIndex(
    'mitm',
    'CIS_MITM.txt',
    ['cis', 'code_atc', 'denomination'],
    { denomination: 3, code_atc: 2, cis: 2 }
  );

  const compStore = corpusStores.compositions;
  const codeSubIdx = keyIndex(compStore, 'code_substance');
  const denomSubIdx = keyIndex(compStore, 'denomination_substance');
  const substancesMap = new Map();
  for (let i = 0; i < compStore.rows.length; i++) {
    const code = getRowValue(compStore, i, codeSubIdx);
    const denomination = getRowValue(compStore, i, denomSubIdx);
    if (!code || !denomination) continue;
    if (!substancesMap.has(code)) {
      substancesMap.set(code, { code, denomination, medicaments_count: 0 });
    }
    substancesMap.get(code).medicaments_count++;
  }
  const subStore = corpusStores.substances;
  clearStore(subStore);
  for (const record of substancesMap.values()) {
    pushFromRecord(subStore, record);
  }
  await indexInMemoryStore('substances', ['denomination']);

  buildCisIndexes();
  loadMemoryMark('bdpm_done', { specialites: rowCount(corpusStores.specialites) });
  console.log(`Données chargées et indexées: ${rowCount(corpusStores.specialites)} spécialités`);
}

function enrichSpecialite(item) {
  if (!item) return item;
  return { ...item, url_bdpm: bdpmExtraitUrl(item.cis) };
}

function enrichSpecialiteRow(obj) {
  return enrichSpecialite(obj);
}

function getSpecialiteByCis(cis) {
  if (!cisIndexes) return undefined;
  const rowIndex = cisIndexes.specialitesByCis.get(cis);
  if (rowIndex === undefined) return undefined;
  return enrichSpecialite(toObject(corpusStores.specialites, rowIndex));
}

function getRelatedByCis(type, cis, limit = HYDRATE_RELATED_LIMIT) {
  if (!cisIndexes || !cis) return [];
  const mapKey = RELATED_BY_CIS_MAPS[type];
  if (!mapKey) return [];
  const store = corpusStores[type];
  const indices = cisIndexes[mapKey].get(cis) || [];
  const slice = limit > 0 ? indices.slice(0, limit) : indices;
  return toObjects(store, slice);
}

function getGeneriquesForCis(cis) {
  if (!cisIndexes || !cis) return null;
  const indices = cisIndexes.generiquesByCis.get(cis);
  if (!indices || indices.length === 0) return null;

  const genStore = corpusStores.generiques;
  const first = toObject(genStore, indices[0]);
  const id_groupe = first.id_groupe;
  const groupeIndices = cisIndexes.generiquesByGroupe.get(id_groupe) || [];
  return {
    id_groupe,
    libelle_groupe: first.libelle_groupe,
    items: toObjects(genStore, groupeIndices)
  };
}

function search(type, query) {
  const store = corpusStores[type];
  if (!store || !query) return [];
  if (!searchIndexes[type]) return [];

  const results = searchIndexes[type].search(query);
  const mapRow =
    type === 'specialites'
      ? (obj, _i, match_quality) => Object.assign(enrichSpecialite(obj), { match_quality })
      : null;

  return rankAndMaterializeSearch(
    store,
    results,
    query,
    { primaryIdx: primaryFieldIdx[type], idIdx: cisFieldIdx[type] },
    mapRow
  );
}

function parseListPaging(page, limit) {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(MAX_LIST_LIMIT, Math.max(1, parseInt(limit, 10) || 100));
  const offset = (safePage - 1) * safeLimit;
  return { safePage, safeLimit, offset };
}

/** Liste paginée sans matérialiser tout le corpus (sans requête de recherche). */
function listCorpusPage(type, page = 1, limit = 100) {
  const store = corpusStores[type];
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
  const mapRow = type === 'specialites' ? enrichSpecialiteRow : null;
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

function getMetadata() {
  return metadata;
}

function isHasAvisLoaded() {
  return LOAD_HAS_AVIS;
}

/** Stats corpus (scripts d’analyse uniquement). */
function getBdpmCorpusStats() {
  const byType = {};
  for (const type of Object.keys(corpusStores)) {
    byType[type] = { rows: rowCount(corpusStores[type]), keys: corpusStores[type].keys };
  }
  return { byType, stores: corpusStores };
}

module.exports = {
  loadData,
  listCorpusPage,
  search,
  getMetadata,
  isHasAvisLoaded,
  getSpecialiteByCis,
  getRelatedByCis,
  getGeneriquesForCis,
  bdpmExtraitUrl,
  HYDRATE_RELATED_LIMIT,
  DETAIL_HYDRATE_RELATED_LIMIT,
  getBdpmCorpusStats
};
