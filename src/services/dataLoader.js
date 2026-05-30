const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const { buildFrozenIndexFromAsyncIterable, buildFrozenIndexFromRows } = require('../utils/frozenMiniSearch');
const { loadMemoryMark } = require('../utils/memorySampler');
const { parseListPaging } = require('../utils/corpusPaging');
const { miniSearchIndexConfig } = require('../utils/miniSearchIndexConfig');
const { BDPM_SCHEMAS } = require('../utils/corpusSchemas');
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
const { FROM_CSV, bdpmExtraitUrl, Substance } = require('../models/bdpm');

const DATA_DIR = path.join(__dirname, '../../data');

const HYDRATE_RELATED_LIMIT = Math.max(
  1,
  parseInt(process.env.SEARCH_HYDRATE_RELATED_LIMIT || '50', 10)
);

const DETAIL_HYDRATE_RELATED_LIMIT = Math.max(
  0,
  parseInt(process.env.DETAIL_HYDRATE_RELATED_LIMIT || '0', 10)
);

const LOAD_HAS_AVIS = process.env.LOAD_HAS_AVIS !== 'false';
const LOAD_MITM = process.env.LOAD_MITM !== 'false';

const corpus = {
  specialites: createCorpus(),
  presentations: createCorpus(),
  compositions: createCorpus(),
  avis_smr: createCorpus(),
  avis_asmr: createCorpus(),
  generiques: createCorpus(),
  conditions: createCorpus(),
  ruptures: createCorpus(),
  substances: createCorpus(),
  mitm: createCorpus()
};

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

const ID_FIELDS = {
  specialites: 'cis',
  presentations: 'cis',
  compositions: 'cis',
  avis_smr: 'cis',
  avis_asmr: 'cis',
  generiques: 'cis',
  conditions: 'cis',
  ruptures: 'cis',
  mitm: 'cis',
  substances: null
};

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

async function loadParseAndIndex(type, filename, fields, boost = null) {
  const filepath = path.join(DATA_DIR, filename);
  console.log(`Chargement et indexation de ${type}...`);

  const rows = corpus[type];
  clearCorpus(rows);
  const fromCsv = FROM_CSV[type];
  const options = miniSearchIndexConfig(fields, boost);

  if (!fs.existsSync(filepath)) {
    console.warn(`Fichier ${filename} non trouvé`);
    searchIndexes[type] = null;
    return;
  }

  async function* documents() {
    const parser = fs
      .createReadStream(filepath, { encoding: 'utf8' })
      .pipe(parse(csvParserOptions(BDPM_SCHEMAS[type])));

    let rowIndex = 0;
    for await (const record of parser) {
      push(rows, fromCsv(record));
      yield buildIndexDocument(rows[rowIndex], rowIndex, fields);
      rowIndex++;
    }
  }

  searchIndexes[type] = await buildFrozenIndexFromAsyncIterable(documents(), options);
}

async function indexInMemoryCorpus(type, fields, boost = null) {
  console.log(`Indexation de ${type}...`);
  const rows = corpus[type];
  const options = miniSearchIndexConfig(fields, boost);
  searchIndexes[type] = buildFrozenIndexFromRows(
    rows,
    (item, rowIndex) => buildIndexDocument(item, rowIndex, fields),
    options
  );
}

function buildCisIndexes() {
  cisIndexes = {
    specialitesByCis: buildKeyIndex(corpus.specialites, 'cis', { unique: true }),
    presentationsByCis: buildKeyIndex(corpus.presentations, 'cis'),
    compositionsByCis: buildKeyIndex(corpus.compositions, 'cis'),
    avisSmrByCis: buildKeyIndex(corpus.avis_smr, 'cis'),
    avisAsmrByCis: buildKeyIndex(corpus.avis_asmr, 'cis'),
    conditionsByCis: buildKeyIndex(corpus.conditions, 'cis'),
    generiquesByCis: buildKeyIndex(corpus.generiques, 'cis'),
    generiquesByGroupe: buildKeyIndex(corpus.generiques, 'id_groupe')
  };
}

