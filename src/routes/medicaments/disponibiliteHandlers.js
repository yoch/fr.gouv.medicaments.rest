'use strict';

const express = require('express');
const {
  listDisponibilitePage,
  listDisponibiliteAlerts,
  getDisponibiliteAlertById
} = require('../../services/bdpm/disponibiliteService');
const { parseDisponibiliteFilters } = require('../../utils/disponibiliteQuery');

const router = express.Router();

function rejectInvalidLienFilter(filters, res) {
  if (!filters.lienFilterInvalid) return false;
  res.status(400).json({
    error: 'Paramètre lien_ansm invalide ou non normalisable'
  });
  return true;
}

router.get('/disponibilite/alerts', (req, res) => {
  const { page = 1, limit = 30 } = req.query;
  const filters = parseDisponibiliteFilters(req.query);
  if (rejectInvalidLienFilter(filters, res)) return;
  res.json(listDisponibiliteAlerts({ filters, page, limit }));
});

router.get('/disponibilite/alerts/:alertId', (req, res) => {
  const detail = getDisponibiliteAlertById(req.params.alertId);
  if (!detail) {
    return res.status(404).json({ error: 'Alerte de disponibilité non trouvée' });
  }
  res.json(detail);
});

router.get('/disponibilite', (req, res) => {
  const { q, page = 1, limit = 100 } = req.query;
  const filters = parseDisponibiliteFilters(req.query);
  if (rejectInvalidLienFilter(filters, res)) return;
  res.json(listDisponibilitePage({ q, filters, page, limit }));
});

module.exports = router;
