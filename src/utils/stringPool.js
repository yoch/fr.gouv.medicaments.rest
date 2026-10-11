'use strict';

/**
 * Pools d'interning des strings : dédupliquent les valeurs string répétées
 * (champs BDPM/vétérinaire à faible cardinalité) pour réduire le résident et
 * le garbage transient au chargement.
 *
 * V8 n'interne pas les strings heap issues d'I/O ; un pool explicite Map<string,string>
 * est l'approche idiomatique (O(1), dédup par référence). Le pool conserve une seule
 * référence par valeur distincte ; les copies deviennent garbage et sont collectées.
 */

const { AsyncLocalStorage } = require('node:async_hooks');
const activePool = new AsyncLocalStorage();
const defaultPool = new Map();
const domainPools = new Map();

/** Une génération par domaine : remplacer BDPM ne vide pas le pool vétérinaire. */
function withInternPool(domain, load) {
  const pool = new Map();
  domainPools.set(domain, pool);
  return activePool.run(pool, async () => {
    try {
      return await load();
    } catch (error) {
      if (domainPools.get(domain) === pool) domainPools.delete(domain);
      pool.clear();
      throw error;
    }
  });
}

/**
 * Retourne la réf poolée pour `s` (la crée si absente). Null/empty passent à travers.
 * @param {string|undefined|null} s
 * @returns {string}
 */
function intern(s) {
  if (s == null || s === '') return s;
  const pool = activePool.getStore() || defaultPool;
  const cached = pool.get(s);
  if (cached !== undefined) return cached;
  pool.set(s, s);
  return s;
}

/** Taille courante du pool (nb de valeurs distinctes). */
function internPoolSize() {
  let size = defaultPool.size;
  for (const pool of domainPools.values()) size += pool.size;
  return size;
}

/** Vide le pool (tests / reset entre cycles de load). */
function clearInternPool() {
  defaultPool.clear();
  for (const pool of domainPools.values()) pool.clear();
  domainPools.clear();
}

module.exports = {
  intern,
  internPoolSize,
  clearInternPool,
  withInternPool
};
