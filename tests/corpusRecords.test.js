'use strict';

const { BDPM_SCHEMAS, VET_SCHEMAS } = require('../src/utils/corpusSchemas');
const {
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
} = require('../src/models/bdpm');
const { MedicamentVet, CompositionVet, PresentationVet } = require('../src/models/vet');
const { TempsAttenteEntry } = require('../src/models/tempsAttente');
const {
  createCorpus,
  push,
  materializeRange,
  materializeIndices,
  buildKeyIndex,
  buildIndexDocument
} = require('../src/utils/corpusStore');
const { rankAndMaterializeSearch } = require('../src/utils/corpusSearch');
const { bdpmExtraitUrl } = require('../src/models/bdpm/constants');

function emptyCsv(fields, overrides = {}) {
  return { ...Object.fromEntries(fields.map((f) => [f, ''])), ...overrides };
}

describe('BDPM schema alignment', () => {
  for (const [type, fields] of Object.entries(BDPM_SCHEMAS)) {
    it(`${type} : FIELD_NAMES === BDPM_SCHEMAS`, () => {
      expect(BDPM_RECORD_CLASSES[type].FIELD_NAMES).toEqual(fields);
      expect(FROM_CSV[type]).toBe(BDPM_RECORD_CLASSES[type].fromCsv);
    });
  }
});

describe('BDPM toJSON contract', () => {
  const cases = [
    {
      name: 'specialites',
      Cls: Specialite,
      fields: BDPM_SCHEMAS.specialites,
      overrides: { cis: '60001234', denomination: 'TEST' },
      expected: {
        cis: '60001234',
        denomination: 'TEST',
        url_bdpm: bdpmExtraitUrl('60001234')
      }
    },
    {
      name: 'presentations',
      Cls: Presentation,
      fields: BDPM_SCHEMAS.presentations,
      overrides: { cis: '1', libelle: 'LIB' },
      expected: { cis: '1', libelle: 'LIB' }
    },
    {
      name: 'compositions',
      Cls: Composition,
      fields: BDPM_SCHEMAS.compositions,
      overrides: { cis: '1', denomination_substance: 'PARACETAMOL' },
      expected: { cis: '1', denomination_substance: 'PARACETAMOL' }
    },
    {
      name: 'avis_smr',
      Cls: AvisSmr,
      fields: BDPM_SCHEMAS.avis_smr,
      overrides: { cis: '1', libelle_smr: 'SMR' },
      expected: { cis: '1', libelle_smr: 'SMR' }
    },
    {
      name: 'avis_asmr',
      Cls: AvisAsmr,
      fields: BDPM_SCHEMAS.avis_asmr,
      overrides: { cis: '1', libelle_asmr: 'ASMR' },
      expected: { cis: '1', libelle_asmr: 'ASMR' }
    },
    {
      name: 'generiques',
      Cls: Generique,
      fields: BDPM_SCHEMAS.generiques,
      overrides: { id_groupe: 'G1', cis: '1' },
      expected: { id_groupe: 'G1', cis: '1' }
    },
    {
      name: 'conditions',
      Cls: Condition,
      fields: BDPM_SCHEMAS.conditions,
      overrides: { cis: '1', condition: 'Prescription' },
      expected: { cis: '1', condition: 'Prescription' }
    },
    {
      name: 'ruptures',
      Cls: Rupture,
      fields: BDPM_SCHEMAS.ruptures,
      overrides: { cis: '1', libelle_statut: 'Rupture' },
      expected: { cis: '1', libelle_statut: 'Rupture' }
    },
    {
      name: 'mitm',
      Cls: Mitm,
      fields: BDPM_SCHEMAS.mitm,
      overrides: { cis: '1', denomination: 'MITM' },
      expected: { cis: '1', denomination: 'MITM' }
    },
    {
      name: 'substances',
      Cls: Substance,
      fields: BDPM_SCHEMAS.substances,
      overrides: { code: 'C', denomination: 'D', medicaments_count: 0 },
      expected: { code: 'C', denomination: 'D', medicaments_count: 0 }
    }
  ];

  for (const { name, Cls, fields, overrides, expected } of cases) {
    it(name, () => {
      const row = Cls.fromCsv(emptyCsv(fields, overrides));
      expect(row.toJSON()).toEqual(expected);
    });
  }
});

