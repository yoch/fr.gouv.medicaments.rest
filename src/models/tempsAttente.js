'use strict';

const { defineCorpusRecord } = require('./defineCorpusRecord');

const TEMPS_ATTENTE_FIELDS = ['voie', 'espece', 'denree', 'quantite', 'unite'];

const TempsAttenteEntry = defineCorpusRecord('TempsAttenteEntry', {
  fields: TEMPS_ATTENTE_FIELDS
});

module.exports = {
  TempsAttenteEntry,
  TEMPS_ATTENTE_FIELDS
};
