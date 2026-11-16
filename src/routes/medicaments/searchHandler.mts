import express from 'express';
import { executeMedicamentSearchRoute } from '../../handlers/apiHandlers.mts';

const router = express.Router();

router.get('/search', (req, res) => {
  const { q, page = 1, limit = 50, source, format, detail, dosage, forme, voie } = req.query;
  const result = executeMedicamentSearchRoute({
    q,
    page,
    limit,
    source,
    format,
    detail,
    dosage,
    forme,
    voie
  });

  if (result.markdown !== undefined) {
    return res.type('text/markdown; charset=utf-8').send(result.markdown);
  }
  return res.status(result.status).json(result.json);
});

export default router;