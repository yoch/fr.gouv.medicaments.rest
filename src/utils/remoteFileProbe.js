const axios = require('axios');

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (compatible; fr.gouv.medicaments.rest/1.0)';

function parseIntervalHours(envValue, defaultHours) {
  const parsed = parseInt(envValue ?? String(defaultHours), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultHours;
}

function hoursSince(isoDate) {
  if (!isoDate) return Infinity;
  return (Date.now() - new Date(isoDate).getTime()) / (1000 * 60 * 60);
}

function shouldRecheckFile(meta, intervalHours) {
  if (!meta) return true;
  const lastCheck = meta.checkedAt || meta.downloadedAt;
  if (!lastCheck) return true;
  return hoursSince(lastCheck) >= intervalHours;
}

function normalizeFingerprint(headers) {
  const etag = headers.etag ?? headers.ETag ?? null;
  const lastModified = headers['last-modified'] ?? headers['Last-Modified'] ?? null;
  const rawLength = headers['content-length'] ?? headers['Content-Length'] ?? null;
  const contentLength =
    rawLength != null && rawLength !== '' ? Number(rawLength) : null;

  return {
    etag: etag ? String(etag) : null,
    lastModified: lastModified ? String(lastModified) : null,
    contentLength: Number.isFinite(contentLength) ? contentLength : null
  };
}

function remoteFingerprintUnchanged(stored, remote) {
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

async function fetchRemoteFingerprint(url, { timeout = 30000, userAgent } = {}) {
  const headers = { 'User-Agent': userAgent ?? DEFAULT_USER_AGENT };

  try {
    const response = await axios.head(url, {
      headers,
      timeout,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 400
    });
    return normalizeFingerprint(response.headers);
  } catch (headError) {
    try {
      const response = await axios.get(url, {
        headers: { ...headers, Range: 'bytes=0-0' },
        timeout,
        maxRedirects: 5,
        validateStatus: (status) => status >= 200 && status < 400,
        responseType: 'arraybuffer'
      });
      return normalizeFingerprint(response.headers);
    } catch {
      throw headError;
    }
  }
}

module.exports = {
  parseIntervalHours,
  shouldRecheckFile,
  fetchRemoteFingerprint,
  remoteFingerprintUnchanged
};
