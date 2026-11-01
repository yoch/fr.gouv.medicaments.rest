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

/** Abandonne le corps d'une réponse sans le lire : ferme la connexion si besoin. */
async function discardBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Le corps est déjà fermé ou en erreur : rien d'autre à libérer.
  }
}

module.exports = { HttpStatusError, discardBody };
