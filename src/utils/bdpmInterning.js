'use strict';

/**
 * Champs BDPM éligibles à l'interning (stringPool).
 * Aligné sur scripts/benchmark/analyze-interning-candidates.js — relancer après changement de schéma.
 *
 * Règles : ratio distinct/total faible, copies moyennes élevées, chaînes courtes.
 * Ne pas interner : cis, cip13, libelle, denomination, indications (textes longs).
 */
const BDPM_LOW_CARDINALITY_FIELDS = {
  specialites: [
    'forme_pharma',
    'voies_admin',
    'statut_amm',
    'type_amm',
    'commercialisation',
    'surveillance_renforcee',
    'statut_bdm',
    'titulaire'
  ],
  presentations: [
    'statut_admin',
    'etat_commercialisation',
    'agrement_collectivite',
    'taux_remboursement',
    'honoraires'
  ],
  compositions: ['nature_composant', 'designation_element', 'reference_dosage', 'numero_ordre'],
  avis_smr: ['motif_evaluation', 'valeur_smr', 'libelle_smr'],
  avis_asmr: ['motif_evaluation', 'valeur_asmr', 'libelle_asmr'],
  generiques: ['type_generique', 'numero_ordre'],
  conditions: ['condition'],
  ruptures: ['code_statut', 'libelle_statut'],
  mitm: ['code_atc']
};

function lowCardinalityFieldsFor(type) {
  return BDPM_LOW_CARDINALITY_FIELDS[type] || [];
}

module.exports = {
  BDPM_LOW_CARDINALITY_FIELDS,
  lowCardinalityFieldsFor
};
