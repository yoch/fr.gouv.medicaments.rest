const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const MiniSearch = require('minisearch');
const {
  normalizeSearchText,
  isDatabaseUsable,
  loadDataFromDatabase,
  loadDataFromDatabaseLean,
  queryFts,
  getPersistentDb,
  closePersistentDb,
  getTableRowsByIndices,
  getRowsByCis,
  getSpecialiteRowByCis,
  getDefaultDbPath
} = require('./bdpmDatabase');

const DATA_DIR = path.join(__dirname, '../../data');
const DB_PATH = getDefaultDbPath();
const BDPM_MEDICAMENT_BASE_URL = 'https://base-donnees-publique.medicaments.gouv.fr/medicament';

const FTS_SUPPORTED_TYPES = new Set(['specialites', 'presentations', 'compositions']);

const INDEX_BOOSTS = {
  specialites: { denomination: 3, cis: 2, forme_pharma: 0.5, titulaire: 1 },
  presentations: { libelle: 3, indications: 2, cis: 2, cip7: 1.5, cip13: 1.5 },
  compositions: { denomination_substance: 3, cis: 2, dosage: 1 },
  mitm: { denomination: 3, code_atc: 2, cis: 2 }
};

const MINI_INDEX_SPECS = {
  specialites: {
    fields: ['cis', 'denomination', 'forme_pharma', 'titulaire'],
    boost: INDEX_BOOSTS.specialites
  },
  presentations: {
    fields: ['cis', 'cip7', 'cip13', 'libelle', 'indications'],
    boost: INDEX_BOOSTS.presentations
  },
  compositions: {
    fields: ['cis', 'denomination_substance', 'dosage'],
    boost: INDEX_BOOSTS.compositions
  },
  avis_smr: { fields: ['libelle_smr', 'valeur_smr'], boost: null },
  avis_asmr: { fields: ['libelle_asmr', 'valeur_asmr'], boost: null },
  generiques: { fields: ['libelle_groupe'], boost: null },
  conditions: { fields: ['condition'], boost: null },
  ruptures: { fields: ['libelle_statut'], boost: null },
  mitm: { fields: ['cis', 'code_atc', 'denomination'], boost: INDEX_BOOSTS.mitm },
  substances: { fields: ['denomination'], boost: null }
};

function bdpmExtraitUrl(cis) {
  return `${BDPM_MEDICAMENT_BASE_URL}/${cis}/extrait`;
}

let dataCache = {
  specialites: [],
  presentations: [],
  compositions: [],
  avis_smr: [],
  avis_asmr: [],
  generiques: [],
  conditions: [],
  ruptures: [],
  substances: [],
  mitm: [],
  metadata: {
    last_updated: null,
    source: 'base de données publique des médicaments - gouv.fr'
  }
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
let dbValidated = false;

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

const MATCH_QUALITY = ['fuzzy', 'prefix', 'exact'];

const miniSearchOptions = {
  processTerm: (term) => normalizeSearchText(term),
  searchOptions: {
    processTerm: (term) => normalizeSearchText(term),
    prefix: true,
    fuzzy: (term) => (/^\d+$/.test(term) ? false : 0.2)
  }
};

const FTS_CONFIG = {
  specialites: {
    table: 'specialites_fts',
    numericFields: ['cis'],
    primaryField: 'denomination',
    scoreSql: 'bm25(specialites_fts, 2.0, 3.0, 0.5, 1.0, 0.0)'
  },
  presentations: {
    table: 'presentations_fts',
    numericFields: ['cis', 'cip7', 'cip13'],
    primaryField: 'libelle',
    scoreSql: 'bm25(presentations_fts, 2.0, 1.5, 1.5, 3.0, 2.0, 0.0)'
  },
  compositions: {
    table: 'compositions_fts',
    numericFields: ['cis'],
    primaryField: 'denomination_substance',
    scoreSql: 'bm25(compositions_fts, 2.0, 3.0, 1.0, 0.0)'
  }
};

function parseFile(filename, columns) {
  const filepath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filepath)) {
    console.warn(`Fichier ${filename} non trouvé`);
    return [];
  }
  const content = fs.readFileSync(filepath, { encoding: 'utf8' });
  try {
    return parse(content, {
      delimiter: '\t',
      columns,
      skip_empty_lines: true,
      trim: true,
      quote: false,
      escape: false,
      relax_quotes: true,
      relax_column_count: true
    });
  } catch (error) {
    console.error(`Erreur parsing ${filename}:`, error.message);
    const lines = content.split('\n');
    const records = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const values = line.split('\t');
      const record = {};
      for (let i = 0; i < columns.length; i++) {
        record[columns[i]] = values[i] || '';
      }
      records.push(record);
    }
    return records;
  }
}

