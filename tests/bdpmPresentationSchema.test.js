'use strict';

const {
  DOLIPRANE_8CP_TSV,
  DOLIPRANE_8CP_JSON,
  REGRESSED_PRESENTATION_FIELDS,
  EXPECTED_PRESENTATION_COLUMN_COUNT
} = require('./fixtures/cis-cip-samples');
const { parsePresentationTsv, isPlausibleCip13 } = require('./helpers/bdpmPresentation');
const { Presentation } = require('../src/models/bdpm');
const { parse } = require('csv-parse/sync');
const { BDPM_SCHEMAS } = require('../src/utils/corpusSchemas');

describe('BDPM presentations schema (CIS_CIP_bdpm.txt)', () => {
  it('aligne 13 colonnes comme le format gouv officiel', () => {
    expect(BDPM_SCHEMAS.presentations).toHaveLength(EXPECTED_PRESENTATION_COLUMN_COUNT);
    expect(BDPM_SCHEMAS.presentations).not.toEqual(REGRESSED_PRESENTATION_FIELDS);
  });

  it('parse une ligne gouv réelle (Doliprane 8 cp)', () => {
    const row = parsePresentationTsv(DOLIPRANE_8CP_TSV);
    expect(Presentation.fromCsv(row).toJSON()).toEqual(DOLIPRANE_8CP_JSON);
  });

  it('place un CIP13 numérique, pas un libellé de déclaration', () => {
    const json = Presentation.fromCsv(parsePresentationTsv(DOLIPRANE_8CP_TSV)).toJSON();
    expect(isPlausibleCip13(json.cip13)).toBe(true);
    expect(json.cip13).not.toMatch(/déclaration/i);
    expect(json.taux_remboursement).toMatch(/%$/);
    expect(json.agrement_collectivite).toMatch(/^(oui|non|inconnu)$/i);
  });

  it('rejette le schéma raccourci à 10 colonnes (régression commit 7766624)', () => {
    const regressed = parse(DOLIPRANE_8CP_TSV, {
      delimiter: '\t',
      columns: REGRESSED_PRESENTATION_FIELDS,
      trim: true,
      relax_column_count: true
    })[0];
    const broken = Presentation.fromCsv(regressed).toJSON();
    expect(isPlausibleCip13(broken.cip13)).toBe(false);
    expect(broken.cip13).toMatch(/déclaration/i);
  });
});
