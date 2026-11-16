import { BDPM_SCHEMAS } from '../../utils/corpusSchemas.mts';
import {
  defineCorpusRecord,
  type CorpusRecordClass,
  type CorpusRecordInstance
} from '../defineCorpusRecord.mts';
import { bdpmExtraitUrl } from './constants.mts';
import { omitStoredFieldsFor } from '../../utils/corpusLightProfile.mts';
import { lowCardinalityFieldsFor } from '../../utils/bdpmInterning.mts';

const Specialite = defineCorpusRecord('Specialite', {
  fields: BDPM_SCHEMAS.specialites,
  lowCardinalityFields: lowCardinalityFieldsFor('specialites'),
  getters: {
    url_bdpm() {
      return this.cis ? bdpmExtraitUrl(String(this.cis)) : '';
    }
  },
  enrichToJson(inst, o) {
    if (inst.cis) o.url_bdpm = inst.url_bdpm;
  }
});

const Presentation = defineCorpusRecord('Presentation', {
  fields: BDPM_SCHEMAS.presentations,
  omitStoredFields: () => omitStoredFieldsFor('presentations'),
  lowCardinalityFields: lowCardinalityFieldsFor('presentations')
});

const Composition = defineCorpusRecord('Composition', {
  fields: BDPM_SCHEMAS.compositions,
  omitStoredFields: () => omitStoredFieldsFor('compositions'),
  lowCardinalityFields: lowCardinalityFieldsFor('compositions')
});

const AvisSmr = defineCorpusRecord('AvisSmr', {
  fields: BDPM_SCHEMAS.avis_smr,
  lowCardinalityFields: lowCardinalityFieldsFor('avis_smr')
});

const AvisAsmr = defineCorpusRecord('AvisAsmr', {
  fields: BDPM_SCHEMAS.avis_asmr,
  lowCardinalityFields: lowCardinalityFieldsFor('avis_asmr')
});

const Generique = defineCorpusRecord('Generique', {
  fields: BDPM_SCHEMAS.generiques,
  lowCardinalityFields: lowCardinalityFieldsFor('generiques')
});

const Condition = defineCorpusRecord('Condition', {
  fields: BDPM_SCHEMAS.conditions,
  lowCardinalityFields: lowCardinalityFieldsFor('conditions')
});

const Rupture = defineCorpusRecord('Rupture', {
  fields: BDPM_SCHEMAS.ruptures,
  lowCardinalityFields: lowCardinalityFieldsFor('ruptures')
});

const Mitm = defineCorpusRecord('Mitm', {
  fields: BDPM_SCHEMAS.mitm,
  lowCardinalityFields: lowCardinalityFieldsFor('mitm')
});

const Substance = defineCorpusRecord('Substance', {
  fields: BDPM_SCHEMAS.substances,
  numericFields: ['medicaments_count']
});

const BDPM_RECORD_CLASSES: Record<string, CorpusRecordClass> = {
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

const FROM_CSV: Record<string, (record: Record<string, unknown> | null | undefined) => CorpusRecordInstance> = {
  specialites: Specialite.fromCsv,
  presentations: Presentation.fromCsv,
  compositions: Composition.fromCsv,
  avis_smr: AvisSmr.fromCsv,
  avis_asmr: AvisAsmr.fromCsv,
  generiques: Generique.fromCsv,
  conditions: Condition.fromCsv,
  ruptures: Rupture.fromCsv,
  mitm: Mitm.fromCsv,
  substances: Substance.fromCsv
};

export {
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
