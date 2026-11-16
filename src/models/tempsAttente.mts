import { defineCorpusRecord } from './defineCorpusRecord.mts';

const TEMPS_ATTENTE_FIELDS = ['voie', 'espece', 'denree', 'quantite', 'unite'] as const;

const TempsAttenteEntry = defineCorpusRecord('TempsAttenteEntry', {
  fields: TEMPS_ATTENTE_FIELDS
});

export {
  TempsAttenteEntry,
  TEMPS_ATTENTE_FIELDS
};
