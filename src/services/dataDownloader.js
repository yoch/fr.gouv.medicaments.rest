const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const {
  parseIntervalHours,
  shouldRecheckFile,
  fetchRemoteFingerprint,
  remoteFingerprintUnchanged
} = require('../utils/remoteFileProbe');

const DATA_DIR = path.join(__dirname, '../../data');
const META_FILE = path.join(DATA_DIR, 'meta.json');
const BASE_URL = 'https://base-donnees-publique.medicaments.gouv.fr/download';
const CHECK_INTERVAL_HOURS = parseIntervalHours(
  process.env.BDPM_CHECK_INTERVAL_HOURS,
  72
);

const HTTP_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
};

const FILES = [
  'CIS_bdpm.txt',
  'CIS_CIP_bdpm.txt',
  'CIS_COMPO_bdpm.txt',
  'CIS_HAS_SMR_bdpm.txt',
  'CIS_HAS_ASMR_bdpm.txt',
  // https://base-donnees-publique.medicaments.gouv.fr/download/file/HAS_LiensPageCT_bdpm.txt
  'CIS_GENER_bdpm.txt',
  'CIS_CPD_bdpm.txt',
  'CIS_CIP_Dispo_Spec.txt',
  'CIS_MITM.txt',
  // 'CIS_InfoImportantes.txt'
];

async function loadMetadata() {
  try {
    if (fs.existsSync(META_FILE)) {
      const data = await fs.readJson(META_FILE);
      return data;
    }
  } catch (error) {
    console.error('Erreur lors du chargement des métadonnées:', error.message);
  }
  return {};
}

async function saveMetadata(metadata) {
  try {
    await fs.ensureDir(DATA_DIR);
    await fs.writeJson(META_FILE, metadata, { spaces: 2 });
  } catch (error) {
    console.error('Erreur lors de la sauvegarde des métadonnées:', error.message);
  }
}

async function checkAndConvertToUTF8(filepath) {
  try {
    // Vérifier l'encodage du fichier
    const { stdout } = await execAsync(`file -b --mime-encoding "${filepath}"`);
    const encoding = stdout.trim();

    if (encoding !== 'utf-8' && encoding !== 'us-ascii') {
      console.log(`  → Conversion de ${path.basename(filepath)} de ${encoding} vers UTF-8...`);

      // Créer une copie temporaire
      const tempFile = filepath + '.tmp';

      // Déterminer l'encodage source
      let sourceEncoding = encoding;
      if (encoding === 'unknown-8bit' || encoding === 'binary') {
        // Essayer de détecter si c'est du latin1 ou windows-1252
        sourceEncoding = 'ISO-8859-1';
      }

      try {
        // Convertir le fichier en UTF-8
        await execAsync(`iconv -f ${sourceEncoding} -t UTF-8 "${filepath}" > "${tempFile}"`);

        // Remplacer le fichier original
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
          // Nettoyer le fichier temporaire s'il existe
          await fs.remove(tempFile).catch(() => { });
        }
      }
    }
  } catch (error) {
    console.error(`  ✗ Erreur lors de la vérification/conversion de l'encodage:`, error.message);
  }
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
  try {
    console.log(`Téléchargement de ${path.basename(filepath)}...`);
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream',
      headers: HTTP_HEADERS,
      timeout: 30000
    });

    await fs.ensureDir(path.dirname(filepath));

    const writer = fs.createWriteStream(filepath);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    return hashFile(filepath);
  } catch (error) {
    console.error(`Erreur téléchargement ${path.basename(filepath)}:`, error.message);
    throw error;
  }
}

async function downloadDataIfNeeded() {
  await fs.ensureDir(DATA_DIR);
  let metadata = await loadMetadata();
  let changed = false;

  // Download static files
  for (const filename of FILES) {
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
          await saveMetadata(metadata);
          continue;
        }
      }

      let remoteFingerprint = null;
      try {
        remoteFingerprint = await fetchRemoteFingerprint(url, {
          timeout: 30000,
          userAgent: HTTP_HEADERS['User-Agent']
        });
        if (
          remoteFingerprintUnchanged(fileMeta?.remote, remoteFingerprint) &&
          existingHash &&
          fs.existsSync(finalPath)
        ) {
          metadata[filename] = {
            ...metadata[filename],
            checkedAt: new Date().toISOString(),
            remote: remoteFingerprint
          };
          await saveMetadata(metadata);
          console.log(`✓ ${filename} inchangé (sonde distante, pas de téléchargement)`);
          continue;
        }
      } catch (probeError) {
        console.warn(
          `⚠ Sonde distante ${filename}: ${probeError.message} — téléchargement complet`
        );
      }

      const fileHash = await downloadFile(url, tempPath);

      if (existingHash && fileHash === existingHash && fs.existsSync(finalPath)) {
        console.log(`✓ ${filename} inchangé (hash identique)`);
        // On met juste à jour la date de vérification
        metadata[filename] = {
          ...metadata[filename],
          checkedAt: new Date().toISOString(),
          remote: remoteFingerprint ?? metadata[filename]?.remote
        };
        await fs.remove(tempPath);
        await saveMetadata(metadata);
      } else {
        if (existingHash) {
          console.log(`⟳ ${filename} a été mis à jour par le serveur (hash différent)`);
        } else {
          console.log(`+ ${filename} nouvelle ressource`);
        }

        // Le fichier a changé ou est nouveau
        // 1. Convertir en UTF-8 le fichier temporaire
        await checkAndConvertToUTF8(tempPath);

        // 2. Déplacer vers la destination finale
        await fs.move(tempPath, finalPath, { overwrite: true });

        // 3. Mettre à jour les métadonnées
        metadata[filename] = {
          downloadedAt: new Date().toISOString(),
          checkedAt: new Date().toISOString(),
          hash: fileHash,
          source: 'remote',
          encoding: 'utf-8',
          remote: remoteFingerprint ?? metadata[filename]?.remote ?? null
        };
        await saveMetadata(metadata);
        changed = true;
        console.log(`✓ ${filename} mis à jour et converti`);
      }
    } catch (error) {
      console.error(`✗ Échec traitement ${filename}:`, error.message);
      // Nettoyage
      await fs.remove(tempPath).catch(() => { });

      if (!fs.existsSync(finalPath)) {
        console.log(`Le fichier ${filename} n'existe pas localement et le téléchargement a échoué`);
      } else {
        console.log(`Conservation de la version locale de ${filename}`);
      }
    }
  }

  return { changed };
}

module.exports = { downloadDataIfNeeded, CHECK_INTERVAL_HOURS };
