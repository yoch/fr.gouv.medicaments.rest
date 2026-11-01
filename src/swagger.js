// Spec OpenAPI pré-générée par `npm run generate:openapi` (scripts/openapi/).
const { version } = require('../package.json');
const spec = require('./openapi.generated.json');

module.exports = { ...spec, info: { ...spec.info, version } };
