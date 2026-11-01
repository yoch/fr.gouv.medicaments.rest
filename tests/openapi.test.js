'use strict';

const fs = require('node:fs');
const { render, OUTPUT } = require('../scripts/openapi/generate');

test('src/openapi.generated.json correspond aux annotations des routes (npm run generate:openapi)', () => {
  expect(fs.readFileSync(OUTPUT, 'utf8')).toBe(render());
});

test('la spec expose les chemins annotés', () => {
  const spec = require('../src/swagger');
  expect(Object.keys(spec.paths).length).toBeGreaterThan(0);
  expect(spec.info.version).toBe(require('../package.json').version);
});
