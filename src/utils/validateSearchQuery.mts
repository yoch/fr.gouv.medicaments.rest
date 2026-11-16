import type { Request, Response, NextFunction } from 'express';

// Borne aussi l'allocation quadratique d'une recherche floue sur un seul terme.
const MAX_SEARCH_QUERY_LENGTH = 512;
const SCALAR_SEARCH_PARAMS = ['q', 'source', 'format', 'detail', 'dosage', 'forme', 'voie'] as const;

function validateSearchQuery(req: Request, res: Response, next: NextFunction): unknown {
  const query = req.query as Record<string, unknown>;
  for (let i = 0; i < SCALAR_SEARCH_PARAMS.length; i++) {
    const name = SCALAR_SEARCH_PARAMS[i];
    const value = query[name];
    if (value != null && typeof value !== 'string') {
      return res.status(400).json({ error: `Le paramètre "${name}" doit être une chaîne unique` });
    }
  }
  const q = query.q;
  if (typeof q === 'string' && q.length > MAX_SEARCH_QUERY_LENGTH) {
    return res.status(400).json({ error: `La recherche "q" est limitée à ${MAX_SEARCH_QUERY_LENGTH} caractères` });
  }
  next();
}

export { validateSearchQuery };
