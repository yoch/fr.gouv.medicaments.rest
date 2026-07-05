'use strict';

const express = require('express');
const { getMetadata } = require('../../services/dataLoader');
const { executeHybridSearchPage } = require('../../services/searchOrchestrator');
const { shapeSearchResults, normalizeDetail } = require('../../utils/searchResponseShape');
const { renderSearchMarkdown, normalizeFormat } = require('../../utils/searchMarkdown');
const { buildPagedResponse } = require('../../utils/corpusPaging');

const router = express.Router();

router.get('/search', (req, res) => {
  const { q, page = 1, limit = 50, source, format, detail } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Paramètre de recherche "q" requis' });
  }

  const { results, total, search: searchMeta } = executeHybridSearchPage(q, source, page, limit);
  const shaped = shapeSearchResults(results, { detail: normalizeDetail(detail) });
  const response = buildPagedResponse({
    total,
    page,
    limit,
    metadata: getMetadata(),
    materializePage: () => shaped
  });
  response.search = searchMeta;

  if (normalizeFormat(format) === 'markdown') {
    const markdown = renderSearchMarkdown(response.data, response.pagination, searchMeta);
    return res.type('text/markdown; charset=utf-8').send(markdown);
  }

  res.json(response);
});

module.exports = router;
