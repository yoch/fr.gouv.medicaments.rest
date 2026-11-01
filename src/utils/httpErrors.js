'use strict';

/**
 * Erreur levée pour un statut HTTP hors 2xx/3xx. `response.status` conserve la
 * forme que les appelants (et les tests) lisaient sur les erreurs d'axios.
 */
class HttpStatusError extends Error {
  constructor(status) {
    super(`Request failed with status code ${status}`);
    this.name = 'HttpStatusError';
    this.status = status;
    this.response = { status };
  }
}

/** Délai dépassé ; passé en motif d'`abort()`, `fetch` la rejette telle quelle. */
function timeoutError(message) {
  return Object.assign(new Error(message), { name: 'TimeoutError', code: 'ETIMEDOUT' });
}

/** Abandonne le corps d'une réponse sans le lire : ferme la connexion si besoin. */
async function discardBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Le corps est déjà fermé ou en erreur : rien d'autre à libérer.
  }
}

/**
 * Message de journal d'une erreur réseau : `fetch` ne donne que « fetch failed »
 * et range la cause (DNS, refus de connexion, certificat…) dans `error.cause`.
 * Sur un hôte IPv4 + IPv6, la cause est une AggregateError au message vide.
 */
function describeError(error) {
  const cause = error?.cause;
  const detail = cause?.message
    || cause?.errors?.map(e => e?.message).filter(Boolean).join(' ; ')
    || cause?.code;
  const message = error?.message ?? String(error);
  return detail && !message.includes(detail) ? `${message} (${detail})` : message;
}

module.exports = { HttpStatusError, timeoutError, discardBody, describeError };
