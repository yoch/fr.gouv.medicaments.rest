'use strict';

const { BDPM_SCHEMAS } = require('../src/utils/corpusSchemas');
const { BDPM_LOW_CARDINALITY_FIELDS } = require('../src/utils/bdpmInterning');
const { Presentation } = require('../src/models/bdpm');
const { clearInternPool } = require('../src/utils/stringPool');
const { DOLIPRANE_8CP_JSON } = require('./fixtures/cis-cip-samples');

describe('bdpmInterning', () => {
  for (const [type, fields] of Object.entries(BDPM_LOW_CARDINALITY_FIELDS)) {
    it(`${type} : champs internés ⊆ schéma CSV`, () => {
      const schema = BDPM_SCHEMAS[type];
      expect(schema).toBeDefined();
      for (const field of fields) {
        expect(schema).toContain(field);
      }
    });
  }

  it('déduplique les références string sur les champs internés', () => {
    clearInternPool();
    const row = { ...DOLIPRANE_8CP_JSON, indications: '' };
    const a = Presentation.fromCsv(row);
    const b = Presentation.fromCsv(row);
    expect(a.statut_admin).toBe(b.statut_admin);
    expect(a.taux_remboursement).toBe(b.taux_remboursement);
  });
});
