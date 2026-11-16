import express from 'express';
import {
  getDisponibiliteAlertsResult,
  getDisponibiliteAlertDetailResult,
  getDisponibiliteListResult
} from '../../handlers/apiHandlers.mts';

const router = express.Router();

router.get('/disponibilite/alerts', (req, res) => {
  const result = getDisponibiliteAlertsResult(req.query as Record<string, unknown>);
  return res.status(result.status).json(result.json);
});

router.get('/disponibilite/alerts/:alertId', (req, res) => {
  const result = getDisponibiliteAlertDetailResult(req.params.alertId);
  return res.status(result.status).json(result.json);
});

router.get('/disponibilite', (req, res) => {
  const result = getDisponibiliteListResult(req.query as Record<string, unknown>);
  return res.status(result.status).json(result.json);
});

export default router;