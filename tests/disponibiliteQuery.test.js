'use strict';

const {
  parseBdpmDate,
  parseQueryDate,
  parseDisponibiliteFilters,
  rowMatchesDisponibiliteFilters,
  buildDisponibiliteAlertId,
  isDisponibiliteAlertId,
  mapRowToDisponibiliteAlert,
  formatBdpmDateIso
} = require('../src/utils/disponibiliteQuery');
const { normalizeAnsmUrl } = require('../src/utils/ansmUrl');

describe('disponibiliteQuery', () => {
  test('parseBdpmDate accepte JJ/MM/AAAA', () => {
    expect(parseBdpmDate('10/07/2026').toISOString().slice(0, 10)).toBe('2026-07-10');
    expect(parseBdpmDate('')).toBeNull();
    expect(parseBdpmDate('2026-07-10')).toBeNull();
  });

  test('parseQueryDate accepte les deux formats', () => {
    expect(parseQueryDate('10/07/2026').toISOString().slice(0, 10)).toBe('2026-07-10');
    expect(parseQueryDate('2026-07-10').toISOString().slice(0, 10)).toBe('2026-07-10');
  });

  test('parseDisponibiliteFilters détecte les filtres exacts', () => {
    expect(parseDisponibiliteFilters({}).hasExactFilters).toBe(false);
    expect(parseDisponibiliteFilters({ cis: '123' }).hasExactFilters).toBe(true);
    expect(parseDisponibiliteFilters({ code_statut: '2' }).code_statut).toBe('2');
    expect(parseDisponibiliteFilters({ lien_ansm: 'https://ansm.sante.fr/x' }).hasExactFilters).toBe(
      true
    );
  });

  test('lien_ansm invalide / date invalide ne comptent pas comme filtres effectifs', () => {
    const onlyBadDate = parseDisponibiliteFilters({ date_mise_a_jour_min: 'pas-une-date' });
    expect(onlyBadDate.hasExactFilters).toBe(false);
    expect(onlyBadDate.date_mise_a_jour_min).toBeUndefined();

    const goodLien = parseDisponibiliteFilters({
      lien_ansm: 'https://ansm.sante.fr/disponibilites-des-produits-de-sante/medicaments/foo'
    });
    expect(goodLien.lien_ansm).toBe(
      'https://ansm.sante.fr/disponibilites-des-produits-de-sante/medicaments/foo'
    );
    expect(goodLien.lienFilterInvalid).toBe(false);
  });

  test('lienFilterInvalid produit une sélection vide (défense service)', () => {
    jest.resetModules();
    jest.doMock('../src/utils/ansmUrl', () => ({
      normalizeAnsmUrl: () => ''
    }));
    const { parseDisponibiliteFilters: parse } = require('../src/utils/disponibiliteQuery');
    const { selectRuptureIndices } = require('../src/services/bdpm/disponibiliteService');
    const filters = parse({ lien_ansm: 'https://ansm.sante.fr/x' });
    expect(filters.lienFilterInvalid).toBe(true);
    expect(filters.hasExactFilters).toBe(true);
    expect(selectRuptureIndices({ filters })).toEqual([]);
    jest.dontMock('../src/utils/ansmUrl');
    jest.resetModules();
  });

  test('normalizeAnsmUrl ignore www, query, hash et slash final', () => {
    expect(
      normalizeAnsmUrl(
        'https://www.ansm.sante.fr/disponibilites-des-produits-de-sante/medicaments/foo/?utm=1#x'
      )
    ).toBe('https://ansm.sante.fr/disponibilites-des-produits-de-sante/medicaments/foo');
  });

  test('rowMatchesDisponibiliteFilters filtre cis / code / date / lien_ansm', () => {
    const row = {
      cis: '60000001',
      cip13: '',
      code_statut: '1',
      date_mise_a_jour: '10/07/2026',
      lien_ansm: 'https://ansm.sante.fr/disponibilites-des-produits-de-sante/medicaments/foo'
    };
    expect(
      rowMatchesDisponibiliteFilters(row, parseDisponibiliteFilters({ cis: '60000001' }))
    ).toBe(true);
    expect(
      rowMatchesDisponibiliteFilters(row, parseDisponibiliteFilters({ cis: '60000002' }))
    ).toBe(false);
    expect(
      rowMatchesDisponibiliteFilters(row, parseDisponibiliteFilters({ code_statut: '2' }))
    ).toBe(false);
    expect(
      rowMatchesDisponibiliteFilters(
        row,
        parseDisponibiliteFilters({ date_mise_a_jour_min: '2026-07-01' })
      )
    ).toBe(true);
    expect(
      rowMatchesDisponibiliteFilters(
        row,
        parseDisponibiliteFilters({ date_mise_a_jour_min: '2026-07-11' })
      )
    ).toBe(false);
    expect(
      rowMatchesDisponibiliteFilters(
        row,
        parseDisponibiliteFilters({
          lien_ansm:
            'https://www.ansm.sante.fr/disponibilites-des-produits-de-sante/medicaments/foo/'
        })
      )
    ).toBe(true);
    expect(
      rowMatchesDisponibiliteFilters(
        row,
        parseDisponibiliteFilters({
          lien_ansm: 'https://ansm.sante.fr/disponibilites-des-produits-de-sante/medicaments/bar'
        })
      )
    ).toBe(false);
  });

  test('alert id = hash court opaque de cis:cip13:url', () => {
    const row = {
      cis: '60000001',
      cip13: '',
      lien_ansm: 'https://www.ansm.sante.fr/disponibilites-des-produits-de-sante/medicaments/foo/'
    };
    const id = buildDisponibiliteAlertId(row);
    expect(id).toMatch(/^[a-f0-9]{12}$/);
    expect(isDisponibiliteAlertId(id)).toBe(true);
    // Même URL normalisée (www / slash) → même id
    expect(
      buildDisponibiliteAlertId({
        ...row,
        lien_ansm: 'https://ansm.sante.fr/disponibilites-des-produits-de-sante/medicaments/foo'
      })
    ).toBe(id);
    expect(buildDisponibiliteAlertId({ ...row, cip13: '3400935955838' })).not.toBe(id);
  });

  test('mapRowToDisponibiliteAlert normalise les dates ISO', () => {
    const alert = mapRowToDisponibiliteAlert(
      {
        cis: '60000001',
        cip13: '',
        code_statut: '4',
        libelle_statut: 'Remise à disposition',
        date_mise_a_jour: '15/06/2026',
        date_remise_dispo: '15/06/2026',
        lien_ansm: 'https://ansm.sante.fr/x'
      },
      'SPECIALITE TEST'
    );
    expect(alert.medicine_name).toBe('SPECIALITE TEST');
    expect(alert.updated_at).toBe('2026-06-15');
    expect(alert.expected_return).toBe(formatBdpmDateIso('15/06/2026'));
    expect(alert.medical_domain).toBeUndefined();
  });
});
