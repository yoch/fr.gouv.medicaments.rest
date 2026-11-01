'use strict';

/**
 * Fonctions pures partagées par les downloaders BDPM et vétérinaire :
 * hash, persistance metadata, sonde distante, téléchargement streaming.
 *
 * Pas de classe de base — les downloaders gardent leur logique métier
 * (URLs, 7zip, conversion UTF-8) et appellent ces helpers.
 */

const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { validateTimerDelay } = require('../../utils/periodicTask');
const {
  HttpStatusError,
  timeoutError,
  discardBody,
  describeError
} = require('../../utils/httpErrors');
const {
  fetchRemoteFingerprint,
  remoteFingerprintUnchanged
} = require('../../utils/remoteFileProbe');

async function hashFile(filepath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filepath), hash);
  return hash.digest('hex');
}

async function loadJsonMeta(metaFile) {
  try {
    if (fs.existsSync(metaFile)) {
      return await fs.readJson(metaFile);
    }
  } catch (error) {
    console.error('Erreur lors du chargement des métadonnées:', error.message);
  }
  return {};
}

async function saveJsonMeta(metaFile, metadata, targetDir) {
  try {
    if (targetDir) await fs.ensureDir(targetDir);
    await fs.writeJson(metaFile, metadata, { spaces: 2 });
  } catch (error) {
    console.error('Erreur lors de la sauvegarde des métadonnées:', error.message);
  }
}

/**
 * Télécharge `url` vers `filepath` (stream) et retourne le hash SHA-256 du
 * fichier écrit. `timeoutMs` borne l'inactivité (attente des en-têtes, puis
 * silence entre deux morceaux : un transfert lent mais actif continue) ;
 * `totalTimeoutMs` borne la durée totale du transfert.
 */
async function downloadFile(
  url,
  filepath,
  { headers = {}, timeoutMs = 30000, totalTimeoutMs = 10 * 60 * 1000 } = {}
) {
  validateTimerDelay(timeoutMs, 'timeoutMs');
  validateTimerDelay(totalTimeoutMs, 'totalTimeoutMs');
  console.log(`Téléchargement de ${path.basename(filepath)}...`);
  await fs.ensureDir(path.dirname(filepath));
  const controller = new AbortController();
  const totalTimer = setTimeout(() => controller.abort(
    timeoutError(`durée totale de ${totalTimeoutMs} ms dépassée`)
  ), totalTimeoutMs);
  totalTimer.unref?.();
  let idleTimer;
  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(
      timeoutError(`aucune donnée reçue depuis ${timeoutMs} ms`)
    ), timeoutMs);
    idleTimer.unref?.();
  };
  const disarmTimers = () => {
    clearTimeout(totalTimer);
    clearTimeout(idleTimer);
  };
  let response;
  let source;
  try {
    armIdleTimer();
    response = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
    armIdleTimer();
    if (!response.ok) throw new HttpStatusError(response.status);
    if (!response.body) throw new Error(`réponse HTTP ${response.status} sans corps`);
    source = Readable.fromWeb(response.body);
    const idleWatch = new Transform({
      transform(chunk, encoding, callback) {
        armIdleTimer();
        callback(null, chunk);
      }
    });
    await pipeline(source, idleWatch, fs.createWriteStream(filepath), { signal: controller.signal });
    disarmTimers();
    return await hashFile(filepath);
  } catch (error) {
    disarmTimers();
    // Un statut d'erreur lève avant la création du flux : le corps de la
    // réponse doit être abandonné ici pour libérer la connexion.
    if (!source) await discardBody(response ?? {});
    // `pipeline` enveloppe le motif d'abandon dans une AbortError générique.
    throw controller.signal.aborted && error?.name === 'AbortError'
      ? controller.signal.reason
      : error;
  } finally {
    source?.destroy();
  }
}

/**
 * Sonde distante : retourne le fingerprint (etag/last-modified/content-length)
 * ou null si la sonde échoue. N'effectue pas de téléchargement complet.
 */
async function probeRemote(url, { timeoutMs = 30000, userAgent } = {}) {
  try {
    return await fetchRemoteFingerprint(url, { timeout: timeoutMs, userAgent });
  } catch (probeError) {
    console.warn(`⚠ Sonde distante ${path.basename(url)}: ${describeError(probeError)}`);
    return null;
  }
}

function remoteUnchanged(previousFingerprint, newFingerprint) {
  return remoteFingerprintUnchanged(previousFingerprint, newFingerprint);
}

/**
 * Marque un fichier comme vérifié à l'instant courant, en fusionnant des
 * champs optionnels (ex. fingerprint distant).
 */
function touchChecked(metadata, filename, extra = {}) {
  metadata[filename] = {
    ...metadata[filename],
    checkedAt: new Date().toISOString(),
    ...extra
  };
}

module.exports = {
  hashFile,
  loadJsonMeta,
  saveJsonMeta,
  downloadFile,
  probeRemote,
  remoteUnchanged,
  touchChecked
};
