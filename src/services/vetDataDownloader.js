const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const sevenBin = require('7zip-bin');
const { shouldRecheckFile } = require('../utils/remoteFileProbe');
const config = require('../config');
const {
  hashFile,
  loadJsonMeta,
  saveJsonMeta,
  downloadFile,
  probeRemote,
  remoteUnchanged,
  touchChecked
} = require('./download/syncHelpers');

const execFileAsync = promisify(execFile);

const VET_DATA_DIR = config.vetDataDir;
const META_FILE = path.join(VET_DATA_DIR, 'meta.json');
const CHECK_INTERVAL_HOURS = config.vetCheckIntervalHours;

const ARCHIVE_URL = 'https://pro.anses.fr/RCP/amm-vet-fr-v2-v.7z';
const DICT_URL = 'https://pro.anses.fr/RCP/amm-vet-fr-v2-d.xml';

const ARCHIVE_NAME = 'amm-vet-fr-v2-v.7z';
const PRODUCTS_XML_NAME = config.vetProductsFile;
const DICT_XML_NAME = config.vetDictFile;

const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; fr.gouv.medicaments.rest/1.1)'
};

async function ensure7zipExecutable() {
  const bin = sevenBin.path7za;
  if (!fs.existsSync(bin)) {
    throw new Error(`Binaire 7za introuvable: ${bin}`);
  }
  await fs.chmod(bin, 0o755);
  return bin;
}

async function extractArchive(archivePath, destDir) {
  const bin = await ensure7zipExecutable();
  await fs.ensureDir(destDir);
  await execFileAsync(bin, ['x', '-y', `-o${destDir}`, archivePath]);
}

async function processRemoteFile({ filename, url, metadata, extract = false }) {
  const finalPath = path.join(VET_DATA_DIR, filename);
  const tempPath = path.join(os.tmpdir(), `vet-${filename}`);
  const fileMeta = metadata[filename] ?? {};

  if (!shouldRecheckFile(fileMeta, CHECK_INTERVAL_HOURS) && fs.existsSync(finalPath)) {
    console.log(
      `✓ ${filename} (vétérinaire) vérifié récemment (< ${CHECK_INTERVAL_HOURS}h)`
    );
    return { changed: false };
  }

  try {
    const existingHash = fileMeta.hash;
    if (existingHash && fs.existsSync(finalPath)) {
      const localHash = await hashFile(finalPath);
      if (localHash === existingHash) {
        touchChecked(metadata, filename);
        await saveJsonMeta(META_FILE, metadata, VET_DATA_DIR);
        console.log(`✓ ${filename} (vétérinaire) inchangé (hash local identique)`);
        return { changed: false };
      }
    }

    const remoteFingerprint = await probeRemote(url, {
      timeoutMs: 60000,
      userAgent: HTTP_HEADERS['User-Agent']
    });
    if (
      remoteFingerprint &&
      remoteUnchanged(fileMeta.remote, remoteFingerprint) &&
      existingHash &&
      fs.existsSync(finalPath)
    ) {
      touchChecked(metadata, filename, { remote: remoteFingerprint });
      await saveJsonMeta(META_FILE, metadata, VET_DATA_DIR);
      console.log(
        `✓ ${filename} (vétérinaire) inchangé (sonde distante, pas de téléchargement)`
      );
      return { changed: false };
    }

    const fileHash = await downloadFile(url, tempPath, {
      headers: HTTP_HEADERS,
      timeoutMs: 120000
    });

    if (existingHash && fileHash === existingHash && fs.existsSync(finalPath)) {
      await fs.remove(tempPath);
      touchChecked(metadata, filename, {
        remote: remoteFingerprint ?? fileMeta.remote
      });
      await saveJsonMeta(META_FILE, metadata, VET_DATA_DIR);
      console.log(`✓ ${filename} (vétérinaire) inchangé (hash distant identique)`);
      return { changed: false };
    }

    await fs.move(tempPath, finalPath, { overwrite: true });
    metadata[filename] = {
      downloadedAt: new Date().toISOString(),
      checkedAt: new Date().toISOString(),
      hash: fileHash,
      source: 'remote',
      remote: remoteFingerprint ?? fileMeta.remote ?? null
    };
    await saveJsonMeta(META_FILE, metadata, VET_DATA_DIR);
    console.log(`✓ ${filename} (vétérinaire) mis à jour`);

    if (extract) {
      await extractArchive(finalPath, VET_DATA_DIR);
      console.log(`✓ Archive vétérinaire extraite dans ${VET_DATA_DIR}`);
    }

    return { changed: true };
  } catch (error) {
    console.error(`✗ Échec traitement ${filename} (vétérinaire):`, error.message);
    await fs.remove(tempPath).catch(() => {});
    if (!fs.existsSync(finalPath)) {
      console.log(`Le fichier ${filename} n'existe pas localement et le téléchargement a échoué`);
    } else {
      console.log(`Conservation de la version locale de ${filename} (vétérinaire)`);
    }
    return { changed: false };
  }
}

async function downloadVetDataIfNeeded() {
  await fs.ensureDir(VET_DATA_DIR);
  let metadata = await loadJsonMeta(META_FILE);
  let changed = false;

  const archiveResult = await processRemoteFile({
    filename: ARCHIVE_NAME,
    url: ARCHIVE_URL,
    metadata,
    extract: true
  });
  changed = changed || archiveResult.changed;
  metadata = await loadJsonMeta(META_FILE);

  const dictResult = await processRemoteFile({
    filename: DICT_XML_NAME,
    url: DICT_URL,
    metadata,
    extract: false
  });
  changed = changed || dictResult.changed;

  const productsPath = path.join(VET_DATA_DIR, PRODUCTS_XML_NAME);
  if (!fs.existsSync(productsPath)) {
    console.warn(
      `Fichier produits ${PRODUCTS_XML_NAME} absent après extraction — vérifier l'archive ${ARCHIVE_NAME}`
    );
  }

  return { changed };
}

module.exports = {
  downloadVetDataIfNeeded,
  VET_DATA_DIR,
  PRODUCTS_XML_NAME,
  DICT_XML_NAME,
  CHECK_INTERVAL_HOURS
};