function createIndex(type, fields, boost = null) {
  const indexConfig = {
    fields,
    storeFields: ['id'],
    ...miniSearchOptions
  };
  if (boost) indexConfig.boost = boost;
  const index = new MiniSearch(indexConfig);
  const indexDocuments = dataCache[type].map((item, rowIndex) => {
    const doc = { id: rowIndex };
    for (const field of fields) {
      const value = item[field];
      if (value != null && value !== '') {
        doc[field] = value;
      }
    }
    return doc;
  });
  index.addAll(indexDocuments);
  searchIndexes[type] = index;
}

function appendToCisList(map, cis, item) {
  if (!cis) return;
  if (!map.has(cis)) map.set(cis, []);
  map.get(cis).push(item);
}

function buildCisIndexes() {
  const specialitesByCis = new Map();
  for (const item of dataCache.specialites) {
    if (item.cis) specialitesByCis.set(item.cis, item);
  }

  const presentationsByCis = new Map();
  for (const item of dataCache.presentations) appendToCisList(presentationsByCis, item.cis, item);

  const compositionsByCis = new Map();
  for (const item of dataCache.compositions) appendToCisList(compositionsByCis, item.cis, item);

  const avisSmrByCis = new Map();
  for (const item of dataCache.avis_smr) appendToCisList(avisSmrByCis, item.cis, item);

  const avisAsmrByCis = new Map();
  for (const item of dataCache.avis_asmr) appendToCisList(avisAsmrByCis, item.cis, item);

  const conditionsByCis = new Map();
  for (const item of dataCache.conditions) appendToCisList(conditionsByCis, item.cis, item);

  const generiquesByCis = new Map();
  const generiquesByGroupe = new Map();
  for (const item of dataCache.generiques) {
    appendToCisList(generiquesByCis, item.cis, item);
    appendToCisList(generiquesByGroupe, item.id_groupe, item);
  }

  cisIndexes = {
    specialitesByCis,
    presentationsByCis,
    compositionsByCis,
    avisSmrByCis,
    avisAsmrByCis,
    conditionsByCis,
    generiquesByCis,
    generiquesByGroupe
  };
}

function getLoadProfile() {
  const raw = String(process.env.DATA_LOAD_PROFILE || 'full').toLowerCase().trim();
  return raw === 'sqlite_lean' ? 'sqlite_lean' : 'full';
}

function shouldBuildMiniIndex(type) {
  if (getLoadProfile() !== 'sqlite_lean') return true;
  return !FTS_SUPPORTED_TYPES.has(type);
}

function getRowByIndex(type, rowIndex) {
  const cached = dataCache[type]?.[rowIndex];
  if (cached) return cached;
  if (getLoadProfile() === 'sqlite_lean' && FTS_SUPPORTED_TYPES.has(type)) {
    const rows = getTableRowsByIndices(type, [rowIndex], DB_PATH);
    return rows[0];
  }
  return undefined;
}

function clearLoadedData() {
  closePersistentDb();
  dbValidated = false;
  for (const key of Object.keys(searchIndexes)) {
    searchIndexes[key] = null;
  }
  for (const key of Object.keys(dataCache)) {
    if (key === 'metadata') continue;
    dataCache[key] = [];
  }
  cisIndexes = null;
}

