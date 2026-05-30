'use strict';

/** Schémas BDPM — ordre = colonnes CSV / champs API. */
const BDPM_SCHEMAS = {
  specialites: [
    'cis', 'denomination', 'forme_pharma', 'voies_admin', 'statut_amm',
    'type_amm', 'commercialisation', 'date_amm', 'statut_bdm',
    'num_autorisation_euro', 'titulaire', 'surveillance_renforcee'
  ],
  presentations: [
    'cis', 'cip7', 'libelle', 'etat_commercialisation', 'cip13',
    'taux_remboursement', 'prix_medicament', 'prix_public', 'honoraires', 'indications'
  ],
  compositions: [
    'cis', 'designation_element', 'code_substance', 'denomination_substance',
    'dosage', 'nature_composant'
  ],
  avis_smr: [
    'cis', 'has_dossier', 'motif_evaluation', 'date_avis', 'valeur_smr', 'libelle_smr'
  ],
  avis_asmr: [
    'cis', 'has_dossier', 'motif_evaluation', 'date_avis', 'valeur_asmr', 'libelle_asmr'
  ],
  generiques: ['id_groupe', 'libelle_groupe', 'cis', 'type_generique', 'numero_ordre'],
  conditions: ['cis', 'condition'],
  ruptures: [
    'cis', 'cip13', 'code_statut', 'libelle_statut', 'date_debut',
    'date_mise_a_jour', 'date_remise_dispo', 'lien_ansm'
  ],
  mitm: ['cis', 'code_atc', 'denomination', 'lien_fi'],
  substances: ['code', 'denomination', 'medicaments_count']
};

/** Schémas vétérinaires — tableaux imbriqués en slot (référence Array). */
const VET_SCHEMAS = {
  medicaments: [
    'num', 'nom', 'titulaire', 'forme_pharmaceutique', 'statut_amm', 'codes_atcvet',
    'especes', 'maj_rcp'
  ],
  compositions: ['num', 'substance', 'quantite', 'unite'],
  presentations: ['num', 'libelle', 'gtin', 'conditions_delivrance']
};

module.exports = {
  BDPM_SCHEMAS,
  VET_SCHEMAS
};
