'use strict';

/**
 * Profil corpus allégé : ne pas charger en RAM / indexer certains champs lourds ou peu utiles
 * aux agents — sans tronquer le schéma CSV (qui doit toujours refléter les colonnes gouv).
 *
 * Indépendant de LOAD_HAS_AVIS (qui ne concerne que les fichiers/index HAS SMR/ASMR).
 * Actif si CORPUS_LIGHT_PROFILE=true ; désactivé par défaut si la variable est absente.
 */
const OMIT_STORED_FIELDS_BY_TYPE = {
  presentations: ['indications', 'honoraires'],
  compositions: ['reference_dosage', 'numero_ordre'],
  vet_medicaments: ['num_amm', 'date_amm']
};

function isCorpusLightProfile() {
  return process.env.CORPUS_LIGHT_PROFILE === 'true';
}

function omitStoredFieldsFor(type) {
  if (!isCorpusLightProfile()) return [];
  return OMIT_STORED_FIELDS_BY_TYPE[type] || [];
}

function presentationIndexFields() {
  const fields = ['cis', 'cip7', 'cip13', 'libelle'];
  if (!isCorpusLightProfile()) fields.push('indications');
  return fields;
}

function presentationIndexBoost() {
  const boost = { libelle: 3, cis: 2, cip7: 1.5, cip13: 1.5 };
  if (!isCorpusLightProfile()) boost.indications = 2;
  return boost;
}

module.exports = {
  isCorpusLightProfile,
  omitStoredFieldsFor,
  presentationIndexFields,
  presentationIndexBoost,
  OMIT_STORED_FIELDS_BY_TYPE
};
