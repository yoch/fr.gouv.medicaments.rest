'use strict';

// Borne aussi l'allocation quadratique d'une recherche floue sur un seul terme.
const MAX_SEARCH_QUERY_LENGTH = 512;
const SCALAR_SEARCH_PARAMS = ['q', 'source', 'format', 'detail', 'dosage', 'forme', 'voie'];

function validateSearchQuery(req, res, next) {
  for (const name of SCALAR_SEARCH_PARAMS) {
    const value = req.query[name];
    if (value != null && typeof value !== 'string') {
      return res.status(400).json({ error: `Le paramètre "${name}" doit être une chaîne unique` });
    }
  }
  if (req.query.q?.length > MAX_SEARCH_QUERY_LENGTH) {
    return res.status(400).json({ error: `La recherche "q" est limitée à ${MAX_SEARCH_QUERY_LENGTH} caractères` });
  }
  next();
}

module.exports = { validateSearchQuery };
