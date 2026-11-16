/**
 * Pools d'interning des strings : dédupliquent les valeurs string répétées
 * (champs BDPM/vétérinaire à faible cardinalité) pour réduire le résident et
 * le garbage transient au chargement.
 *
 * V8 n'interne pas les strings heap issues d'I/O ; un pool explicite Map<string,string>
 * est l'approche idiomatique (O(1), dédup par référence). Le pool conserve une seule
 * référence par valeur distincte ; les copies deviennent garbage et sont collectées.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const activePool = new AsyncLocalStorage<Map<string, string>>();
const defaultPool = new Map<string, string>();
const domainPools = new Map<string, Map<string, string>>();

/** Une génération par domaine : remplacer BDPM ne vide pas le pool vétérinaire. */
function withInternPool<T>(domain: string, load: () => Promise<T> | T): Promise<T> {
  const pool = new Map<string, string>();
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
 */
function intern<T>(s: T): T {
  if (typeof s !== 'string' || s === '') return s;
  const pool = activePool.getStore() || defaultPool;
  const cached = pool.get(s);
  if (cached !== undefined) return cached as unknown as T;
  pool.set(s, s);
  return s;
}

/** Taille courante du pool (nb de valeurs distinctes). */
function internPoolSize(): number {
  let size = defaultPool.size;
  for (const pool of domainPools.values()) size += pool.size;
  return size;
}

/** Vide le pool (tests / reset entre cycles de load). */
function clearInternPool(): void {
  defaultPool.clear();
  for (const pool of domainPools.values()) pool.clear();
  domainPools.clear();
}

export {
  intern,
  internPoolSize,
  clearInternPool,
  withInternPool
};
