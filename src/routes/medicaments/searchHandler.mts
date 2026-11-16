import express from 'express';
import { getMetadata } from '../../services/dataLoader.mts';
import { executeHybridSearchPage } from '../../services/searchOrchestrator.mts';
import { shapeSearchResults, normalizeDetail } from '../../utils/searchResponseShape.mts';
import { renderSearchMarkdown, normalizeFormat } from '../../utils/searchMarkdown.mts';
import { buildPagedResponse } from '../../utils/corpusPaging.mts';

const router = express.Router();

function pickCriterion(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

router.get('/search', (req, res) => {
  const { q, page = 1, limit = 50, source, format, detail, dosage, forme, voie } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Paramètre de recherche "q" requis' });
  }

  const criteria = {
    dosage: pickCriterion(dosage),
    forme: pickCriterion(forme),
    voie: pickCriterion(voie)
  };

  const { results, total, search: searchMeta } = executeHybridSearchPage(
    q,
    source,
    page,
    limit,
    criteria
  );
  const shaped = shapeSearchResults(results, { detail: normalizeDetail(detail) });
  const response = buildPagedResponse({
    total,
    page,
    limit,
    metadata: getMetadata(),
    materializePage: () => shaped
  });
  response.search = searchMeta;

  const activeCriteria = Object.fromEntries(
    Object.entries(criteria).filter(([, value]) => value != null)
  );
  if (Object.keys(activeCriteria).length > 0) {
    response.search.criteria = activeCriteria;
  }

  if (normalizeFormat(format) === 'markdown') {
    const markdown = renderSearchMarkdown(response.data, response.pagination, searchMeta);
    return res.type('text/markdown; charset=utf-8').send(markdown);
  }

  res.json(response);
});

export default router;