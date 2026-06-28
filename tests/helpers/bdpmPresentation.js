'use strict';

const { parse } = require('csv-parse/sync');
const { BDPM_SCHEMAS } = require('../../src/utils/corpusSchemas');

function parsePresentationTsv(line) {
  return parse(line, {
    delimiter: '\t',
    columns: BDPM_SCHEMAS.presentations,
    trim: true,
    relax_column_count: true
  })[0];
}

function isPlausibleCip13(value) {
  return typeof value === 'string' && /^340\d{10}$/.test(value);
}

module.exports = {
  parsePresentationTsv,
  isPlausibleCip13
};
