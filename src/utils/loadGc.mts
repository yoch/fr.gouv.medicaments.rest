/**
 * GC optionnel pour les scripts de profilage mémoire.
 * Nécessite `node --expose-gc` (active `global.gc`).
 * Hors chemin runtime prod.
 */

let missingExposeGcWarned = false;

function gcBeforeMeasure(step?: string): void {
  const globalWithGc = globalThis as typeof globalThis & { gc?: () => void };
  if (typeof globalWithGc.gc !== 'function') {
    if (!missingExposeGcWarned) {
      console.warn(
        'GC demandé mais global.gc indisponible — lancer Node avec --expose-gc'
      );
      missingExposeGcWarned = true;
    }
    return;
  }
  globalWithGc.gc();
  if (step) console.log(`[gc] ${step}`);
}

export { gcBeforeMeasure };
