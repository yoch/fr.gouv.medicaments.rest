'use strict';

/**
 * Normalise une URL de fiche ANSM pour jointure / indexation.
 * Aligné sur l’audit export ANSM ↔ BDPM (strip www, hash, query, slash final).
 */
function normalizeAnsmUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(String(value).trim());
    url.hostname = url.hostname.replace(/^www\./, '');
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return String(value).trim();
  }
}

module.exports = { normalizeAnsmUrl };
