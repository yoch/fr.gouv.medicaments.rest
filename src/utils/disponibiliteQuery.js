'use strict';

/**
 * Filtres exacts pour GET /medicaments/disponibilite et mapping alertes MVP.
 * Comparaisons de dates : parse interne JJ/MM/AAAA (format source BDPM),
 * sans modifier les valeurs brutes exposées sur /disponibilite.
 */

const crypto = require('crypto');
const { normalizeAnsmUrl } = require('./ansmUrl');

function parseBdpmDate(value) {
  const raw = String(value || '').trim();
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(raw)) return null;
  const [day, month, year] = raw.split('/').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseQueryDate(value) {
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
function formatBdpmDateIso(value) {
  const date = parseBdpmDate(value);
  return date ? date.toISOString().slice(0, 10) : null;
}

/**
 * Id stable d’une ligne ruptures : hash court de `cis:cip13:url_normalisée`.
 * Opaque (non décodable) — lookup via index `rupturesByAlertId`.
 */
function buildDisponibiliteAlertId(row) {
  const cis = String(row.cis || '').trim();
  const cip13 = String(row.cip13 || '').trim();
  const url = normalizeAnsmUrl(row.lien_ansm);
  const payload = `${cis}:${cip13}:${url}`;
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 12);
}

function isDisponibiliteAlertId(alertId) {
  return /^[a-f0-9]{12}$/.test(String(alertId || '').trim());
}

/**
 * @param {object} query - req.query
 */
function parseDisponibiliteFilters(query = {}) {
  const cis = query.cis != null && String(query.cis).trim() !== '' ? String(query.cis).trim() : undefined;
  const cip13 =
    query.cip13 != null && String(query.cip13).trim() !== '' ? String(query.cip13).trim() : undefined;
  const code_statut =
    query.code_statut != null && String(query.code_statut).trim() !== ''
      ? String(query.code_statut).trim()
      : undefined;
  const dateRaw =
    query.date_mise_a_jour_min != null && String(query.date_mise_a_jour_min).trim() !== ''
      ? String(query.date_mise_a_jour_min).trim()
      : undefined;
  const parsedDate = dateRaw ? parseQueryDate(dateRaw) : undefined;
  const lienRaw =
    query.lien_ansm != null && String(query.lien_ansm).trim() !== ''
      ? String(query.lien_ansm).trim()
      : undefined;
  const normalizedLien = lienRaw ? normalizeAnsmUrl(lienRaw) : '';
  const lienFilterInvalid = Boolean(lienRaw && !normalizedLien);
  const lien_ansm = normalizedLien || undefined;

  return {
    cis,
    cip13,
    code_statut,
    // Date = filtre actif ; critère date fourni mais invalide → ignoré (pas dans hasExactFilters)
    date_mise_a_jour_min: parsedDate instanceof Date ? parsedDate : undefined,
    lien_ansm,
    lienFilterInvalid,
    hasExactFilters: Boolean(
      cis ||
        cip13 ||
        code_statut ||
        parsedDate instanceof Date ||
        lien_ansm ||
        lienFilterInvalid
    )
  };
}

function rowMatchesDisponibiliteFilters(row, filters) {
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
 * @param {object} row - ligne ruptures (toJSON ou record)
 * @param {string|null|undefined} medicineName
 */
function mapRowToDisponibiliteAlert(row, medicineName) {
  const detailUrl = row.lien_ansm ? String(row.lien_ansm).trim() : null;
  return {
    id: buildDisponibiliteAlertId(row),
    medicine_name: medicineName || null,
    status: row.libelle_statut || null,
    updated_at: formatBdpmDateIso(row.date_mise_a_jour),
    expected_return: formatBdpmDateIso(row.date_remise_dispo),
    detail_url: detailUrl || null,
    cis: row.cis || null,
    cip13: row.cip13 ? String(row.cip13).trim() || null : null,
    code_statut: row.code_statut || null
  };
}

function compareDisponibiliteRowsByMajDesc(a, b) {
  const da = parseBdpmDate(a.date_mise_a_jour);
  const db = parseBdpmDate(b.date_mise_a_jour);
  const ta = da ? da.getTime() : 0;
  const tb = db ? db.getTime() : 0;
  if (tb !== ta) return tb - ta;
  return String(a.cis || '').localeCompare(String(b.cis || ''));
}

module.exports = {
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
