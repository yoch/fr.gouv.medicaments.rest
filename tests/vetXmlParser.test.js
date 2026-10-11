'use strict';

const {
  createVetProductBlockParser,
  defaultProductParser,
  parseProductBlock,
  VET_SKIP_SCAN_TAGS
} = require('../src/utils/vetXmlParser');

describe('vetXmlParser', () => {
  it('garde les valeurs en texte, espaces normalisés et entités décodées', () => {
    const product = parseProductBlock(
      [
        '<medicinal-product>',
        '  <!-- commentaire -->',
        '  <num>0452300</num>',
        '  <nom>  A &amp; B\r\n  &lt;x&gt; </nom>',
        '  <voie-administration><voie-admin><qte-ta>0</qte-ta></voie-admin></voie-administration>',
        '  <composition><sa><quantite>8.0</quantite></sa></composition>',
        '  <atcvet-code />',
        '</medicinal-product>'
      ].join('\n'),
      defaultProductParser
    );

    expect(product).toEqual({
      num: '0452300',
      nom: 'A & B <x>',
      'voie-administration': { 'voie-admin': { 'qte-ta': '0' } },
      composition: { sa: { quantite: '8.0' } },
      'atcvet-code': ''
    });
  });

  it('regroupe les balises répétées en tableau', () => {
    const product = parseProductBlock(
      '<medicinal-product><num>1</num><nom>X</nom><especes><term-esp>16</term-esp><term-esp>22</term-esp></especes></medicinal-product>',
      defaultProductParser
    );
    expect(product.especes).toEqual({ 'term-esp': ['16', '22'] });
  });

  it('ignore les sous-arbres configurés, à toute profondeur', () => {
    const block = '<medicinal-product><num>1</num><nom>X</nom>'
      + '<rcp><paragraphes-rcp><p><b>texte</b></p></paragraphes-rcp></rcp>'
      + '<lien-rcp>http://x</lien-rcp></medicinal-product>';

    expect(parseProductBlock(block, defaultProductParser)).toEqual({ num: '1', nom: 'X', rcp: '' });
    expect(parseProductBlock(block, createVetProductBlockParser(VET_SKIP_SCAN_TAGS)))
      .toEqual({ num: '1', nom: 'X', rcp: '', 'lien-rcp': 'http://x' });
  });

  it('renvoie null sans num ni nom, ou si la racine n’est pas un médicament', () => {
    expect(parseProductBlock('<medicinal-product><num>1</num></medicinal-product>', defaultProductParser)).toBeNull();
    expect(parseProductBlock('<autre><num>1</num><nom>X</nom></autre>', defaultProductParser)).toBeNull();
  });

  it('ne crée pas de clé dangereuse et rejette un XML mal formé', () => {
    const product = parseProductBlock(
      '<medicinal-product><num>1</num><nom>X</nom><__proto__><polluted>1</polluted></__proto__></medicinal-product>',
      defaultProductParser
    );
    expect(Object.keys(product)).toEqual(['num', 'nom']);
    expect({}.polluted).toBeUndefined();

    expect(() => parseProductBlock('<medicinal-product><num>1</nom></medicinal-product>', defaultProductParser))
      .toThrow();
    expect(() => parseProductBlock('<medicinal-product/>')).toThrow('parser requis');
  });
});
