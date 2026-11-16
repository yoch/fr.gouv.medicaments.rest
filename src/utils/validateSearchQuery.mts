import type { Request, Response, NextFunction } from 'express';

// Borne aussi l'allocation quadratique d'une recherche floue sur un seul terme.
const MAX_SEARCH_QUERY_LENGTH = 512;
const SCALAR_SEARCH_PARAMS = ['q', 'source', 'format', 'detail', 'dosage', 'forme', 'voie'] as const;

export interface SearchParamLookup {
  value: unknown;
  isMultiple?: boolean;
}

/**
 * Valide les paramètres scalaires de recherche (unicité et longueur max de `q`).
 * Retourne un message d'erreur lisible si invalide, sinon `null`.
 */
function validateSearchQueryParams(
  lookup: (name: (typeof SCALAR_SEARCH_PARAMS)[number]) => SearchParamLookup
): string | null {
  for (let i = 0; i < SCALAR_SEARCH_PARAMS.length; i++) {
    const name = SCALAR_SEARCH_PARAMS[i];
    const { value, isMultiple } = lookup(name);
    if (isMultiple || (value != null && typeof value !== 'string')) {
      return `Le paramètre "${name}" doit être une chaîne unique`;
    }
  }
  const q = lookup('q').value;
  if (typeof q === 'string' && q.length > MAX_SEARCH_QUERY_LENGTH) {
    return `La recherche "q" est limitée à ${MAX_SEARCH_QUERY_LENGTH} caractères`;
  }
  return null;
}

function validateSearchQuery(req: Request, res: Response, next: NextFunction): unknown {
  const query = req.query as Record<string, unknown>;
  const error = validateSearchQueryParams((name) => ({ value: query[name] }));
  if (error) {
    return res.status(400).json({ error });
  }
  next();
}

export { validateSearchQuery, validateSearchQueryParams, SCALAR_SEARCH_PARAMS, MAX_SEARCH_QUERY_LENGTH };
