/**
 * Fonctions pures partagées par les downloaders BDPM et vétérinaire :
 * hash, persistance metadata, sonde distante, téléchargement streaming.
 *
 * Pas de classe de base — les downloaders gardent leur logique métier
 * (URLs, 7zip, conversion UTF-8) et appellent ces helpers.
 */

import crypto from 'node:crypto';
import fs from 'fs-extra';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { validateTimerDelay } from '../../utils/periodicTask.mts';
import {
  HttpStatusError,
  timeoutError,
  discardBody,
  describeError
} from '../../utils/httpErrors.mts';
import {
  fetchRemoteFingerprint,
  remoteFingerprintUnchanged,
  type RemoteFingerprint
} from '../../utils/remoteFileProbe.mts';

export interface SyncFileMeta {
  downloadedAt?: string;
  checkedAt?: string;
  hash?: string;
  source?: string;
  encoding?: string;
  remote?: RemoteFingerprint | null;
}

export type SyncMetadataMap = Record<string, SyncFileMeta>;

async function hashFile(filepath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filepath), hash);
  return hash.digest('hex');
}

async function loadJsonMeta(metaFile: string): Promise<SyncMetadataMap> {
  try {
    if (fs.existsSync(metaFile)) {
      return (await fs.readJson(metaFile)) as SyncMetadataMap;
    }
  } catch (error) {
    const err = error as Error;
    console.error('Erreur lors du chargement des métadonnées:', err.message);
  }
  return {};
}

async function saveJsonMeta(
  metaFile: string,
  metadata: SyncMetadataMap,
  targetDir?: string
): Promise<void> {
  try {
    if (targetDir) await fs.ensureDir(targetDir);
    await fs.writeJson(metaFile, metadata, { spaces: 2 });
  } catch (error) {
    const err = error as Error;
    console.error('Erreur lors de la sauvegarde des métadonnées:', err.message);
  }
}

export interface DownloadFileOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  totalTimeoutMs?: number;
}

/**
 * Télécharge `url` vers `filepath` (stream) et retourne le hash SHA-256 du
 * fichier écrit. `timeoutMs` borne l'inactivité (attente des en-têtes, puis
 * silence entre deux morceaux : un transfert lent mais actif continue) ;
 * `totalTimeoutMs` borne la durée totale du transfert.
 */
async function downloadFile(
  url: string,
  filepath: string,
  { headers = {}, timeoutMs = 30000, totalTimeoutMs = 10 * 60 * 1000 }: DownloadFileOptions = {}
): Promise<string> {
  validateTimerDelay(timeoutMs, 'timeoutMs');
  validateTimerDelay(totalTimeoutMs, 'totalTimeoutMs');
  console.log(`Téléchargement de ${path.basename(filepath)}...`);
  await fs.ensureDir(path.dirname(filepath));
  const controller = new AbortController();
  const totalTimer = setTimeout(
    () => controller.abort(timeoutError(`durée totale de ${totalTimeoutMs} ms dépassée`)),
    totalTimeoutMs
  );
  totalTimer.unref?.();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => controller.abort(timeoutError(`aucune donnée reçue depuis ${timeoutMs} ms`)),
      timeoutMs
    );
    idleTimer.unref?.();
  };
  const disarmTimers = () => {
    clearTimeout(totalTimer);
    clearTimeout(idleTimer);
  };
  let response: Response | undefined;
  let source: Readable | undefined;
  try {
    armIdleTimer();
    response = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
    armIdleTimer();
    if (!response.ok) throw new HttpStatusError(response.status);
    if (!response.body) throw new Error(`réponse HTTP ${response.status} sans corps`);
    source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
    const idleWatch = new Transform({
      transform(chunk, _encoding, callback) {
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
    const err = error as { name?: string };
    throw controller.signal.aborted && err?.name === 'AbortError'
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
async function probeRemote(
  url: string,
  { timeoutMs = 30000, userAgent }: { timeoutMs?: number; userAgent?: string } = {}
): Promise<RemoteFingerprint | null> {
  try {
    return await fetchRemoteFingerprint(url, { timeout: timeoutMs, userAgent });
  } catch (probeError) {
    console.warn(`⚠ Sonde distante ${path.basename(url)}: ${describeError(probeError)}`);
    return null;
  }
}

function remoteUnchanged(
  previousFingerprint: RemoteFingerprint | null | undefined,
  newFingerprint: RemoteFingerprint | null | undefined
): boolean {
  return remoteFingerprintUnchanged(previousFingerprint, newFingerprint);
}

/**
 * Marque un fichier comme vérifié à l'instant courant, en fusionnant des
 * champs optionnels (ex. fingerprint distant).
 */
function touchChecked(
  metadata: SyncMetadataMap,
  filename: string,
  extra: Partial<SyncFileMeta> = {}
): void {
  metadata[filename] = {
    ...metadata[filename],
    checkedAt: new Date().toISOString(),
    ...extra
  };
}

export {
  hashFile,
  loadJsonMeta,
  saveJsonMeta,
  downloadFile,
  probeRemote,
  remoteUnchanged,
  touchChecked
};
