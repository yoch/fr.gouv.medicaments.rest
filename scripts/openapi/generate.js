'use strict';

/**
 * Génère `src/openapi.generated.json` à partir des annotations JSDoc des routes.
 * La spec est ainsi figée à la construction : le serveur (et le binaire Bun
 * compilé) ne dépend plus de swagger-jsdoc ni de la lecture de `src/routes`
 * au démarrage.
 *
 *   npm run generate:openapi
 */

const fs = require('node:fs');
const path = require('node:path');
const { buildOpenApiSpec } = require('./source');

const OUTPUT = path.resolve(__dirname, '..', '..', 'src', 'openapi.generated.json');

function render() {
  return `${JSON.stringify(buildOpenApiSpec(), null, 2)}\n`;
}

if (require.main === module) {
  fs.writeFileSync(OUTPUT, render());
  console.log(`Spec OpenAPI écrite : ${path.relative(process.cwd(), OUTPUT)}`);
}

module.exports = { render, OUTPUT };
