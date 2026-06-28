'use strict';

const { VET_SCHEMAS } = require('../../utils/corpusSchemas');
const { defineCorpusRecord } = require('../defineCorpusRecord');
const { buildLienRcpFromNom } = require('./rcp');
const { omitStoredFieldsFor } = require('../../utils/corpusLightProfile');

const MedicamentVet = defineCorpusRecord('MedicamentVet', {
  fields: VET_SCHEMAS.medicaments,
  omitStoredFields: () => omitStoredFieldsFor('vet_medicaments'),
  arrayFields: ['codes_atcvet', 'especes'],
  getters: {
    lien_rcp() {
      return this.maj_rcp ? buildLienRcpFromNom(this.nom) : '';
    }
  },
  enrichToJson(inst, o) {
    if (inst.maj_rcp) o.lien_rcp = inst.lien_rcp;
  }
});

const CompositionVet = defineCorpusRecord('CompositionVet', {
  fields: VET_SCHEMAS.compositions
});

const PresentationVet = defineCorpusRecord('PresentationVet', {
  fields: VET_SCHEMAS.presentations,
  arrayFields: ['conditions_delivrance']
});

module.exports = {
  MedicamentVet,
  CompositionVet,
  PresentationVet
};
