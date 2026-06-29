const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');
const { shouldRecheckFile } = require('../utils/remoteFileProbe');
const config = require('../config');
const {
  hashFile,
  loadJsonMeta,
  saveJsonMeta,
  downloadFile,
  probeRemote,
  remoteUnchanged
} = require('./download/syncHelpers');

const execAsync = promisify(exec);

const DATA_DIR = config.dataDir;
const META_FILE = path.join(DATA_DIR, 'meta.json');
const BASE_URL = 'https://base-donnees-publique.medicaments.gouv.fr/download';
const CHECK_INTERVAL_HOURS = config.bdpmCheckIntervalHours;

const HTTP_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
};

const LOAD_HAS_AVIS = config.loadHasAvis;
const LOAD_MITM = config.loadMitm;

const BDPM_FILES = [
  'CIS_bdpm.txt',
  'CIS_CIP_bdpm.txt',
  'CIS_COMPO_bdpm.txt',
  'CIS_GENER_bdpm.txt',
  'CIS_CPD_bdpm.txt',
  'CIS_CIP_Dispo_Spec.txt'
];

const MITM_FILES = ['CIS_MITM.txt'];

const HAS_FILES = ['CIS_HAS_SMR_bdpm.txt', 'CIS_HAS_ASMR_bdpm.txt'];

/**
 * Fichiers sources BDPM désactivés (réserve).
 *
 * Conservés ici pour réactivation rapide en cas de changement d'avis.
 * `bdpmFilesToSync()` ne les inclut pas — ne pas supprimer sans discussion.
 *
 * Notes de réactivation :
 *   - CIS_InfoImportantes.txt : URL sans suffixe /file/ (voir plus bas)
 *     `${BASE_URL}/${filename}` au lieu de `${BASE_URL}/file/${filename}`
 *   - HAS_LiensPageCT_bdpm.txt : URL distante distincte
 *     https://base-donnees-publique.medicaments.gouv.fr/download/file/HAS_LiensPageCT_bdpm.txt
 */
const BDPM_DISABLED_FILES = ['CIS_InfoImportantes.txt', 'HAS_LiensPageCT_bdpm.txt'];

function bdpmFilesToSync() {
  let files = [...BDPM_FILES];
  if (LOAD_MITM) files = files.concat(MITM_FILES);
  if (LOAD_HAS_AVIS) files = files.concat(HAS_FILES);
  return files;
}

async function checkAndConvertToUTF8(filepath) {
  try {
    const { stdout } = await execAsync(`file -b --mime-encoding "${filepath}"`);
    const encoding = stdout.trim();

    if (encoding !== 'utf-8' && encoding !== 'us-ascii') {
      console.log(`  → Conversion de ${path.basename(filepath)} de ${encoding} vers UTF-8...`);

      const tempFile = filepath + '.tmp';
      let sourceEncoding = encoding;
      if (encoding === 'unknown-8bit' || encoding === 'binary') {
        sourceEncoding = 'ISO-8859-1';
      }

      try {
        await execAsync(`iconv -f ${sourceEncoding} -t UTF-8 "${filepath}" > "${tempFile}"`);
        await fs.move(tempFile, filepath, { overwrite: true });
        console.log(`  ✓ Conversion réussie`);
      } catch (convError) {
        console.log(`  → Tentative avec encodage windows-1252...`);
        try {
          await execAsync(`iconv -f windows-1252 -t UTF-8 "${filepath}" > "${tempFile}"`);
          await fs.move(tempFile, filepath, { overwrite: true });
          console.log(`  ✓ Conversion réussie avec windows-1252`);
        } catch (err2) {
          console.error(`  ✗ Impossible de convertir le fichier, il sera utilisé tel quel`);
          await fs.remove(tempFile).catch(() => {});
        }
      }
    }
  } catch (error) {
    console.error(`  ✗ Erreur lors de la vérification/conversion de l'encodage:`, error.message);
  }
}

async function downloadDataIfNeeded() {
  await fs.ensureDir(DATA_DIR);
  let metadata = await loadJsonMeta(META_FILE);
  let changed = false;

  for (const filename of bdpmFilesToSync()) {
    const finalPath = path.join(DATA_DIR, filename);
    const tempPath = path.join(os.tmpdir(), filename);
    const url = `${BASE_URL}/file/${filename}`;
    // Réactivation CIS_InfoImportantes.txt : `${BASE_URL}/${filename}` (sans /file/)

    const fileMeta = metadata[filename];

    if (!shouldRecheckFile(fileMeta, CHECK_INTERVAL_HOURS) && fs.existsSync(finalPath)) {
      console.log(`✓ ${filename} vérifié récemment (< ${CHECK_INTERVAL_HOURS}h)`);
      continue;
    }

    try {
      const existingHash = fileMeta?.hash;

      if (existingHash && fs.existsSync(finalPath)) {
        const localHash = await hashFile(finalPath);
        if (localHash === existingHash) {
          console.log(`✓ ${filename} inchangé (hash local identique)`);
          metadata[filename].checkedAt = new Date().toISOString();
          await saveJsonMeta(META_FILE, metadata);
          continue;
        }
      }

      const remoteFingerprint = await probeRemote(url, {
        timeoutMs: 30000,
        userAgent: HTTP_HEADERS['User-Agent']
      });
      if (
        remoteFingerprint &&
        remoteUnchanged(fileMeta?.remote, remoteFingerprint) &&
        existingHash &&
        fs.existsSync(finalPath)
      ) {
        metadata[filename] = {
          ...metadata[filename],
          checkedAt: new Date().toISOString(),
          remote: remoteFingerprint
        };
        await saveJsonMeta(META_FILE, metadata);
        console.log(`✓ ${filename} inchangé (sonde distante, pas de téléchargement)`);
        continue;
      }

      const fileHash = await downloadFile(url, tempPath, { headers: HTTP_HEADERS });

      if (existingHash && fileHash === existingHash && fs.existsSync(finalPath)) {
        console.log(`✓ ${filename} inchangé (hash identique)`);
        metadata[filename] = {
          ...metadata[filename],
          checkedAt: new Date().toISOString(),
          remote: remoteFingerprint ?? metadata[filename]?.remote
        };
        await fs.remove(tempPath);
        await saveJsonMeta(META_FILE, metadata);
      } else {
        if (existingHash) {
          console.log(`⟳ ${filename} a été mis à jour par le serveur (hash différent)`);
        } else {
          console.log(`+ ${filename} nouvelle ressource`);
        }

        await checkAndConvertToUTF8(tempPath);
        await fs.move(tempPath, finalPath, { overwrite: true });

        metadata[filename] = {
          downloadedAt: new Date().toISOString(),
          checkedAt: new Date().toISOString(),
          hash: fileHash,
          source: 'remote',
          encoding: 'utf-8',
          remote: remoteFingerprint ?? metadata[filename]?.remote ?? null
        };
        await saveJsonMeta(META_FILE, metadata);
        changed = true;
        console.log(`✓ ${filename} mis à jour et converti`);
      }
    } catch (error) {
      console.error(`✗ Échec traitement ${filename}:`, error.message);
      await fs.remove(tempPath).catch(() => {});

      if (!fs.existsSync(finalPath)) {
        console.log(`Le fichier ${filename} n'existe pas localement et le téléchargement a échoué`);
      } else {
        console.log(`Conservation de la version locale de ${filename}`);
      }
    }
  }

  return { changed };
}

module.exports = { downloadDataIfNeeded };
