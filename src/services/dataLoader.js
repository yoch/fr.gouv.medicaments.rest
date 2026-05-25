const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const { buildFrozenIndexFromRows } = require('../utils/frozenMiniSearch');

const DATA_DIR = path.join(__dirname, '../../data');
const BDPM_MEDICAMENT_BASE_URL = 'https://base-donnees-publique.medicaments.gouv.fr/medicament';

const HYDRATE_RELATED_LIMIT = Math.max(
  1,
  parseInt(process.env.SEARCH_HYDRATE_RELATED_LIMIT || '50', 10)
);

/** Fiche détail : 0 = pas de troncature (SEARCH_HYDRATE_RELATED_LIMIT reste pour /search). */
const DETAIL_HYDRATE_RELATED_LIMIT = Math.max(
  0,
  parseInt(process.env.DETAIL_HYDRATE_RELATED_LIMIT || '0', 10)
);

const LOAD_HAS_AVIS = process.env.LOAD_HAS_AVIS !== 'false';

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

const RELATED_BY_CIS_MAPS = {
  presentations: 'presentationsByCis',
  compositions: 'compositionsByCis',
  avis_smr: 'avisSmrByCis',
  avis_asmr: 'avisAsmrByCis',
  conditions: 'conditionsByCis'
};

const miniSearchOptions = {
  processTerm: (term) => normalizeSearchText(term),
  searchOptions: {
    processTerm: (term) => normalizeSearchText(term),
    prefix: true,
    fuzzy: (term) => (/^\d+$/.test(term) ? false : 0.2)
  }
};

function normalizeSearchText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function parseFileStreaming(filename, columns) {
  const filepath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filepath)) {
    console.warn(`Fichier ${filename} non trouvé`);
    return Promise.resolve([]);
  }

  return new Promise((resolve, reject) => {
    const records = [];
    const parser = parse({
      delimiter: '\t',
      columns,
      skip_empty_lines: true,
      trim: true,
      quote: false,
      escape: false,
      relax_quotes: true,
      relax_column_count: true
    });

    parser.on('readable', () => {
      let record;
      while ((record = parser.read()) !== null) {
        records.push(record);
      }
    });
    parser.on('error', reject);
    parser.on('end', () => resolve(records));

    fs.createReadStream(filepath, { encoding: 'utf8' }).pipe(parser);
  });
}

function buildIndexDocument(item, rowIndex, fields) {
  const doc = { id: rowIndex };
  for (const field of fields) {
    const value = item[field];
    if (value != null && value !== '') {
      doc[field] = value;
    }
  }
  return doc;
}

