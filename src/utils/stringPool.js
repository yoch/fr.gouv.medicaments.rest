'use strict';

/**
 * Pool global d'interning des strings : déduplique les valeurs string répétées
 * (champs BDPM/vétérinaire à faible cardinalité) pour réduire le résident et
 * le garbage transient au chargement.
 *
 * V8 n'interne pas les strings heap issues d'I/O ; un pool explicite Map<string,string>
 * est l'approche idiomatique (O(1), dédup par référence). Le pool conserve une seule
 * référence par valeur distincte ; les copies deviennent garbage et sont collectées.
 */

const pool = new Map();

/**
 * Retourne la réf poolée pour `s` (la crée si absente). Null/empty passent à travers.
 * @param {string|undefined|null} s
 * @returns {string}
 */
function intern(s) {
  if (s == null || s === '') return s;
  const cached = pool.get(s);
  if (cached !== undefined) return cached;
  pool.set(s, s);
  return s;
}

/** Taille courante du pool (nb de valeurs distinctes). */
function internPoolSize() {
  return pool.size;
}

/** Vide le pool (tests / reset entre cycles de load). */
function clearInternPool() {
  pool.clear();
}

module.exports = {
  intern,
  internPoolSize,
  clearInternPool
};