function loadFromTsv() {
  dataCache.specialites = parseFile('CIS_bdpm.txt', [
    'cis', 'denomination', 'forme_pharma', 'voies_admin', 'statut_amm',
    'type_amm', 'commercialisation', 'date_amm', 'statut_bdm',
    'num_autorisation_euro', 'titulaire', 'surveillance_renforcee'
  ]);
  dataCache.presentations = parseFile('CIS_CIP_bdpm.txt', [
    'cis', 'cip7', 'libelle', 'statut_admin', 'etat_commercialisation',
    'date_declaration', 'cip13', 'agrement_collectivite', 'taux_remboursement',
    'prix_medicament', 'prix_public', 'honoraires', 'indications'
  ]);
  dataCache.compositions = parseFile('CIS_COMPO_bdpm.txt', [
    'cis', 'designation_element', 'code_substance', 'denomination_substance',
    'dosage', 'reference_dosage', 'nature_composant', 'numero_ordre'
  ]);
  dataCache.avis_smr = parseFile('CIS_HAS_SMR_bdpm.txt', [
    'cis', 'has_dossier', 'motif_evaluation', 'date_avis', 'valeur_smr', 'libelle_smr'
  ]);
  dataCache.avis_asmr = parseFile('CIS_HAS_ASMR_bdpm.txt', [
    'cis', 'has_dossier', 'motif_evaluation', 'date_avis', 'valeur_asmr', 'libelle_asmr'
  ]);
  dataCache.generiques = parseFile('CIS_GENER_bdpm.txt', [
    'id_groupe', 'libelle_groupe', 'cis', 'type_generique', 'numero_ordre'
  ]);
  dataCache.conditions = parseFile('CIS_CPD_bdpm.txt', ['cis', 'condition']);
  dataCache.ruptures = parseFile('CIS_CIP_Dispo_Spec.txt', [
    'cis', 'cip13', 'code_statut', 'libelle_statut', 'date_debut',
    'date_mise_a_jour', 'date_remise_dispo', 'lien_ansm'
  ]);
  dataCache.mitm = parseFile('CIS_MITM.txt', ['cis', 'code_atc', 'denomination', 'lien_fi']);

  const substancesMap = new Map();
  for (const comp of dataCache.compositions) {
    if (comp.code_substance && comp.denomination_substance) {
      if (!substancesMap.has(comp.code_substance)) {
        substancesMap.set(comp.code_substance, {
          code: comp.code_substance,
          denomination: comp.denomination_substance,
          medicaments_count: 0
        });
      }
      substancesMap.get(comp.code_substance).medicaments_count++;
    }
  }
  dataCache.substances = Array.from(substancesMap.values());
}

function addComputedFields() {
  dataCache.specialites = dataCache.specialites.map((item) => ({
    ...item,
    url_bdpm: bdpmExtraitUrl(item.cis)
  }));
}

async function loadData() {
  clearLoadedData();
  console.log('Chargement BDPM...');

  const mainFilePath = path.join(DATA_DIR, 'CIS_bdpm.txt');
  let fallbackLastUpdated = new Date().toISOString();
  try {
    fallbackLastUpdated = fs.statSync(mainFilePath).mtime.toISOString();
  } catch (error) {
    // noop
  }

  const profile = getLoadProfile();
  const useSqliteSource = isDatabaseUsable(DB_PATH);

  if (useSqliteSource) {
    try {
      const loaded = profile === 'sqlite_lean'
        ? loadDataFromDatabaseLean(DB_PATH)
        : loadDataFromDatabase(DB_PATH);
      Object.assign(dataCache, loaded.data);
      dataCache.metadata = loaded.metadata;
      getPersistentDb(DB_PATH);
      dbValidated = true;
      console.log(`✓ Données BDPM chargées depuis SQLite (${DB_PATH}, profil=${profile})`);
    } catch (error) {
      console.warn(`⚠ Échec lecture SQLite, fallback TSV: ${error.message}`);
      loadFromTsv();
      dataCache.metadata.last_updated = fallbackLastUpdated;
    }
  } else {
    loadFromTsv();
    dataCache.metadata.last_updated = fallbackLastUpdated;
    console.warn('⚠ Base SQLite indisponible, chargement TSV en fallback');
  }

  addComputedFields();
  if (!dataCache.metadata.source) {
    dataCache.metadata.source = 'base de données publique des médicaments - gouv.fr';
  }

  for (const [type, spec] of Object.entries(MINI_INDEX_SPECS)) {
    if (shouldBuildMiniIndex(type)) {
      createIndex(type, spec.fields, spec.boost);
    } else {
      searchIndexes[type] = null;
    }
  }

  buildCisIndexes();
  console.log(`✓ BDPM prêt: ${dataCache.specialites.length} spécialités (profil=${profile})`);
}

