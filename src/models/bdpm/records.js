'use strict';

const { BDPM_SCHEMAS } = require('../../utils/corpusSchemas');
const { defineCorpusRecord } = require('../defineCorpusRecord');
const { bdpmExtraitUrl } = require('./constants');

const Specialite = defineCorpusRecord('Specialite', {
  fields: BDPM_SCHEMAS.specialites,
  lowCardinalityFields: ['forme_pharma', 'voies_admin', 'statut_amm', 'type_amm', 'commercialisation', 'surveillance_renforcee'],
  getters: {
    url_bdpm() {
      return this.cis ? bdpmExtraitUrl(this.cis) : '';
    }
  },
  enrichToJson(inst, o) {
    if (inst.cis) o.url_bdpm = inst.url_bdpm;
  }
});

const Presentation = defineCorpusRecord('Presentation', {
  fields: BDPM_SCHEMAS.presentations,
  lowCardinalityFields: ['etat_commercialisation', 'taux_remboursement', 'indications']
});

const Composition = defineCorpusRecord('Composition', {
  fields: BDPM_SCHEMAS.compositions,
  lowCardinalityFields: ['nature_composant']
});

const AvisSmr = defineCorpusRecord('AvisSmr', {
  fields: BDPM_SCHEMAS.avis_smr,
  lowCardinalityFields: ['motif_evaluation', 'valeur_smr', 'libelle_smr']
});

const AvisAsmr = defineCorpusRecord('AvisAsmr', {
  fields: BDPM_SCHEMAS.avis_asmr,
  lowCardinalityFields: ['motif_evaluation', 'valeur_asmr', 'libelle_asmr']
});

const Generique = defineCorpusRecord('Generique', {
  fields: BDPM_SCHEMAS.generiques,
  lowCardinalityFields: ['type_generique']
});

const Condition = defineCorpusRecord('Condition', {
  fields: BDPM_SCHEMAS.conditions,
  lowCardinalityFields: ['condition']
});

const Rupture = defineCorpusRecord('Rupture', {
  fields: BDPM_SCHEMAS.ruptures,
  lowCardinalityFields: ['code_statut', 'libelle_statut']
});

const Mitm = defineCorpusRecord('Mitm', {
  fields: BDPM_SCHEMAS.mitm,
  lowCardinalityFields: ['code_atc']
});

const Substance = defineCorpusRecord('Substance', {
  fields: BDPM_SCHEMAS.substances,
  numericFields: ['medicaments_count']
});

const BDPM_RECORD_CLASSES = {
  specialites: Specialite,
  presentations: Presentation,
  compositions: Composition,
  avis_smr: AvisSmr,
  avis_asmr: AvisAsmr,
  generiques: Generique,
  conditions: Condition,
  ruptures: Rupture,
  mitm: Mitm,
  substances: Substance
};

const FROM_CSV = Object.fromEntries(
  Object.entries(BDPM_RECORD_CLASSES).map(([type, Cls]) => [type, Cls.fromCsv])
);

module.exports = {
  Specialite,
  Presentation,
  Composition,
  AvisSmr,
  AvisAsmr,
  Generique,
  Condition,
  Rupture,
  Mitm,
  Substance,
  FROM_CSV,
  BDPM_RECORD_CLASSES
};
