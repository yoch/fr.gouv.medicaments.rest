const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

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

async function loadData() {
  // Mise à jour des métadonnées avec la date de modification du fichier principal
  const mainFilePath = path.join(DATA_DIR, 'CIS_bdpm.txt');
  try {
    const stats = fs.statSync(mainFilePath);
    dataCache.metadata.last_updated = stats.mtime.toISOString();
  } catch (error) {
    dataCache.metadata.last_updated = new Date().toISOString();
  }

  console.log('Chargement des spécialités...');
  dataCache.specialites = parseFile('CIS_bdpm.txt', [
    'cis',
    'denomination',
    'forme_pharma',
    'voies_admin',
    'statut_amm',
    'type_amm',
    'commercialisation',
    'date_amm',
    'statut_bdm',
    'num_autorisation_euro',
    'titulaire',
    'surveillance_renforcee'
  ]);

  console.log('Chargement des présentations...');
  dataCache.presentations = parseFile('CIS_CIP_bdpm.txt', [
    'cis',
    'cip7',
    'libelle',
    'statut_admin',
    'etat_commercialisation',
    'date_declaration',
    'cip13',
    'agrement_collectivite',
    'taux_remboursement',
    'prix_medicament',
    'prix_public',
    'honoraires',
    'indications'
  ]);

  console.log('Chargement des compositions...');
  dataCache.compositions = parseFile('CIS_COMPO_bdpm.txt', [
    'cis',
    'designation_element',
    'code_substance',
    'denomination_substance',
    'dosage',
    'reference_dosage',
    'nature_composant',
    'numero_ordre'
  ]);

  console.log('Chargement des avis SMR...');
  dataCache.avis_smr = parseFile('CIS_HAS_SMR_bdpm.txt', [
    'cis',
    'has_dossier',
    'motif_evaluation',
    'date_avis',
    'valeur_smr',
    'libelle_smr'
  ]);

  console.log('Chargement des avis ASMR...');
  dataCache.avis_asmr = parseFile('CIS_HAS_ASMR_bdpm.txt', [
    'cis',
    'has_dossier',
    'motif_evaluation',
    'date_avis',
    'valeur_asmr',
    'libelle_asmr'
  ]);

  console.log('Chargement des groupes génériques...');
  dataCache.generiques = parseFile('CIS_GENER_bdpm.txt', [
    'id_groupe',
    'libelle_groupe',
    'cis',
    'type_generique',
    'numero_ordre'
  ]);

  console.log('Chargement des conditions...');
  dataCache.conditions = parseFile('CIS_CPD_bdpm.txt', [
    'cis',
    'condition'
  ]);

  console.log('Chargement des ruptures...');
  dataCache.ruptures = parseFile('CIS_CIP_Dispo_Spec.txt', [
    'cis',
    'cip13',
    'code_statut',
    'libelle_statut',
    'date_debut',
    'date_mise_a_jour',
    'date_remise_dispo',
    'lien_ansm'
  ]);

  console.log('Chargement MITM...');
  dataCache.mitm = parseFile('CIS_MITM.txt', [
    'cis',
    'code_atc',
    'denomination',
    'lien_fi'
  ]);

  console.log('Chargement des informations importantes...');
  dataCache.infos = parseFile('CIS_InfoImportantes_bdpm.txt', [
    'cis',
    'date_debut',
    'date_fin',
    'texte_affichage'
  ]);

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
  console.log(`Substances indexées: ${dataCache.substances.length}`);

  console.log(`Données chargées: ${dataCache.specialites.length} spécialités`);
}

function searchInData(dataset, query, fields) {
  if (!query) return dataset;

  const searchTerm = query.toLowerCase();
  const wildcardRegex = new RegExp(
    searchTerm.replace(/\*/g, '.*').replace(/\?/g, '.'),
    'i'
  );

  return dataset.filter(item => {
    return fields.some(field => {
      const value = item[field];
      if (!value) return false;
      return wildcardRegex.test(value.toString().toLowerCase());
    });
  });
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
  searchInData,
  getMetadata
};