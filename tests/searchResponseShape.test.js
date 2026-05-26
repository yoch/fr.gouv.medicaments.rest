const {
  shapeSearchHit,
  normalizeDetail
} = require('../src/utils/searchResponseShape');
const {
  renderSearchMarkdown,
  normalizeFormat,
  formatMatchLine,
  formatSubstances,
  getSubstances
} = require('../src/utils/searchMarkdown');

describe('searchResponseShape', () => {
  const fullHit = {
    type: 'medicament',
    cis: '60234100',
    denomination: 'DOLIPRANE 1000 mg, comprimé',
    match_quality: 'prefix',
    forme_pharma: 'comprimé',
    voies_admin: 'orale',
    statut_amm: 'Autorisation active',
    type_amm: 'Procédure nationale',
    commercialisation: 'Commercialisée',
    date_amm: '09/07/2002',
    titulaire: 'OPELLA',
    surveillance_renforcee: 'Non',
    url_bdpm: 'https://example.test/60234100/extrait',
    presentations: [
      {
        cis: '60234100',
        libelle: 'plaquette 8 cp',
        cip13: '3400935955838',
        taux_remboursement: '65%',
        etat_commercialisation: 'Déclaration',
        cip7: 'x',
        honoraires: '1'
      },
      { cis: '60234100', libelle: 'plaquette 16 cp', cip13: '3400999999999' },
      { cis: '60234100', libelle: 'plaquette 24 cp' },
      { cis: '60234100', libelle: 'plaquette 32 cp' }
    ],
    compositions: [
      {
        cis: '60234100',
        denomination_substance: 'PARACÉTAMOL',
        dosage: '1000 mg',
        nature_composant: 'SA',
        numero_ordre: '1'
      }
    ]
  };

  it('normalizeDetail defaults unknown to full', () => {
    expect(normalizeDetail()).toBe('full');
    expect(normalizeDetail('summary')).toBe('summary');
    expect(normalizeDetail('invalid')).toBe('full');
  });

  it('detail=full returns hit unchanged', () => {
    expect(shapeSearchHit(fullHit, { detail: 'full' })).toBe(fullHit);
    expect(shapeSearchHit(fullHit, { detail: 'full' }).compositions).toBeDefined();
  });

  it('detail=summary strips nested fields and caps presentations', () => {
    const summary = shapeSearchHit(fullHit, { detail: 'summary' });
    expect(summary.statut_amm).toBeUndefined();
    expect(summary.compositions).toBeUndefined();
    expect(summary.substances).toEqual([
      { denomination: 'PARACÉTAMOL', dosage: '1000 mg', nature: 'SA' }
    ]);
    expect(summary.presentations_count).toBe(4);
    expect(summary.presentations).toHaveLength(3);
    expect(summary.presentations[0].cis).toBeUndefined();
    expect(summary.presentations[0].cip13).toBe('3400935955838');
  });
});

describe('searchMarkdown', () => {
  it('normalizeFormat defaults unknown to json', () => {
    expect(normalizeFormat()).toBe('json');
    expect(normalizeFormat('markdown')).toBe('markdown');
    expect(normalizeFormat('xml')).toBe('json');
  });

  it('formatSubstances joins with comma', () => {
    expect(
      formatSubstances([
        { denomination: 'PARACÉTAMOL', dosage: '500 mg', nature: 'SA' },
        { denomination: 'CODÉINE', dosage: '30 mg', nature: 'SA' }
      ])
    ).toBe('PARACÉTAMOL 500 mg (SA), CODÉINE 30 mg (SA)');
  });

  it('formatMatchLine shows via for all match qualities', () => {
    expect(formatMatchLine({ match_quality: 'prefix' })).toBe('- Match: prefix');
    expect(
      formatMatchLine({ match_quality: 'prefix', match_via: 'denomination' })
    ).toBe('- Match: prefix (sur dénomination)');
    expect(
      formatMatchLine({
        match_quality: 'exact',
        match_via: 'composition'
      })
    ).toBe('- Match: exact (sur composition)');
  });

  it('getSubstances derives from compositions when substances absent', () => {
    const derived = getSubstances({
      type: 'medicament',
      compositions: [
        { denomination_substance: 'PARACÉTAMOL', dosage: '500 mg', nature_composant: 'SA' }
      ]
    });
    expect(derived).toEqual([{ denomination: 'PARACÉTAMOL', dosage: '500 mg', nature: 'SA' }]);
  });

  it('getSubstances prefers substances over compositions', () => {
    const derived = getSubstances({
      type: 'medicament',
      substances: [{ denomination: 'IBUPROFÈNE', dosage: '400 mg', nature: 'SA' }],
      compositions: [
        { denomination_substance: 'PARACÉTAMOL', dosage: '500 mg', nature_composant: 'SA' }
      ]
    });
    expect(derived[0].denomination).toBe('IBUPROFÈNE');
  });

  it('renderSearchMarkdown uses presentation sub-bullets', () => {
    const md = renderSearchMarkdown(
      [
        {
          type: 'medicament',
          cis: '1',
          denomination: 'TEST',
          match_quality: 'prefix',
          substances: [{ denomination: 'SA', dosage: '10 mg' }],
          presentations_count: 2,
          presentations: [
            { libelle: 'boîte 8', cip13: '111' },
            { libelle: 'boîte 16', cip13: '222' }
          ]
        }
      ],
      { total: 1, page: 1 },
      { query: 'test' }
    );
    expect(md).toContain('- Présentations (2) :');
    expect(md).toContain('  - boîte 8 — CIP13 111');
    expect(md).toContain('  - boîte 16 — CIP13 222');
  });

  it('renderSearchMarkdown includes query and hits', () => {
    const md = renderSearchMarkdown(
      [
        {
          type: 'medicament',
          cis: '60234100',
          denomination: 'DOLIPRANE',
          match_quality: 'prefix',
          substances: [{ denomination: 'PARACÉTAMOL', dosage: '1000 mg', nature: 'SA' }],
          presentations_count: 1,
          presentations: [{ libelle: '8 cp', cip13: '3400935955838' }],
          url_bdpm: 'https://example.test/extrait'
        }
      ],
      { total: 1, page: 1 },
      { query: 'doliprane' }
    );
    expect(md).toContain('# BDPM — recherche « doliprane »');
    expect(md).toContain('CIS 60234100');
    expect(md).toContain('PARACÉTAMOL');
    expect(md).toContain('https://example.test/extrait');
  });
});
