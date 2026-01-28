const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const MiniSearch = require('minisearch');

const DATA_DIR = path.join(__dirname, '../../data');

let dataCache = {
  specialites: [],
  presentations: [],
  compositions: [],
  avis_smr: [],
  avis_asmr: [],
  generiques: [],
  conditions: [],
  ruptures: [],
  infos: [],
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
  infos: null,
  substances: null,
  mitm: null
};

// Champs de codes numériques qui nécessitent une recherche exacte (pas de fuzzy)
const EXACT_MATCH_FIELDS = new Set(['cis', 'cip7', 'cip13', 'code_atc', 'code_substance']);

// Configuration des options de recherche pour ignorer les accents
const miniSearchOptions = {
  processTerm: (term, _fieldName) => {
    return term
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  },
  searchOptions: {
    processTerm: (term) => {
      return term
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
    },
    prefix: true,
    // Fuzzy sélectif : désactivé pour les codes numériques, activé pour le texte
    fuzzy: (term) => {
      // Si le terme est purement numérique, pas de fuzzy (recherche exacte)
      if (/^\d+$/.test(term)) {
        return false;
      }
      // Sinon, fuzzy avec tolérance de 0.2
      return 0.2;
    },
    //weights: { fuzzy: 0.42, prefix: 0.375 },
  }
};

function parseFile(filename, columns) {
  const filepath = path.join(DATA_DIR, filename);

  if (!fs.existsSync(filepath)) {
    console.warn(`Fichier ${filename} non trouvé`);
    return [];
  }

  try {
    // Tous les fichiers sont maintenant en UTF-8
    const content = fs.readFileSync(filepath, { encoding: 'utf8' });
    const records = parse(content, {
      delimiter: '\t',
      columns: columns,
      skip_empty_lines: true,
      trim: true,
      quote: false,
      escape: false,
      relax_quotes: true,
      relax_column_count: true
    });

    return records;
  } catch (error) {
    console.error(`Erreur parsing ${filename}:`, error.message);
    console.warn(`Tentative de parsing ligne par ligne pour ${filename}...`);

    try {
      // Tous les fichiers sont maintenant en UTF-8
      const content = fs.readFileSync(filepath, { encoding: 'utf8' });
      const lines = content.split('\n');
      const records = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const values = line.split('\t');
        const record = {};

        for (let j = 0; j < columns.length && j < values.length; j++) {
          record[columns[j]] = values[j] || '';
        }

        records.push(record);
      }

      console.log(`✓ Parsing ligne par ligne réussi pour ${filename}: ${records.length} entrées`);
      return records;
    } catch (fallbackError) {
      console.error(`Erreur parsing fallback ${filename}:`, fallbackError.message);
      return [];
    }
  }
}

function createIndex(type, fields, boost = null) {
  console.log(`Indexation de ${type}...`);
  const indexConfig = {
    fields: fields,
    storeFields: ['id'], // On ne stocke que l'ID (l'index du tableau) pour économiser la RAM
    ...miniSearchOptions
  };

  // Ajouter le boosting si spécifié
  if (boost) {
    indexConfig.boost = boost;
  }

  const index = new MiniSearch(indexConfig);

  // On ajoute un champ "id" artificiel qui correspond à l'index dans le tableau dataCache
  const processedData = dataCache[type].map((item, index) => ({
    id: index,
    ...item
  }));

  index.addAll(processedData);
  searchIndexes[type] = index;
}

