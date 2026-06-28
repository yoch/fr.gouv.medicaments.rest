'use strict';

/**
 * Fonctions pures partagées par les downloaders BDPM et vétérinaire :
 * hash, persistance metadata, sonde distante, téléchargement streaming.
 *
 * Pas de classe de base — les downloaders gardent leur logique métier
 * (URLs, 7zip, conversion UTF-8) et appellent ces helpers.
 */

const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const {
  fetchRemoteFingerprint,
  remoteFingerprintUnchanged
} = require('../../utils/remoteFileProbe');

function hashFile(filepath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const reader = fs.createReadStream(filepath);
    reader.pipe(hash);
    hash.on('finish', () => resolve(hash.digest('hex')));
    reader.on('error', reject);
    hash.on('error', reject);
  });
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
 * fichier écrit. `headers` (ex. User-Agent) et `timeoutMs` sont injectés.
 */
async function downloadFile(url, filepath, { headers = {}, timeoutMs = 30000 } = {}) {
  console.log(`Téléchargement de ${path.basename(filepath)}...`);
  const response = await axios({
    method: 'GET',
    url,
    responseType: 'stream',
    headers,
    timeout: timeoutMs
  });

  await fs.ensureDir(path.dirname(filepath));
  const writer = fs.createWriteStream(filepath);
  response.data.pipe(writer);

  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  return hashFile(filepath);
}

/**
 * Sonde distante : retourne le fingerprint (etag/last-modified/content-length)
 * ou null si la sonde échoue. N'effectue pas de téléchargement complet.
 */
async function probeRemote(url, { timeoutMs = 30000, userAgent } = {}) {
  try {
    return await fetchRemoteFingerprint(url, { timeout: timeoutMs, userAgent });
  } catch (probeError) {
    console.warn(`⚠ Sonde distante ${path.basename(url)}: ${probeError.message}`);
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