function getSearchBackend() {
  const raw = String(process.env.SEARCH_BACKEND || 'minisearch').toLowerCase().trim();
  if (raw === 'sqlite_fts' || raw === 'compare') return raw;
  return 'minisearch';
}

function fieldBoostScore(type, item, normalizedQuery) {
  const boosts = INDEX_BOOSTS[type];
  if (!boosts) return 0;
  let score = 0;

  for (const [field, weight] of Object.entries(boosts)) {
    const value = normalizeSearchText(item[field] || '');
    if (!value) continue;
    if (value === normalizedQuery) { score += weight * 4; continue; }
    if (value.startsWith(normalizedQuery)) { score += weight * 2; continue; }
    if (value.includes(normalizedQuery)) { score += weight; continue; }
    for (const token of value.split(/[^a-z0-9]+/).filter(Boolean)) {
      if (token.startsWith(normalizedQuery)) { score += weight * 1.5; break; }
    }
  }
  return score;
}

function rankCandidates(type, query, candidates) {
  const normalizedQuery = normalizeSearchText(query);
  const primaryField = PRIMARY_FIELDS[type];
  const rankedResults = [];
  for (const candidate of candidates) {
    const item = candidate.item;
    if (!item) continue;
    const value = item[primaryField] ? normalizeSearchText(item[primaryField]) : '';
    const normalizedCis = item.cis ? normalizeSearchText(item.cis) : '';
    let priority = 0;
    if (value === normalizedQuery || normalizedCis === normalizedQuery) priority = 2;
    else if (value.startsWith(normalizedQuery) || normalizedCis.startsWith(normalizedQuery)) priority = 1;

    rankedResults.push({
      item,
      score: candidate.score ?? 0,
      boost: fieldBoostScore(type, item, normalizedQuery),
      priority,
      match_quality: MATCH_QUALITY[priority]
    });
  }

  rankedResults.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (b.score !== a.score) return b.score - a.score;
    if (b.boost !== a.boost) return b.boost - a.boost;
    const lenA = (a.item[primaryField] || '').length;
    const lenB = (b.item[primaryField] || '').length;
    return lenA - lenB;
  });

  return rankedResults.map((r) => ({
    ...r.item,
    match_quality: r.match_quality
  }));
}

function miniSearchResults(type, query) {
  if (!searchIndexes[type]) return [];
  const results = searchIndexes[type].search(query);
  return rankCandidates(
    type,
    query,
    results.map((res) => ({
      item: getRowByIndex(type, res.id),
      score: res.score
    })).filter((c) => c.item)
  );
}

function escapeFtsToken(token) {
  return token.replace(/"/g, '""');
}

function numericCandidates(type, normalizedQuery) {
  const fields = FTS_CONFIG[type]?.numericFields || [];
  if (!dataCache[type]?.length) return [];
  const candidates = [];
  for (let i = 0; i < dataCache[type].length; i++) {
    const row = dataCache[type][i];
    let matched = false;
    for (const field of fields) {
      const value = normalizeSearchText(row[field] || '');
      if (!value) continue;
      if (value === normalizedQuery) {
        candidates.push({ rowIndex: i, score: 1_000_000 });
        matched = true;
        break;
      }
      if (value.startsWith(normalizedQuery)) {
        candidates.push({ rowIndex: i, score: 100_000 });
        matched = true;
        break;
      }
    }
    if (matched) continue;
  }
  return candidates;
}

function levenshteinWithinLimit(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return null;
  if (a === b) return 0;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost
      );
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > limit) return null;
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }

  return prev[b.length] <= limit ? prev[b.length] : null;
}

