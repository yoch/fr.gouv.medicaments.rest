'use strict';

const { intern, internPoolSize, clearInternPool, withInternPool } = require('../src/utils/stringPool');

afterEach(clearInternPool);

test('remplace les valeurs historiques sans vider le domaine voisin', async () => {
  await withInternPool('bdpm', () => { intern('humain'); });
  for (let cycle = 0; cycle < 3; cycle++) {
    await withInternPool('vet', async () => {
      await Promise.resolve();
      for (let n = 0; n < 100; n++) intern(`veterinaire-${cycle}-${n}`);
    });
    expect(internPoolSize()).toBe(101);
  }
});

test('isole des chargements async des deux domaines et libère un pool échoué', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const human = withInternPool('bdpm', async () => {
    intern('avant');
    await gate;
    intern('apres');
  });
  await withInternPool('vet', () => { intern('animal'); });
  release();
  await human;
  expect(internPoolSize()).toBe(3);
  await expect(withInternPool('bdpm', async () => {
    intern('generation-incomplete');
    throw new Error('load failed');
  })).rejects.toThrow('load failed');
  expect(internPoolSize()).toBe(1);
});
