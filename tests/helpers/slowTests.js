'use strict';

/**
 * Tests qui chargent tout le corpus BDPM (et parfois vet) — plusieurs dizaines de secondes.
 * Par défaut ignorés ; activer avec RUN_SLOW_TESTS=1 ou npm run test:integration.
 */
const RUN_SLOW_TESTS =
  process.env.RUN_SLOW_TESTS === '1' || process.env.RUN_SLOW_TESTS === 'true';

function describeSlow(name, fn) {
  return RUN_SLOW_TESTS ? describe(name, fn) : describe.skip(name, fn);
}

module.exports = {
  RUN_SLOW_TESTS,
  describeSlow
};