function prefixCandidatesOnBoostedFields(type, normalizedQuery) {
  const boosts = INDEX_BOOSTS[type];
  if (!boosts) return [];
  const rows = dataCache[type];
  if (!rows || rows.length === 0) return [];

  const candidates = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let best = 0;
    for (const field of Object.keys(boosts)) {
      const value = normalizeSearchText(row[field] || '');
      if (!value) continue;
      if (value.startsWith(normalizedQuery)) best = Math.max(best, 80_000);
      else {
        for (const token of value.split(/[^a-z0-9]+/).filter(Boolean)) {
          if (token.startsWith(normalizedQuery)) best = Math.max(best, 60_000);
        }
      }
    }
    if (best > 0) candidates.push({ rowIndex: i, score: best });
  }
  return candidates;
}

function fuzzyCandidatesLimited(type, normalizedQuery, seedRowIndexes) {
  const maxDistance = Math.ceil(normalizedQuery.length * 0.2);
  if (maxDistance <= 0 || seedRowIndexes.size === 0) return [];

  const primaryField = FTS_CONFIG[type]?.primaryField;
  if (!primaryField) return [];

  const candidates = [];
  for (const rowIndex of seedRowIndexes) {
    const row = getRowByIndex(type, rowIndex);
    if (!row) continue;
    const primaryValue = normalizeSearchText(row[primaryField] || '');
    if (!primaryValue) continue;

    const tokens = primaryValue.split(/[^a-z0-9]+/).filter(Boolean);
    let distance = levenshteinWithinLimit(normalizedQuery, primaryValue, maxDistance);
    for (const token of tokens) {
      const d = levenshteinWithinLimit(normalizedQuery, token, maxDistance);
      if (d != null && (distance == null || d < distance)) distance = d;
    }
    if (distance == null) continue;
    candidates.push({ rowIndex, score: 10_000 - distance });
  }
  return candidates;
}

function mergeScore(scoreMap, rowIndex, score) {
  const prev = scoreMap.get(rowIndex);
  if (prev == null || score > prev) scoreMap.set(rowIndex, score);
}

function runFtsQuery(config, matchQuery) {
  if (!matchQuery) return [];
  try {
    return queryFts(
      DB_PATH,
      `SELECT row_index, ${config.scoreSql} AS bm25_score
       FROM ${config.table}
       WHERE ${config.table} MATCH ?
       ORDER BY bm25_score ASC
       LIMIT 400`,
      [matchQuery]
    );
  } catch (error) {
    console.warn(`Erreur FTS (${config.table}): ${error.message}`);
    return [];
  }
}

function sqliteFtsResults(type, query) {
  if (!FTS_SUPPORTED_TYPES.has(type) || !dbValidated) return null;
  const config = FTS_CONFIG[type];
  const normalizedQuery = normalizeSearchText(query).trim();
  if (!normalizedQuery) return [];

  const scoreByRowIndex = new Map();
  const terms = normalizedQuery.split(/\s+/).filter(Boolean).map(escapeFtsToken);
  const matchQuery = terms.map((term) => `${term}*`).join(' ');

  for (const row of runFtsQuery(config, matchQuery)) {
    mergeScore(scoreByRowIndex, row.row_index, -row.bm25_score);
  }

  if (scoreByRowIndex.size < 5 && normalizedQuery.length >= 3) {
    const seed = normalizedQuery.slice(0, Math.min(4, normalizedQuery.length));
    const fallbackQuery = `${escapeFtsToken(seed)}*`;
    for (const row of runFtsQuery(config, fallbackQuery)) {
      mergeScore(scoreByRowIndex, row.row_index, -row.bm25_score * 0.8);
    }
  }

  if (searchIndexes[type]) {
    const miniRaw = searchIndexes[type].search(query);
    for (const res of miniRaw) {
      mergeScore(scoreByRowIndex, res.id, res.score);
    }
  }

  if (/^\d+$/.test(normalizedQuery)) {
    for (const candidate of numericCandidates(type, normalizedQuery)) {
      mergeScore(scoreByRowIndex, candidate.rowIndex, candidate.score);
    }
  } else {
    for (const candidate of prefixCandidatesOnBoostedFields(type, normalizedQuery)) {
      mergeScore(scoreByRowIndex, candidate.rowIndex, candidate.score);
    }
    for (const candidate of fuzzyCandidatesLimited(type, normalizedQuery, new Set(scoreByRowIndex.keys()))) {
      mergeScore(scoreByRowIndex, candidate.rowIndex, candidate.score);
    }
  }

  const candidates = [];
  for (const [rowIndex, score] of scoreByRowIndex.entries()) {
    const item = getRowByIndex(type, rowIndex);
    if (item) candidates.push({ item, score });
  }
  return rankCandidates(type, query, candidates);
}

