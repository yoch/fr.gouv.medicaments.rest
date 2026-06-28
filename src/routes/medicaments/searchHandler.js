'use strict';

const express = require('express');
const { getMetadata } = require('../../services/dataLoader');
const { executeHybridSearch } = require('../../services/searchOrchestrator');
const { shapeSearchResults, normalizeDetail } = require('../../utils/searchResponseShape');
const { renderSearchMarkdown, normalizeFormat } = require('../../utils/searchMarkdown');
const { createPaginate } = require('../../utils/routeHelpers');

const router = express.Router();
const paginate = createPaginate(getMetadata);

// GET /api/medicaments/search - Recherche globale
/**
 * @swagger
 * /medicaments/search:
 *   get:
 *     summary: Recherche globale
 *     tags: [Médicaments]
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema:
 *           type: string
 *         description: Terme de recherche
 *       - in: query
 *         name: source
 *         schema:
 *           type: string
 *           enum: [auto, human, veterinary, mixed]
 *           default: auto
 *         description: Référentiel(s) à interroger (auto = BDPM puis fallback ANMV)
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *       - in: query
 *         name: format
 *         schema:
 *           type: string
 *           enum: [json, markdown]
 *           default: json
 *         description: "json (défaut) ou markdown (texte compact pour agents LLM)"
 *       - in: query
 *         name: detail
 *         schema:
 *           type: string
 *           enum: [full, summary]
 *           default: full
 *         description: "full = réponse actuelle ; summary = champs réduits, substances dédupliquées, max 3 présentations"
 *     responses:
 *       200:
 *         description: Résultats de recherche (médicaments humains et/ou vétérinaires agrégés avec présentations et compositions)
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: array
 *                       items:
 *                         allOf:
 *                           - $ref: '#/components/schemas/Medicament'
 *                           - type: object
 *                             properties:
 *                               type:
 *                                 type: string
 *                                 example: "medicament"
 *                               presentations:
 *                                 type: array
 *                                 items:
 *                                   $ref: '#/components/schemas/Presentation'
 *                               compositions:
 *                                 type: array
 *                                 items:
 *                                   $ref: '#/components/schemas/Composition'
 *           text/markdown:
 *             schema:
 *               type: string
 */
router.get('/search', (req, res) => {
  const { q, page = 1, limit = 50, source, format, detail } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Paramètre de recherche "q" requis' });
  }

  const { results, search: searchMeta } = executeHybridSearch(q, source);
  const shaped = shapeSearchResults(results, { detail: normalizeDetail(detail) });
  const response = paginate(shaped, page, limit);
  response.search = searchMeta;

  if (normalizeFormat(format) === 'markdown') {
    const markdown = renderSearchMarkdown(response.data, response.pagination, searchMeta);
    return res.type('text/markdown; charset=utf-8').send(markdown);
  }

  res.json(response);
});

module.exports = router;
