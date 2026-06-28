'use strict';

const config = require('../config');

/**
 * Profil corpus allégé : ne pas charger en RAM certains champs peu utiles aux agents —
 * sans tronquer le schéma CSV (qui doit toujours refléter les colonnes gouv).
 *
 * Aligné sur l'intention du commit 7766624 (présentations admin/collectivité, compositions
 * partielles, vet sans AMM). Indépendant de LOAD_HAS_AVIS.
 * Actif si CORPUS_LIGHT_PROFILE=true ; désactivé par défaut si la variable est absente.
 */
const OMIT_STORED_FIELDS_BY_TYPE = {
  presentations: ['statut_admin', 'date_declaration', 'agrement_collectivite'],
  compositions: ['reference_dosage', 'numero_ordre'],
  vet_medicaments: ['num_amm', 'date_amm']
};

function isCorpusLightProfile() {
  return config.corpusLightProfile;
}

function omitStoredFieldsFor(type) {
  if (!isCorpusLightProfile()) return [];
  return OMIT_STORED_FIELDS_BY_TYPE[type] || [];
}

function presentationIndexFields() {
  return ['cis', 'cip7', 'cip13', 'libelle', 'indications'];
}

function presentationIndexBoost() {
  return { libelle: 3, indications: 2, cis: 2, cip7: 1.5, cip13: 1.5 };
}

module.exports = {
  isCorpusLightProfile,
  omitStoredFieldsFor,
  presentationIndexFields,
  presentationIndexBoost,
  OMIT_STORED_FIELDS_BY_TYPE
};
