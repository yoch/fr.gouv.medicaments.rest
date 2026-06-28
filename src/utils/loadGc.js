'use strict';

/**
 * GC optionnel pour les scripts de profilage mémoire.
 * Nécessite `node --expose-gc` (active `global.gc`).
 * Hors chemin runtime prod.
 */

let missingExposeGcWarned = false;

function gcBeforeMeasure(step) {
  if (typeof global.gc !== 'function') {
    if (!missingExposeGcWarned) {
      console.warn(
        'GC demandé mais global.gc indisponible — lancer Node avec --expose-gc'
      );
      missingExposeGcWarned = true;
    }
    return;
  }
  global.gc();
  if (step) console.log(`[gc] ${step}`);
}

module.exports = { gcBeforeMeasure };
