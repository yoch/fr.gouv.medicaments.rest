'use strict';

const {
  stripIgnoredProductTags,
  streamMedicinalProducts
} = require('../src/utils/streamMedicinalProductsXml');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('streamMedicinalProductsXml', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vet-stream-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function readProducts(xml, options) {
    const file = path.join(tempDir, 'products.xml');
    fs.writeFileSync(file, xml);
    const products = [];
    await streamMedicinalProducts(file, (block) => products.push(block), options);
    return products;
  }

  it.each(['\n', '\r\n', '\r'])('préserve les produits et les lignes (%j), y compris sans newline final', async (newline) => {
    const products = await readProducts([
      '<medicinal-product-group>',
      '<medicinal-product><num>1</num>',
      '<nom>Éléphant &amp; chat</nom>',
      '<paragraphes-rcp>',
      '<p>Texte ignoré</p>',
      '</paragraphes-rcp>',
      '<lien-rcp>http://x</lien-rcp>',
      '</medicinal-product>',
      '<medicinal-product><num>2</num><nom>Autre</nom></medicinal-product>'
    ].join(newline));

    expect(products).toEqual([
      '<medicinal-product><num>1</num>\n<nom>Éléphant &amp; chat</nom>\n\n\n</medicinal-product>',
      '<medicinal-product><num>2</num><nom>Autre</nom></medicinal-product>'
    ]);
  });

  it('sépare plusieurs produits ouverts ou fermés sur une même ligne', async () => {
    const products = await readProducts([
      '<medicinal-product-group><medicinal-product><num>1</num><nom>A</nom></medicinal-product><medicinal-product><num>2</num>',
      '<nom>B</nom>',
      '</medicinal-product><medicinal-product><num>3</num><nom>C</nom></medicinal-product> <medicinal-product><num>4</num>',
      '</medicinal-product></medicinal-product-group>'
    ].join('\n'));

    expect(products).toEqual([
      '<medicinal-product><num>1</num><nom>A</nom></medicinal-product>',
      '<medicinal-product><num>2</num>\n<nom>B</nom>\n</medicinal-product>',
      '<medicinal-product><num>3</num><nom>C</nom></medicinal-product>',
      '<medicinal-product><num>4</num>\n</medicinal-product>'
    ]);
  });

  it('gère un CRLF et un caractère UTF-8 coupés à la frontière de lecture', async () => {
    const prefix = '<medicinal-product><num>1</num>\n<nom>';
    // Le ReadStream lit 64 Kio ; le premier octet de é est à l'offset 65535.
    const padding = 'x'.repeat(65535 - Buffer.byteLength(prefix));
    const xml = prefix + padding + 'é</nom>\n</medicinal-product>';
    expect(await readProducts(xml)).toEqual([xml]);

    const crlfXml = prefix + padding + '\r\n</nom>\r\n</medicinal-product>\r';
    expect(await readProducts(crlfXml)).toEqual([
      prefix + padding + '\n</nom>\n</medicinal-product>'
    ]);
  });

  it('attend le callback de chaque produit avant de livrer le suivant', async () => {
    const file = path.join(tempDir, 'products.xml');
    fs.writeFileSync(file, '<medicinal-product><num>1</num></medicinal-product>\n<medicinal-product><num>2</num></medicinal-product>');
    const events = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let firstStarted;
    const started = new Promise((resolve) => { firstStarted = resolve; });
    const loading = streamMedicinalProducts(file, async (block) => {
      events.push(block.includes('<num>1</num>') ? 1 : 2);
      if (events.length === 1) {
        firstStarted();
        await gate;
      }
    });
    await started;
    expect(events).toEqual([1]);
    release();
    await loading;
    expect(events).toEqual([1, 2]);
  });

  it('propage les erreurs de lecture et de callback', async () => {
    await expect(streamMedicinalProducts(path.join(tempDir, 'absent.xml'), () => {}))
      .rejects.toMatchObject({ code: 'ENOENT' });
    const file = path.join(tempDir, 'products.xml');
    fs.writeFileSync(file, '<medicinal-product><num>1</num></medicinal-product>');
    const error = new Error('callback failed');
    await expect(streamMedicinalProducts(file, () => { throw error; })).rejects.toBe(error);
  });

  it('rejette les lignes géantes et les produits non fermés au lieu de les accumuler', async () => {
    await expect(readProducts('x'.repeat(100), { maxLineChars: 50 }))
      .rejects.toThrow('Ligne ANMV trop longue');
    await expect(readProducts('<medicinal-product>\n' + 'x\n'.repeat(100), { maxProductChars: 50 }))
      .rejects.toThrow('Produit ANMV trop volumineux');
  });

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
