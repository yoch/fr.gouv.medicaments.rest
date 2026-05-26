const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const sevenBin = require('7zip-bin');
const {
  parseIntervalHours,
  shouldRecheckFile,
  fetchRemoteFingerprint,
  remoteFingerprintUnchanged
} = require('../utils/remoteFileProbe');

const execFileAsync = promisify(execFile);

const VET_DATA_DIR = path.join(__dirname, '../../data/veterinaires');
const META_FILE = path.join(VET_DATA_DIR, 'meta.json');
const CHECK_INTERVAL_HOURS = parseIntervalHours(
  process.env.VET_CHECK_INTERVAL_HOURS,
  72
);

const ARCHIVE_URL = 'https://pro.anses.fr/RCP/amm-vet-fr-v2-v.7z';
const DICT_URL = 'https://pro.anses.fr/RCP/amm-vet-fr-v2-d.xml';

const ARCHIVE_NAME = 'amm-vet-fr-v2-v.7z';
const PRODUCTS_XML_NAME = 'amm-vet-fr-v2-v.xml';
const DICT_XML_NAME = 'amm-vet-fr-v2-d.xml';

const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; fr.gouv.medicaments.rest/1.0)'
};

async function ensure7zipExecutable() {
  const bin = sevenBin.path7za;
  if (!fs.existsSync(bin)) {
    throw new Error(`Binaire 7za introuvable: ${bin}`);
  }
  await fs.chmod(bin, 0o755);
  return bin;
}

async function loadMetadata() {
  try {
    if (fs.existsSync(META_FILE)) {
      return await fs.readJson(META_FILE);
    }
  } catch (error) {
    console.error('Erreur lors du chargement des métadonnées vétérinaires:', error.message);
  }
  return {};
}

async function saveMetadata(metadata) {
  await fs.ensureDir(VET_DATA_DIR);
  await fs.writeJson(META_FILE, metadata, { spaces: 2 });
}

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

async function downloadFile(url, filepath) {
  console.log(`Téléchargement vétérinaire: ${path.basename(filepath)}...`);
  const response = await axios({
    method: 'GET',
    url,
    responseType: 'stream',
    headers: HTTP_HEADERS,
    timeout: 120000
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

async function extractArchive(archivePath, destDir) {
  const bin = await ensure7zipExecutable();
  await fs.ensureDir(destDir);
  await execFileAsync(bin, ['x', '-y', `-o${destDir}`, archivePath]);
}

function touchChecked(metadata, filename, extra = {}) {
  metadata[filename] = {
    ...metadata[filename],
    checkedAt: new Date().toISOString(),
    ...extra
  };
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
        await saveMetadata(metadata);
        console.log(`✓ ${filename} (vétérinaire) inchangé (hash local identique)`);
        return { changed: false };
      }
    }

    let remoteFingerprint = null;
    try {
      remoteFingerprint = await fetchRemoteFingerprint(url, {
        timeout: 60000,
        userAgent: HTTP_HEADERS['User-Agent']
      });
      if (
        remoteFingerprintUnchanged(fileMeta.remote, remoteFingerprint) &&
        existingHash &&
        fs.existsSync(finalPath)
      ) {
        touchChecked(metadata, filename, { remote: remoteFingerprint });
        await saveMetadata(metadata);
        console.log(
          `✓ ${filename} (vétérinaire) inchangé (sonde distante, pas de téléchargement)`
        );
        return { changed: false };
      }
    } catch (probeError) {
      console.warn(
        `⚠ Sonde distante ${filename} (vétérinaire): ${probeError.message} — téléchargement complet`
      );
    }

    const fileHash = await downloadFile(url, tempPath);

    if (existingHash && fileHash === existingHash && fs.existsSync(finalPath)) {
      await fs.remove(tempPath);
      touchChecked(metadata, filename, {
        remote: remoteFingerprint ?? fileMeta.remote
      });
      await saveMetadata(metadata);
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
    await saveMetadata(metadata);
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
  let metadata = await loadMetadata();
  let changed = false;

  const archiveResult = await processRemoteFile({
    filename: ARCHIVE_NAME,
    url: ARCHIVE_URL,
    metadata,
    extract: true
  });
  changed = changed || archiveResult.changed;
  metadata = await loadMetadata();

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
