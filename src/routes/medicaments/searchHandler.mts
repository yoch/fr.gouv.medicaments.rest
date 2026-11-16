import express from 'express';
import { getMetadata } from '../../services/dataLoader.mts';
import { executeHybridSearchPage } from '../../services/searchOrchestrator.mts';
import { shapeSearchResults, normalizeDetail } from '../../utils/searchResponseShape.mts';
import { renderSearchMarkdown, normalizeFormat } from '../../utils/searchMarkdown.mts';
import { buildPagedResponse } from '../../utils/corpusPaging.mts';

const router = express.Router();

function pickCriterion(value: unknown): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

function buildActiveCriteria(
  dosage: string | null,
  forme: string | null,
  voie: string | null
): Record<string, string> | undefined {
  if (!dosage && !forme && !voie) return undefined;
  const active: Record<string, string> = {};
  if (dosage) active.dosage = dosage;
  if (forme) active.forme = forme;
  if (voie) active.voie = voie;
  return active;
}

router.get('/search', (req, res) => {
  const { q, page = 1, limit = 50, source, format, detail, dosage, forme, voie } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Paramètre de recherche "q" requis' });
  }

  const dosageValue = pickCriterion(dosage);
  const formeValue = pickCriterion(forme);
  const voieValue = pickCriterion(voie);
  const criteria = {
    dosage: dosageValue,
    forme: formeValue,
    voie: voieValue
  };
  const activeCriteria = buildActiveCriteria(dosageValue, formeValue, voieValue);

  const { results, total, search: searchMeta } = executeHybridSearchPage(
    String(q),
    source,
    page,
    limit,
    criteria,
    activeCriteria
  );
  const shaped = shapeSearchResults(results, { detail: normalizeDetail(detail) });
  const response = buildPagedResponse({
    total,
    page,
    limit,
    metadata: getMetadata(),
    materializePage: () => shaped,
    search: searchMeta
  });

  if (normalizeFormat(format) === 'markdown') {
    const markdown = renderSearchMarkdown(response.data, response.pagination, searchMeta);
    return res.type('text/markdown; charset=utf-8').send(markdown);
  }

  res.json(response);
});

export default router;