function createIndexIncremental(type, fields, boost = null) {
  console.log(`Indexation de ${type}...`);
  const indexConfig = {
    fields,
    storeFields: ['id'],
    ...miniSearchOptions
  };
  if (boost) indexConfig.boost = boost;

  searchIndexes[type] = buildFrozenIndexFromRows(
    dataCache[type],
    (item, rowIndex) => buildIndexDocument(item, rowIndex, fields),
    indexConfig
  );
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
  for (const item of dataCache.presentations) {
    appendToCisList(presentationsByCis, item.cis, item);
  }

  const compositionsByCis = new Map();
  for (const item of dataCache.compositions) {
    appendToCisList(compositionsByCis, item.cis, item);
  }

  const avisSmrByCis = new Map();
  for (const item of dataCache.avis_smr) {
    appendToCisList(avisSmrByCis, item.cis, item);
  }

  const avisAsmrByCis = new Map();
  for (const item of dataCache.avis_asmr) {
    appendToCisList(avisAsmrByCis, item.cis, item);
  }

  const conditionsByCis = new Map();
  for (const item of dataCache.conditions) {
    appendToCisList(conditionsByCis, item.cis, item);
  }

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

function clearLoadedData() {
  for (const key of Object.keys(searchIndexes)) {
    searchIndexes[key] = null;
  }
  for (const key of Object.keys(dataCache)) {
    if (key === 'metadata') continue;
    dataCache[key] = [];
  }
  cisIndexes = null;
}

async function loadData() {
  const mainFilePath = path.join(DATA_DIR, 'CIS_bdpm.txt');
  try {
    const stats = fs.statSync(mainFilePath);
    dataCache.metadata.last_updated = stats.mtime.toISOString();
  } catch {
    dataCache.metadata.last_updated = new Date().toISOString();
  }

  console.log('Chargement des données...');
  clearLoadedData();

  dataCache.specialites = await parseFileStreaming('CIS_bdpm.txt', [
    'cis', 'denomination', 'forme_pharma', 'voies_admin', 'statut_amm',
    'type_amm', 'commercialisation', 'date_amm', 'statut_bdm',
    'num_autorisation_euro', 'titulaire', 'surveillance_renforcee'
  ]);
  createIndexIncremental('specialites',
    ['cis', 'denomination', 'forme_pharma', 'titulaire'],
    { denomination: 3, cis: 2, forme_pharma: 0.5, titulaire: 1 }
  );

  dataCache.presentations = await parseFileStreaming('CIS_CIP_bdpm.txt', [
    'cis', 'cip7', 'libelle', 'statut_admin', 'etat_commercialisation',
    'date_declaration', 'cip13', 'agrement_collectivite', 'taux_remboursement',
    'prix_medicament', 'prix_public', 'honoraires', 'indications'
  ]);
  createIndexIncremental('presentations',
    ['cis', 'cip7', 'cip13', 'libelle', 'indications'],
    { libelle: 3, indications: 2, cis: 2, cip7: 1.5, cip13: 1.5 }
  );

  dataCache.compositions = await parseFileStreaming('CIS_COMPO_bdpm.txt', [
    'cis', 'designation_element', 'code_substance', 'denomination_substance',
    'dosage', 'reference_dosage', 'nature_composant', 'numero_ordre'
  ]);
  createIndexIncremental('compositions',
    ['cis', 'denomination_substance', 'dosage'],
    { denomination_substance: 3, cis: 2, dosage: 1 }
  );

  if (LOAD_HAS_AVIS) {
    dataCache.avis_smr = await parseFileStreaming('CIS_HAS_SMR_bdpm.txt', [
      'cis', 'has_dossier', 'motif_evaluation', 'date_avis', 'valeur_smr', 'libelle_smr'
    ]);
    createIndexIncremental('avis_smr', ['libelle_smr', 'valeur_smr']);

    dataCache.avis_asmr = await parseFileStreaming('CIS_HAS_ASMR_bdpm.txt', [
      'cis', 'has_dossier', 'motif_evaluation', 'date_avis', 'valeur_asmr', 'libelle_asmr'
    ]);
    createIndexIncremental('avis_asmr', ['libelle_asmr', 'valeur_asmr']);
  } else {
    dataCache.avis_smr = [];
    dataCache.avis_asmr = [];
    searchIndexes.avis_smr = null;
    searchIndexes.avis_asmr = null;
  }

  dataCache.generiques = await parseFileStreaming('CIS_GENER_bdpm.txt', [
    'id_groupe', 'libelle_groupe', 'cis', 'type_generique', 'numero_ordre'
  ]);
  createIndexIncremental('generiques', ['libelle_groupe']);

  dataCache.conditions = await parseFileStreaming('CIS_CPD_bdpm.txt', ['cis', 'condition']);
  createIndexIncremental('conditions', ['condition']);

  dataCache.ruptures = await parseFileStreaming('CIS_CIP_Dispo_Spec.txt', [
    'cis', 'cip13', 'code_statut', 'libelle_statut', 'date_debut',
    'date_mise_a_jour', 'date_remise_dispo', 'lien_ansm'
  ]);
  createIndexIncremental('ruptures', ['libelle_statut']);

  dataCache.mitm = await parseFileStreaming('CIS_MITM.txt', ['cis', 'code_atc', 'denomination', 'lien_fi']);
  createIndexIncremental('mitm',
    ['cis', 'code_atc', 'denomination'],
    { denomination: 3, code_atc: 2, cis: 2 }
  );

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
  createIndexIncremental('substances', ['denomination']);

  buildCisIndexes();
  console.log(`Données chargées et indexées: ${dataCache.specialites.length} spécialités`);
}

function enrichSpecialite(item) {
  if (!item) return item;
  return { ...item, url_bdpm: bdpmExtraitUrl(item.cis) };
}

function getSpecialiteByCis(cis) {
  if (!cisIndexes) return undefined;
  const row = cisIndexes.specialitesByCis.get(cis);
  return row ? enrichSpecialite(row) : undefined;
}

function getRelatedByCis(type, cis, limit = HYDRATE_RELATED_LIMIT) {
  if (!cisIndexes || !cis) return [];
  const mapKey = RELATED_BY_CIS_MAPS[type];
  if (!mapKey) return [];
  const rows = cisIndexes[mapKey].get(cis) || [];
  return limit > 0 ? rows.slice(0, limit) : rows;
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

function search(type, query) {
  if (!query) {
    const rows = dataCache[type] || [];
    if (type === 'specialites') {
      return rows.map((row) => enrichSpecialite(row));
    }
    return rows;
  }
  if (!searchIndexes[type]) return [];

  const results = searchIndexes[type].search(query);
  const normalizedQuery = normalizeSearchText(query);
  const primaryField = PRIMARY_FIELDS[type];

  const rankedResults = results.map((res) => {
    const item = dataCache[type][res.id];
    const value = item && item[primaryField] ? normalizeSearchText(item[primaryField]) : '';
    const normalizedCis = item && item.cis ? normalizeSearchText(item.cis) : '';
    let priority = 0;
    if (value === normalizedQuery || normalizedCis === normalizedQuery) priority = 2;
    else if (value.startsWith(normalizedQuery) || normalizedCis.startsWith(normalizedQuery)) priority = 1;

    return { item, score: res.score, priority, match_quality: MATCH_QUALITY[priority] };
  });

  rankedResults.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return b.score - a.score;
  });

  return rankedResults.map((r) => Object.assign({}, r.item, { match_quality: r.match_quality }));
}

function getData(type) {
  const rows = dataCache[type] || [];
  if (type === 'specialites') {
    return rows.map((row) => enrichSpecialite(row));
  }
  return rows;
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
  HYDRATE_RELATED_LIMIT,
  DETAIL_HYDRATE_RELATED_LIMIT
};
