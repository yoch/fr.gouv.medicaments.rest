import { VET_SCHEMAS } from '../../utils/corpusSchemas.mts';
import { defineCorpusRecord } from '../defineCorpusRecord.mts';
import { buildLienRcpFromNom } from './rcp.mts';
import { omitStoredFieldsFor } from '../../utils/corpusLightProfile.mts';

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

export {
  MedicamentVet,
  CompositionVet,
  PresentationVet
};