describe('corpusStore', () => {
  it('buildKeyIndex unique et multi', () => {
    const corpus = createCorpus();
    push(corpus, new Substance('A', '1', 0));
    push(corpus, new Substance('A', '2', 0));
    push(corpus, new Substance('B', '3', 0));
    const multi = buildKeyIndex(corpus, 'code');
    expect(multi.get('A')).toEqual([0, 1]);
    const unique = buildKeyIndex(corpus, 'code', { unique: true });
    expect(unique.get('B')).toBe(2);
  });

  it('materializeRange ne matérialise que la plage demandée', () => {
    const corpus = createCorpus();
    push(corpus, new Substance('x', 'a', 1));
    push(corpus, new Substance('y', 'b', 2));
    push(corpus, new Substance('z', 'c', 3));
    expect(materializeRange(corpus, 1, 2)).toEqual([{ code: 'y', denomination: 'b', medicaments_count: 2 }]);
  });

  it('buildIndexDocument omet chaînes vides et tableaux vides', () => {
    const corpus = createCorpus();
    push(
      corpus,
      Presentation.fromCsv(
        emptyCsv(BDPM_SCHEMAS.presentations, { cis: '1', libelle: 'X' })
      )
    );
    expect(buildIndexDocument(corpus[0], 0, ['cis', 'libelle'])).toEqual({
      id: 0,
      cis: '1',
      libelle: 'X'
    });
    expect(buildIndexDocument({ tags: [] }, 0, ['tags'])).toEqual({ id: 0 });
  });
});

describe('rankAndMaterializeSearch', () => {
  it('ajoute match_quality sur l’objet réponse, pas sur l’instance', () => {
    const corpus = [
      Specialite.fromCsv(
        emptyCsv(BDPM_SCHEMAS.specialites, { cis: '123', denomination: 'DOLIPRANE' })
      )
    ];
    const results = [{ id: 0, score: 10 }];
    const out = rankAndMaterializeSearch(corpus, results, 'doliprane', {
      primaryField: 'denomination',
      idField: 'cis'
    });
    expect(out).toHaveLength(1);
    expect(out[0].denomination).toBe('DOLIPRANE');
    expect(out[0].match_quality).toBeDefined();
    expect(corpus[0].match_quality).toBeUndefined();
  });

  it('lit les champs stockés sur l’instance (pas via toJSON)', () => {
    const corpus = [Mitm.fromCsv(emptyCsv(BDPM_SCHEMAS.mitm, { cis: '99', denomination: 'XYZ' }))];
    const out = rankAndMaterializeSearch(corpus, [{ id: 0, score: 1 }], 'xyz', {
      primaryField: 'denomination',
      idField: 'cis'
    });
    expect(out[0].cis).toBe('99');
  });
});

describe('MedicamentVet', () => {
  it('lien_rcp via getter quand maj_rcp est renseigné', () => {
    const m = new MedicamentVet(
      '0001234',
      'Mon médicament',
      '',
      '',
      '',
      [],
      [],
      '2024-01-01'
    );
    expect(m.lien_rcp).toContain('NomMedicament=');
    const json = m.toJSON();
    expect(json.lien_rcp).toBe(m.lien_rcp);
    expect(json.maj_rcp).toBe('2024-01-01');
  });

  it('sans maj_rcp : pas de lien_rcp dans toJSON', () => {
    const m = new MedicamentVet('1', 'X', '', '', '', [], [], '');
    expect(m.toJSON()).toEqual({ num: '1', nom: 'X' });
  });

  it('FIELD_NAMES aligné sur VET_SCHEMAS.medicaments', () => {
    expect(MedicamentVet.FIELD_NAMES).toEqual(VET_SCHEMAS.medicaments);
  });
});

describe('tableaux vétérinaires', () => {
  it('codes_atcvet et especes sont toujours des tableaux sur l’instance', () => {
    const m = new MedicamentVet('1', 'X', '', '', '', null, undefined, '');
    expect(m.codes_atcvet).toEqual([]);
    expect(m.especes).toEqual([]);
    expect(m.toJSON()).toEqual({ num: '1', nom: 'X' });
  });

  it('conditions_delivrance sur PresentationVet', () => {
    const p = new PresentationVet('1', 'lib', '', null);
    expect(p.conditions_delivrance).toEqual([]);
    expect(PresentationVet.FIELD_NAMES).toEqual(VET_SCHEMAS.presentations);
  });
});

describe('Substance', () => {
  it('medicaments_count est un nombre mutable', () => {
    const s = new Substance('C', 'D', 0);
    expect(s.toJSON()).toEqual({ code: 'C', denomination: 'D', medicaments_count: 0 });
    s.medicaments_count++;
    expect(s.toJSON().medicaments_count).toBe(1);
  });
});

describe('TempsAttenteEntry', () => {
  it('toJSON omet les champs vides', () => {
    const e = new TempsAttenteEntry('voie', '', 'denree', '1', '');
    expect(e.toJSON()).toEqual({ voie: 'voie', denree: 'denree', quantite: '1' });
  });
});

describe('materializeIndices', () => {
  it('matérialise les indices demandés', () => {
    const corpus = createCorpus();
    push(corpus, new CompositionVet('1', 'A', '', ''));
    push(corpus, new CompositionVet('1', 'B', '', ''));
    const out = materializeIndices(corpus, [1]);
    expect(out).toEqual([{ num: '1', substance: 'B' }]);
  });
});
