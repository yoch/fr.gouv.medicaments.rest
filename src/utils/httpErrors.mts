/**
 * Erreur levée pour un statut HTTP hors 2xx/3xx. `response.status` conserve la
 * forme que les appelants (et les tests) lisaient sur les erreurs d'axios.
 */
class HttpStatusError extends Error {
  status: number;
  response: { status: number };

  constructor(status: number) {
    super(`Request failed with status code ${status}`);
    this.name = 'HttpStatusError';
    this.status = status;
    this.response = { status };
  }
}

export interface TimeoutError extends Error {
  code: 'ETIMEDOUT';
}

/** Délai dépassé ; passé en motif d'`abort()`, `fetch` la rejette telle quelle. */
function timeoutError(message: string): TimeoutError {
  const error = new Error(message) as TimeoutError;
  error.name = 'TimeoutError';
  error.code = 'ETIMEDOUT';
  return error;
}

/** Abandonne le corps d'une réponse sans le lire : ferme la connexion si besoin. */
async function discardBody(response: { body?: { cancel?: () => Promise<unknown> } | null } | null | undefined): Promise<void> {
  try {
    await response?.body?.cancel?.();
  } catch {
    // Le corps est déjà fermé ou en erreur : rien d'autre à libérer.
  }
}

interface ErrorLike {
  message?: string;
  cause?: {
    message?: string;
    code?: string;
    errors?: Array<{ message?: string } | null | undefined>;
  };
}

/**
 * Message de journal d'une erreur réseau : `fetch` ne donne que « fetch failed »
 * et range la cause (DNS, refus de connexion, certificat…) dans `error.cause`.
 * Sur un hôte IPv4 + IPv6, la cause est une AggregateError au message vide.
 */
function describeError(error: unknown): string {
  const err = error as ErrorLike | null | undefined;
  const cause = err?.cause;
  const detail =
    cause?.message ||
    cause?.errors
      ?.map((e) => e?.message)
      .filter((msg): msg is string => Boolean(msg))
      .join(' ; ') ||
    cause?.code;
  const message = err?.message ?? String(error);
  return detail && !message.includes(detail) ? `${message} (${detail})` : message;
}

export { HttpStatusError, timeoutError, discardBody, describeError };
