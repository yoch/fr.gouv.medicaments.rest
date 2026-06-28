const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const {
  buildFrozenIndexFromAsyncIterable,
  buildFrozenIndexFromRows,
  exportFrozenIndexes
} = require('../utils/frozenMiniSearch');
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
const { exportCorpusDocuments } = require('../utils/exportCorpusDocuments');

const DATA_DIR = path.join(__dirname, '../../data');

const BDPM_INDEX_SPECS = {
  specialites: {
    file: 'CIS_bdpm.txt',
    fields: ['cis', 'denomination', 'forme_pharma', 'titulaire'],
    boost: { denomination: 3, cis: 2, forme_pharma: 0.5, titulaire: 1 }
  },
  presentations: {
    file: 'CIS_CIP_bdpm.txt',
    fields: ['cis', 'cip7', 'cip13', 'libelle', 'indications'],
    boost: { libelle: 3, indications: 2, cis: 2, cip7: 1.5, cip13: 1.5 }
  },
  compositions: {
    file: 'CIS_COMPO_bdpm.txt',
    fields: ['cis', 'denomination_substance', 'dosage'],
    boost: { denomination_substance: 3, cis: 2, dosage: 1 }
  },
  avis_smr: {
    file: 'CIS_HAS_SMR_bdpm.txt',
    fields: ['libelle_smr', 'valeur_smr']
  },
  avis_asmr: {
    file: 'CIS_HAS_ASMR_bdpm.txt',
    fields: ['libelle_asmr', 'valeur_asmr']
  },
  generiques: {
    file: 'CIS_GENER_bdpm.txt',
    fields: ['libelle_groupe']
  },
  conditions: {
    file: 'CIS_CPD_bdpm.txt',
    fields: ['condition']
  },
  ruptures: {
    file: 'CIS_CIP_Dispo_Spec.txt',
    fields: ['libelle_statut']
  },
  mitm: {
    file: 'CIS_MITM.txt',
    fields: ['cis', 'code_atc', 'denomination'],
    boost: { denomination: 3, code_atc: 2, cis: 2 }
  },
  substances: {
    fields: ['denomination']
  }
};

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

  const { file: specFile, fields: specFields, boost: specBoost } = BDPM_INDEX_SPECS.specialites;
  await loadParseAndIndex('specialites', specFile, specFields, specBoost);
  loadMemoryMark('bdpm_after_specialites', { rows: rowCount(corpus.specialites) });

  const pres = BDPM_INDEX_SPECS.presentations;
  await loadParseAndIndex('presentations', pres.file, pres.fields, pres.boost);
  loadMemoryMark('bdpm_after_presentations', { rows: rowCount(corpus.presentations) });

  const comp = BDPM_INDEX_SPECS.compositions;
  await loadParseAndIndex('compositions', comp.file, comp.fields, comp.boost);
  loadMemoryMark('bdpm_after_compositions', { rows: rowCount(corpus.compositions) });

  if (LOAD_HAS_AVIS) {
    const smr = BDPM_INDEX_SPECS.avis_smr;
    await loadParseAndIndex('avis_smr', smr.file, smr.fields);
    loadMemoryMark('bdpm_after_avis_smr', { rows: rowCount(corpus.avis_smr) });
    const asmr = BDPM_INDEX_SPECS.avis_asmr;
    await loadParseAndIndex('avis_asmr', asmr.file, asmr.fields);
    loadMemoryMark('bdpm_after_avis_asmr', { rows: rowCount(corpus.avis_asmr) });
  } else {
    clearCorpus(corpus.avis_smr);
    clearCorpus(corpus.avis_asmr);
    searchIndexes.avis_smr = null;
    searchIndexes.avis_asmr = null;
  }

  const generiques = BDPM_INDEX_SPECS.generiques;
  await loadParseAndIndex('generiques', generiques.file, generiques.fields);
  loadMemoryMark('bdpm_after_generiques', { rows: rowCount(corpus.generiques) });
  const conditions = BDPM_INDEX_SPECS.conditions;
  await loadParseAndIndex('conditions', conditions.file, conditions.fields);
  loadMemoryMark('bdpm_after_conditions', { rows: rowCount(corpus.conditions) });
  const ruptures = BDPM_INDEX_SPECS.ruptures;
  await loadParseAndIndex('ruptures', ruptures.file, ruptures.fields);
  loadMemoryMark('bdpm_after_ruptures', { rows: rowCount(corpus.ruptures) });
  if (LOAD_MITM) {
    const mitm = BDPM_INDEX_SPECS.mitm;
    await loadParseAndIndex('mitm', mitm.file, mitm.fields, mitm.boost);
    loadMemoryMark('bdpm_after_mitm', { rows: rowCount(corpus.mitm) });
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
  await indexInMemoryCorpus(
    'substances',
    BDPM_INDEX_SPECS.substances.fields,
    BDPM_INDEX_SPECS.substances.boost
  );
  loadMemoryMark('bdpm_after_substances', { rows: rowCount(corpus.substances) });

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

function getBdpmSearchIndexes() {
  const out = {};
  for (const type of Object.keys(searchIndexes)) {
    out[type] = searchIndexes[type];
  }
  return out;
}

function exportBdpmSearchIndexes(outDir) {
  return exportFrozenIndexes(searchIndexes, outDir, 'bdpm', {
    last_updated: metadata.last_updated,
    source: metadata.source,
    load_has_avis: LOAD_HAS_AVIS,
    load_mitm: LOAD_MITM
  });
}

function exportBdpmCorpusDocuments(outDir) {
  const datasets = [];

  for (const [type, spec] of Object.entries(BDPM_INDEX_SPECS)) {
    const rows = corpus[type];
    if (!rows || rowCount(rows) === 0) continue;
    if (!searchIndexes[type]) continue;

    const { fields, boost } = spec;
    datasets.push({
      type,
      rows,
      toDocument: (item, rowIndex) => buildIndexDocument(item, rowIndex, fields),
      indexOptions: miniSearchIndexConfig(fields, boost)
    });
  }

  return exportCorpusDocuments(datasets, outDir, 'bdpm', {
    last_updated: metadata.last_updated,
    source: metadata.source,
    load_has_avis: LOAD_HAS_AVIS,
    load_mitm: LOAD_MITM
  });
}

module.exports = {
  loadData,
  exportBdpmSearchIndexes,
  exportBdpmCorpusDocuments,
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
  getBdpmCorpusStats,
  getBdpmSearchIndexes
};
