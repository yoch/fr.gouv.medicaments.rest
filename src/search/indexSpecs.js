'use strict';

/**
 * Spécifications d'index FrozenMiniSearch unifiées pour BDPM et vétérinaire.
 *
 * Une spec = `{ file?, fields, boost?, primaryField, idField }`.
 *   - `file` : nom du fichier source (BDPM only — vet charge depuis XML en mémoire)
 *   - `fields` : champs indexés (peut être un getter pour dépendre du profil corpus)
 *   - `boost` : poids par champ (optionnel)
 *   - `primaryField` : champ principal pour le post-classement (match_quality)
 *   - `idField` : champ d'identifiant pour la fusion par clé (cis / num)
 *
 * Source unique consommée par les loaders (chargement + export) et par les
 * fonctions de recherche (primaryField / idField).
 */

const { presentationIndexFields, presentationIndexBoost } = require('../utils/corpusLightProfile');

const BDPM_INDEX_SPECS = {
  specialites: {
    file: 'CIS_bdpm.txt',
    fields: ['cis', 'denomination', 'forme_pharma', 'titulaire'],
    boost: { denomination: 3, cis: 2, forme_pharma: 0.5, titulaire: 1 },
    primaryField: 'denomination',
    idField: 'cis'
  },
  presentations: {
    file: 'CIS_CIP_bdpm.txt',
    get fields() {
      return presentationIndexFields();
    },
    get boost() {
      return presentationIndexBoost();
    },
    primaryField: 'libelle',
    idField: 'cis'
  },
  compositions: {
    file: 'CIS_COMPO_bdpm.txt',
    fields: ['cis', 'denomination_substance', 'dosage'],
    boost: { denomination_substance: 3, cis: 2, dosage: 1 },
    primaryField: 'denomination_substance',
    idField: 'cis'
  },
  avis_smr: {
    file: 'CIS_HAS_SMR_bdpm.txt',
    fields: ['libelle_smr', 'valeur_smr'],
    primaryField: 'libelle_smr',
    idField: 'cis'
  },
  avis_asmr: {
    file: 'CIS_HAS_ASMR_bdpm.txt',
    fields: ['libelle_asmr', 'valeur_asmr'],
    primaryField: 'libelle_asmr',
    idField: 'cis'
  },
  generiques: {
    file: 'CIS_GENER_bdpm.txt',
    fields: ['libelle_groupe'],
    primaryField: 'libelle_groupe',
    idField: 'cis'
  },
  conditions: {
    file: 'CIS_CPD_bdpm.txt',
    fields: ['condition'],
    primaryField: 'condition',
    idField: 'cis'
  },
  ruptures: {
    file: 'CIS_CIP_Dispo_Spec.txt',
    fields: ['libelle_statut'],
    primaryField: 'libelle_statut',
    idField: 'cis'
  },
  mitm: {
    file: 'CIS_MITM.txt',
    fields: ['cis', 'code_atc', 'denomination'],
    boost: { denomination: 3, code_atc: 2, cis: 2 },
    primaryField: 'denomination',
    idField: 'cis'
  },
  substances: {
    fields: ['denomination'],
    primaryField: 'denomination',
    idField: null
  }
};

const VET_INDEX_SPECS = {
  medicaments: {
    fields: ['nom', 'num'],
    boost: { nom: 3, num: 2 },
    primaryField: 'nom',
    idField: 'num'
  },
  compositions: {
    fields: ['substance', 'num'],
    boost: { substance: 3, num: 1 },
    primaryField: 'substance',
    idField: 'num'
  }
};

module.exports = { BDPM_INDEX_SPECS, VET_INDEX_SPECS };
