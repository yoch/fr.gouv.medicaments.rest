import { MAX_TIMER_MS, validateTimerDelay } from './periodicTask.mts';
import { HttpStatusError, timeoutError, discardBody } from './httpErrors.mts';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (compatible; fr.gouv.medicaments.rest/1.1)';

export interface RemoteFingerprint {
  etag: string | null;
  lastModified: string | null;
  contentLength: number | null;
}

export interface FileCheckMeta {
  checkedAt?: string;
  downloadedAt?: string;
}

function parseIntervalHours(envValue: string | undefined, defaultHours: number): number {
  const parsed = parseInt(envValue ?? String(defaultHours), 10);
  const hours = Number.isFinite(parsed) && parsed > 0 ? parsed : defaultHours;
  if (hours * 60 * 60 * 1000 > MAX_TIMER_MS) {
    throw new RangeError('Intervalle de rafraîchissement supérieur à la limite des timers Node (596 heures)');
  }
  return hours;
}

function hoursSince(isoDate: string | undefined): number {
  if (!isoDate) return Infinity;
  return (Date.now() - new Date(isoDate).getTime()) / (1000 * 60 * 60);
}

function shouldRecheckFile(meta: FileCheckMeta | null | undefined, intervalHours: number): boolean {
  if (!meta) return true;
  const lastCheck = meta.checkedAt || meta.downloadedAt;
  if (!lastCheck) return true;
  return hoursSince(lastCheck) >= intervalHours;
}

/**
 * Taille du fichier distant. Une réponse 206 au `Range: bytes=0-0` de repli a un
 * `Content-Length` de 1 : la taille réelle est le total de `Content-Range`.
 */
function remoteLength(response: Response): string | null {
  if (response.status === 206) {
    const total = /\/(\d+)\s*$/.exec(response.headers.get('content-range') ?? '');
    return total ? total[1] : null;
  }
  return response.headers.get('content-length');
}

function normalizeFingerprint(response: Response): RemoteFingerprint {
  const etag = response.headers.get('etag');
  const lastModified = response.headers.get('last-modified');
  const rawLength = remoteLength(response);
  const contentLength =
    rawLength != null && rawLength !== '' ? Number(rawLength) : null;

  return {
    etag: etag ? String(etag) : null,
    lastModified: lastModified ? String(lastModified) : null,
    contentLength: contentLength !== null && Number.isFinite(contentLength) ? contentLength : null
  };
}

function remoteFingerprintUnchanged(
  stored: RemoteFingerprint | null | undefined,
  remote: RemoteFingerprint | null | undefined
): boolean {
  if (!stored || !remote) return false;

  if (stored.etag && remote.etag && stored.etag === remote.etag) {
    return true;
  }
  if (
    stored.lastModified &&
    remote.lastModified &&
    stored.lastModified === remote.lastModified
  ) {
    return true;
  }
  if (
    stored.contentLength != null &&
    remote.contentLength != null &&
    stored.contentLength === remote.contentLength
  ) {
    return true;
  }
  return false;
}

function timeoutSignal(timeout: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(timeoutError(`aucune réponse depuis ${timeout} ms`)),
    timeout
  );
  timer.unref?.();
  return controller.signal;
}

async function requestHeaders(
  url: string,
  { method, headers, timeout }: { method: string; headers: Record<string, string>; timeout: number }
): Promise<Response> {
  const response = await fetch(url, {
    method,
    headers,
    redirect: 'follow',
    signal: timeoutSignal(timeout)
  });
  if (response.status < 200 || response.status >= 400) {
    await discardBody(response);
    throw new HttpStatusError(response.status);
  }
  return response;
}

async function fetchRemoteFingerprint(
  url: string,
  { timeout = 30000, userAgent }: { timeout?: number; userAgent?: string } = {}
): Promise<RemoteFingerprint> {
  validateTimerDelay(timeout, 'timeout');
  const headers = { 'User-Agent': userAgent ?? DEFAULT_USER_AGENT };

  try {
    const response = await requestHeaders(url, { method: 'HEAD', headers, timeout });
    return normalizeFingerprint(response);
  } catch (headError) {
    try {
      const response = await requestHeaders(url, {
        method: 'GET',
        headers: { ...headers, Range: 'bytes=0-0' },
        timeout
      });
      try {
        return normalizeFingerprint(response);
      } finally {
        await discardBody(response);
      }
    } catch {
      throw headError;
    }
  }
}

export {
  parseIntervalHours,
  shouldRecheckFile,
  fetchRemoteFingerprint,
  remoteFingerprintUnchanged
};
