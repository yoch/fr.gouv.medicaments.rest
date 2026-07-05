'use strict';

const {
  stripIgnoredProductTags
} = require('../src/utils/streamMedicinalProductsXml');

describe('streamMedicinalProductsXml', () => {
  it('supprime les sous-arbres ignorés sur plusieurs chunks', () => {
    const state = { skipTag: null };
    const first = stripIgnoredProductTags(
      '<medicinal-product><num>1</num><paragraphes-rcp><p>texte',
      state,
      ['paragraphes-rcp', 'lien-rcp']
    );
    const second = stripIgnoredProductTags(
      '</p></paragraphes-rcp><lien-rcp>http://x</lien-rcp><nom>TEST</nom></medicinal-product>',
      state,
      ['paragraphes-rcp', 'lien-rcp']
    );

    expect(first + second).toBe(
      '<medicinal-product><num>1</num><nom>TEST</nom></medicinal-product>'
    );
  });

  it('peut conserver lien-rcp pour les scans de vérification', () => {
    const state = { skipTag: null };
    const xml = stripIgnoredProductTags(
      '<medicinal-product><paragraphes-rcp>long</paragraphes-rcp><lien-rcp>http://x</lien-rcp></medicinal-product>',
      state,
      ['paragraphes-rcp']
    );

    expect(xml).toBe(
      '<medicinal-product><lien-rcp>http://x</lien-rcp></medicinal-product>'
    );
  });
});
