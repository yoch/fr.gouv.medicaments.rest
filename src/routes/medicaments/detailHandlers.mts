import express from 'express';
import { getSpecialiteDetailResult } from '../../handlers/apiHandlers.mts';

const router = express.Router();

router.get('/specialites/:cis', (req, res) => {
  const result = getSpecialiteDetailResult(req.params.cis);
  return res.status(result.status).json(result.json);
});

export default router;