function compareSearchResults(type, query, miniResults, sqliteResults) {
  const topN = 5;
  const miniIds = miniResults.slice(0, topN).map((item) => item.cis || item.cip13 || item.id_groupe || JSON.stringify(item));
  const sqliteIds = sqliteResults.slice(0, topN).map((item) => item.cis || item.cip13 || item.id_groupe || JSON.stringify(item));
  if (miniIds.join('|') !== sqliteIds.join('|')) {
    console.log(`[SEARCH_COMPARE] type=${type} q="${query}" mini=${miniIds.join(',')} sqlite=${sqliteIds.join(',')}`);
  }
}

function search(type, query) {
  if (!query) return dataCache[type] || [];
  if (!dataCache[type] && !dbValidated) return [];

  const backend = getSearchBackend();

  if (backend === 'minisearch') {
    return miniSearchResults(type, query);
  }

  if (backend === 'sqlite_fts') {
    const sqliteResults = sqliteFtsResults(type, query);
    return sqliteResults ?? miniSearchResults(type, query);
  }

  const miniResults = miniSearchResults(type, query);
  const sqliteResults = sqliteFtsResults(type, query);
  if (sqliteResults) {
    compareSearchResults(type, query, miniResults, sqliteResults);
  }
  return miniResults;
}

function getSpecialiteByCis(cis) {
  if (cisIndexes) {
    const cached = cisIndexes.specialitesByCis.get(cis);
    if (cached) return cached;
  }
  if (dbValidated && getLoadProfile() === 'sqlite_lean') {
    const row = getSpecialiteRowByCis(cis, DB_PATH);
    if (row) return { ...row, url_bdpm: bdpmExtraitUrl(row.cis) };
  }
  return undefined;
}

function getRelatedByCis(type, cis) {
  if (!cis) return [];
  if (getLoadProfile() === 'sqlite_lean' && FTS_SUPPORTED_TYPES.has(type) && dbValidated) {
    return getRowsByCis(type, cis, DB_PATH);
  }
  if (!cisIndexes) return [];
  const mapKey = RELATED_BY_CIS_MAPS[type];
  if (!mapKey) return [];
  return cisIndexes[mapKey].get(cis) || [];
}

function getGeneriquesForCis(cis) {
  if (!cisIndexes || !cis) return null;
  const drugGeneriques = cisIndexes.generiquesByCis.get(cis);
  if (!drugGeneriques || drugGeneriques.length === 0) return null;
  const id_groupe = drugGeneriques[0].id_groupe;
  const items = cisIndexes.generiquesByGroupe.get(id_groupe) || [];
  return {
    id_groupe,
    libelle_groupe: drugGeneriques[0].libelle_groupe,
    items
  };
}

function getData(type) {
  return dataCache[type] || [];
}

function getMetadata() {
  return dataCache.metadata;
}

module.exports = {
  loadData,
  getData,
  search,
  getMetadata,
  getSpecialiteByCis,
  getRelatedByCis,
  getGeneriquesForCis,
  bdpmExtraitUrl,
  getLoadProfile,
  getSearchBackend
};
