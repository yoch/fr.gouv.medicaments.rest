'use strict';

const {
  createStore,
  pushFromRecord,
  getRowValue,
  toObject,
  toObjects,
  buildIndexDocumentFromRow,
  indexFieldIndices,
  keyIndex,
  appendToKeyList,
  buildKeyIndex,
  materializeRowRange,
  pushRow
} = require('../src/utils/rowStore');

describe('rowStore', () => {
  it('aligne les valeurs sur keys et matérialise un objet', () => {
    const store = createStore(['cis', 'denomination']);
    pushFromRecord(store, { cis: '123', denomination: 'TEST' });
    expect(store.rows[0]).toEqual(['123', 'TEST']);
    expect(toObject(store, 0)).toEqual({ cis: '123', denomination: 'TEST' });
  });

  it('ommet les cellules vides à la matérialisation', () => {
    const store = createStore(['a', 'b']);
    pushFromRecord(store, { a: 'x', b: '' });
    expect(toObject(store, 0)).toEqual({ a: 'x' });
  });

  it('conserve les tableaux imbriqués en slot', () => {
    const store = createStore(['tags']);
    const tags = ['a', 'b'];
    pushFromRecord(store, { tags });
    expect(toObject(store, 0)).toEqual({ tags });
  });

  it('buildIndexDocumentFromRow n’inclut que les champs indexés non vides', () => {
    const store = createStore(['cis', 'libelle', 'extra']);
    pushFromRecord(store, { cis: '1', libelle: 'X', extra: 'ignored' });
    const idx = indexFieldIndices(store, ['cis', 'libelle']);
    expect(buildIndexDocumentFromRow(store, 0, idx)).toEqual({
      id: 0,
      cis: '1',
      libelle: 'X'
    });
  });

  it('appendToKeyList regroupe les indices par clé', () => {
    const map = new Map();
    appendToKeyList(map, 'A', 0);
    appendToKeyList(map, 'A', 1);
    expect(map.get('A')).toEqual([0, 1]);
    expect(toObjects(createStore(['x']), [0, 1])).toHaveLength(2);
  });

  it('getRowValue lit par index de colonne', () => {
    const store = createStore(['cis', 'nom']);
    pushFromRecord(store, { cis: '99', nom: 'Y' });
    expect(getRowValue(store, 0, keyIndex(store, 'nom'))).toBe('Y');
  });

  it('pushRow évite un objet intermédiaire', () => {
    const store = createStore(['a', 'b']);
    pushRow(store, ['1', '2']);
    expect(store.rows[0]).toEqual(['1', '2']);
  });

  it('buildKeyIndex unique et multi', () => {
    const store = createStore(['k', 'v']);
    pushRow(store, ['A', '1']);
    pushRow(store, ['A', '2']);
    pushRow(store, ['B', '3']);
    const multi = buildKeyIndex(store, 'k');
    expect(multi.get('A')).toEqual([0, 1]);
    const unique = buildKeyIndex(store, 'k', { unique: true });
    expect(unique.get('B')).toBe(2);
  });

  it('materializeRowRange ne matérialise que la plage demandée', () => {
    const store = createStore(['x']);
    pushRow(store, ['a']);
    pushRow(store, ['b']);
    pushRow(store, ['c']);
    expect(materializeRowRange(store, 1, 2)).toEqual([{ x: 'b' }]);
  });
});