async function loadData() {
  // Mise à jour des métadonnées
  const mainFilePath = path.join(DATA_DIR, 'CIS_bdpm.txt');
  try {
    const stats = fs.statSync(mainFilePath);
    dataCache.metadata.last_updated = stats.mtime.toISOString();
  } catch (error) {
    dataCache.metadata.last_updated = new Date().toISOString();
  }

  console.log('Chargement des données...');

  // Chargement et indexation des spécialités
  dataCache.specialites = parseFile('CIS_bdpm.txt', [
    'cis', 'denomination', 'forme_pharma', 'voies_admin', 'statut_amm',
    'type_amm', 'commercialisation', 'date_amm', 'statut_bdm',
    'num_autorisation_euro', 'titulaire', 'surveillance_renforcee'
  ]);
  createIndex('specialites',
    ['cis', 'denomination', 'forme_pharma', 'titulaire'],
    { denomination: 3, cis: 2, forme_pharma: 0.5, titulaire: 1 }
  );

  // Chargement et indexation des présentations
  dataCache.presentations = parseFile('CIS_CIP_bdpm.txt', [
    'cis', 'cip7', 'libelle', 'statut_admin', 'etat_commercialisation',
    'date_declaration', 'cip13', 'agrement_collectivite', 'taux_remboursement',
    'prix_medicament', 'prix_public', 'honoraires', 'indications'
  ]);
  createIndex('presentations',
    ['cis', 'cip7', 'cip13', 'libelle', 'indications'],
    { libelle: 3, indications: 2, cis: 2, cip7: 1.5, cip13: 1.5 }
  );

  // Chargement et indexation des compositions
  dataCache.compositions = parseFile('CIS_COMPO_bdpm.txt', [
    'cis', 'designation_element', 'code_substance', 'denomination_substance',
    'dosage', 'reference_dosage', 'nature_composant', 'numero_ordre'
  ]);
  createIndex('compositions',
    ['cis', 'denomination_substance', 'dosage'],
    { denomination_substance: 3, cis: 2, dosage: 1 }
  );

  // Chargement et indexation des avis SMR
  dataCache.avis_smr = parseFile('CIS_HAS_SMR_bdpm.txt', [
    'cis', 'has_dossier', 'motif_evaluation', 'date_avis', 'valeur_smr', 'libelle_smr'
  ]);
  createIndex('avis_smr', ['libelle_smr', 'valeur_smr']);

  // Chargement et indexation des avis ASMR
  dataCache.avis_asmr = parseFile('CIS_HAS_ASMR_bdpm.txt', [
    'cis', 'has_dossier', 'motif_evaluation', 'date_avis', 'valeur_asmr', 'libelle_asmr'
  ]);
  createIndex('avis_asmr', ['libelle_asmr', 'valeur_asmr']);

  // Chargement et indexation des groupes génériques
  dataCache.generiques = parseFile('CIS_GENER_bdpm.txt', [
    'id_groupe', 'libelle_groupe', 'cis', 'type_generique', 'numero_ordre'
  ]);
  createIndex('generiques', ['libelle_groupe']);

  // Chargement et indexation des conditions
  dataCache.conditions = parseFile('CIS_CPD_bdpm.txt', ['cis', 'condition']);
  createIndex('conditions', ['condition']);

  // Chargement et indexation des ruptures
  dataCache.ruptures = parseFile('CIS_CIP_Dispo_Spec.txt', [
    'cis', 'cip13', 'code_statut', 'libelle_statut', 'date_debut',
    'date_mise_a_jour', 'date_remise_dispo', 'lien_ansm'
  ]);
  createIndex('ruptures', ['libelle_statut']);

  // Chargement et indexation MITM
  dataCache.mitm = parseFile('CIS_MITM.txt', ['cis', 'code_atc', 'denomination', 'lien_fi']);
  createIndex('mitm',
    ['cis', 'code_atc', 'denomination'],
    { denomination: 3, code_atc: 2, cis: 2 }
  );

  // Chargement et indexation des infos importantes
  /*
  dataCache.infos = parseFile('CIS_InfoImportantes.txt', [
    'cis', 'date_debut', 'date_fin', 'texte_affichage'
  ]);
  createIndex('infos',
    ['cis', 'texte_affichage'],
    { texte_affichage: 3, cis: 2 }
  );
  */

  // Génération de l'index des substances
  console.log('Génération de l\'index des substances...');
  const substancesMap = new Map();
  dataCache.compositions.forEach(comp => {
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
  });
  dataCache.substances = Array.from(substancesMap.values());
  createIndex('substances', ['denomination']);
  console.log(`Substances indexées: ${dataCache.substances.length}`);

  console.log(`Données chargées et indexées: ${dataCache.specialites.length} spécialités`);
}

// Champs prioritaires pour le boosting "Commence par"
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
  infos: 'texte_affichage',
  substances: 'denomination'
};

/**
 * Recherche dans un dataset via MiniSearch
 * @param {string} type - Le type de données
 * @param {string} query - Le terme de recherche
 * @returns {Array} - Liste des objets trouvés, triés par pertinence
 */
function search(type, query) {
  if (!query) return dataCache[type] || [];
  if (!searchIndexes[type]) return [];

  const results = searchIndexes[type].search(query);
  const normalizedQuery = query.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const primaryField = PRIMARY_FIELDS[type];

  // On pré-calcule les critères de tri pour éviter de le faire à chaque comparaison
  const rankedResults = results.map(res => {
    const item = dataCache[type][res.id];
    const value = (item && item[primaryField]) ?
      String(item[primaryField]).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "") : "";

    // Détermination de la priorité (0=Autre, 1=Commence par, 2=Exact)
    let priority = 0;
    if (value === normalizedQuery) priority = 2;
    // Note: startsWith est très efficace, on l'utilise pour garantir que les résultats pertinents sont en haut
    else if (value.startsWith(normalizedQuery)) priority = 1;

    return { item, score: res.score, priority };
  });

  // Tri: Priorité > Score (si diff significative) > Longueur (plus court = mieux)
  rankedResults.sort((a, b) => {
    // 1. Priorité absolue (Exact Match / Starts With)
    if (b.priority !== a.priority) return b.priority - a.priority;

    // 2. Score textuel
    return b.score - a.score;
  });

  return rankedResults.map(r => r.item);
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
  getMetadata
};