function clearLoadedData() {
  for (const key of Object.keys(searchIndexes)) {
    searchIndexes[key] = null;
  }
  for (const type of Object.keys(corpus)) {
    clearCorpus(corpus[type]);
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
    clearCorpus(corpus.avis_smr);
    clearCorpus(corpus.avis_asmr);
    searchIndexes.avis_smr = null;
    searchIndexes.avis_asmr = null;
  }

  await loadParseAndIndex('generiques', 'CIS_GENER_bdpm.txt', ['libelle_groupe']);
  await loadParseAndIndex('conditions', 'CIS_CPD_bdpm.txt', ['condition']);
  await loadParseAndIndex('ruptures', 'CIS_CIP_Dispo_Spec.txt', ['libelle_statut']);
  if (LOAD_MITM) {
    await loadParseAndIndex(
      'mitm',
      'CIS_MITM.txt',
      ['cis', 'code_atc', 'denomination'],
      { denomination: 3, code_atc: 2, cis: 2 }
    );
  } else {
    clearCorpus(corpus.mitm);
    searchIndexes.mitm = null;
  }

  const substancesMap = new Map();
  for (const comp of corpus.compositions) {
    if (comp.code_substance && comp.denomination_substance) {
      if (!substancesMap.has(comp.code_substance)) {
        substancesMap.set(
          comp.code_substance,
          new Substance(comp.code_substance, comp.denomination_substance, 0)
        );
      }
      substancesMap.get(comp.code_substance).medicaments_count++;
    }
  }
  clearCorpus(corpus.substances);
  for (const sub of substancesMap.values()) {
    push(corpus.substances, sub);
  }
  await indexInMemoryCorpus('substances', ['denomination']);

  buildCisIndexes();
  loadMemoryMark('bdpm_done', { specialites: rowCount(corpus.specialites) });
  console.log(`Données chargées et indexées: ${rowCount(corpus.specialites)} spécialités`);
}

function getSpecialiteByCis(cis) {
  if (!cisIndexes) return undefined;
  const rowIndex = cisIndexes.specialitesByCis.get(cis);
  if (rowIndex === undefined) return undefined;
  return corpus.specialites[rowIndex].toJSON();
}

function getRelatedByCis(type, cis, limit = HYDRATE_RELATED_LIMIT) {
  if (!cisIndexes || !cis) return [];
  const mapKey = RELATED_BY_CIS_MAPS[type];
  if (!mapKey) return [];
  const rows = corpus[type];
  const indices = cisIndexes[mapKey].get(cis) || [];
  const slice = limit > 0 ? indices.slice(0, limit) : indices;
  return materializeIndices(rows, slice);
}

function getGeneriquesForCis(cis) {
  if (!cisIndexes || !cis) return null;
  const indices = cisIndexes.generiquesByCis.get(cis);
  if (!indices || indices.length === 0) return null;

  const first = corpus.generiques[indices[0]].toJSON();
  const id_groupe = first.id_groupe;
  const groupeIndices = cisIndexes.generiquesByGroupe.get(id_groupe) || [];
  return {
    id_groupe,
    libelle_groupe: first.libelle_groupe,
    items: materializeIndices(corpus.generiques, groupeIndices)
  };
}

function search(type, query) {
  const rows = corpus[type];
  if (!rows || !query) return [];
  if (!searchIndexes[type]) return [];

  const results = searchIndexes[type].search(query);
  return rankAndMaterializeSearch(rows, results, query, {
    primaryField: PRIMARY_FIELDS[type],
    idField: ID_FIELDS[type]
  });
}

function listCorpusPage(type, page = 1, limit = 100) {
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

function getMetadata() {
  return metadata;
}

function isHasAvisLoaded() {
  return LOAD_HAS_AVIS;
}

function isMitmLoaded() {
  return LOAD_MITM;
}

function getBdpmCorpusStats() {
  const byType = {};
  for (const type of Object.keys(corpus)) {
    byType[type] = { rows: rowCount(corpus[type]) };
  }
  return { byType, corpus };
}

module.exports = {
  loadData,
  listCorpusPage,
  search,
  getMetadata,
  isHasAvisLoaded,
  isMitmLoaded,
  getSpecialiteByCis,
  getRelatedByCis,
  getGeneriquesForCis,
  bdpmExtraitUrl,
  HYDRATE_RELATED_LIMIT,
  DETAIL_HYDRATE_RELATED_LIMIT,
  getBdpmCorpusStats
};
