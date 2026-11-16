/**
 * Filtres exacts pour GET /medicaments/disponibilite et mapping alertes MVP.
 * Comparaisons de dates : parse interne JJ/MM/AAAA (format source BDPM),
 * sans modifier les valeurs brutes exposées sur /disponibilite.
 */

import crypto from 'node:crypto';
import { normalizeAnsmUrl } from './ansmUrl.mts';

export interface DisponibiliteFilters {
  cis: string | undefined;
  cip13: string | undefined;
  code_statut: string | undefined;
  date_mise_a_jour_min: Date | undefined;
  lien_ansm: string | undefined;
  lienFilterInvalid: boolean;
  hasExactFilters: boolean;
}

export interface DisponibiliteAlert {
  id: string;
  medicine_name: string | null;
  status: string | null;
  updated_at: string | null;
  expected_return: string | null;
  detail_url: string | null;
  cis: string | null;
  cip13: string | null;
  code_statut: string | null;
}

function parseBdpmDate(value: unknown): Date | null {
  const raw = String(value || '').trim();
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(raw)) return null;
  const [day, month, year] = raw.split('/').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseQueryDate(value: unknown): Date | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(raw)) return parseBdpmDate(raw);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const date = new Date(`${raw}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/** JJ/MM/AAAA → YYYY-MM-DD, ou null si non parseable. */
function formatBdpmDateIso(value: unknown): string | null {
  const date = parseBdpmDate(value);
  return date ? date.toISOString().slice(0, 10) : null;
}

/**
 * Id stable d’une ligne ruptures : hash court de `cis:cip13:url_normalisée`.
 * Opaque (non décodable) — lookup via index `rupturesByAlertId`.
 */
function buildDisponibiliteAlertId(row: Record<string, unknown>): string {
  const cis = String(row.cis || '').trim();
  const cip13 = String(row.cip13 || '').trim();
  const url = normalizeAnsmUrl(row.lien_ansm);
  const payload = `${cis}:${cip13}:${url}`;
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 12);
}

function isDisponibiliteAlertId(alertId: unknown): boolean {
  return /^[a-f0-9]{12}$/.test(String(alertId || '').trim());
}

function pickQueryString(value: unknown): string | undefined {
  if (value == null) return undefined;
  const trimmed = String(value).trim();
  return trimmed !== '' ? trimmed : undefined;
}

function parseDisponibiliteFilters(query: Record<string, unknown> = {}): DisponibiliteFilters {
  const cis = pickQueryString(query.cis);
  const cip13 = pickQueryString(query.cip13);
  const code_statut = pickQueryString(query.code_statut);
  const dateRaw = pickQueryString(query.date_mise_a_jour_min);
  const parsedDate = dateRaw ? parseQueryDate(dateRaw) : undefined;
  const lienRaw = pickQueryString(query.lien_ansm);
  const normalizedLien = lienRaw ? normalizeAnsmUrl(lienRaw) : '';
  const lienFilterInvalid = Boolean(lienRaw && !normalizedLien);
  const lien_ansm = normalizedLien || undefined;
  const date_mise_a_jour_min = parsedDate instanceof Date ? parsedDate : undefined;

  return {
    cis,
    cip13,
    code_statut,
    // Date = filtre actif ; critère date fourni mais invalide → ignoré (pas dans hasExactFilters)
    date_mise_a_jour_min,
    lien_ansm,
    lienFilterInvalid,
    hasExactFilters: Boolean(
      cis ||
        cip13 ||
        code_statut ||
        date_mise_a_jour_min ||
        lien_ansm ||
        lienFilterInvalid
    )
  };
}

function rowMatchesDisponibiliteFilters(
  row: Record<string, unknown>,
  filters: DisponibiliteFilters
): boolean {
  if (filters.cis && row.cis !== filters.cis) return false;
  if (filters.cip13 && row.cip13 !== filters.cip13) return false;
  if (filters.code_statut && row.code_statut !== filters.code_statut) return false;
  if (filters.lien_ansm) {
    if (normalizeAnsmUrl(row.lien_ansm) !== filters.lien_ansm) return false;
  }
  if (filters.date_mise_a_jour_min instanceof Date) {
    const maj = parseBdpmDate(row.date_mise_a_jour);
    if (!maj || maj < filters.date_mise_a_jour_min) return false;
  }
  return true;
}

/**
 * @param row - ligne ruptures (toJSON ou record)
 * @param medicineName
 */
function mapRowToDisponibiliteAlert(
  row: Record<string, unknown>,
  medicineName: string | null | undefined
): DisponibiliteAlert {
  const detailUrl = row.lien_ansm ? String(row.lien_ansm).trim() : null;
  const cip13Raw = row.cip13 ? String(row.cip13).trim() : '';
  return {
    id: buildDisponibiliteAlertId(row),
    medicine_name: medicineName || null,
    status: (row.libelle_statut as string | undefined) || null,
    updated_at: formatBdpmDateIso(row.date_mise_a_jour),
    expected_return: formatBdpmDateIso(row.date_remise_dispo),
    detail_url: detailUrl || null,
    cis: (row.cis as string | undefined) || null,
    cip13: cip13Raw || null,
    code_statut: (row.code_statut as string | undefined) || null
  };
}

function compareDisponibiliteRowsByMajDesc(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): number {
  const da = parseBdpmDate(a.date_mise_a_jour);
  const db = parseBdpmDate(b.date_mise_a_jour);
  const ta = da ? da.getTime() : 0;
  const tb = db ? db.getTime() : 0;
  if (tb !== ta) return tb - ta;
  return String(a.cis || '').localeCompare(String(b.cis || ''));
}

export {
  parseBdpmDate,
  parseQueryDate,
  formatBdpmDateIso,
  buildDisponibiliteAlertId,
  isDisponibiliteAlertId,
  parseDisponibiliteFilters,
  rowMatchesDisponibiliteFilters,
  mapRowToDisponibiliteAlert,
  compareDisponibiliteRowsByMajDesc
};
