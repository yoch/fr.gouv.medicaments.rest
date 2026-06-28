const express = require('express');
const {
  listVetCorpusPage,
  listPresentationsPage,
  searchVet,
  getVetMetadata,
  getMedicamentByNum,
  getRelatedByNum
} = require('../services/vetDataLoader');
const config = require('../config');
const { createPaginate } = require('../utils/routeHelpers');

const router = express.Router();

const paginate = createPaginate(getVetMetadata);

function listHandler(dataType, defaultLimit = 100) {
  return (req, res) => {
    const { q, page = 1, limit = defaultLimit } = req.query;
    if (q) {
      if (dataType === 'presentations') {
        return res.json(listPresentationsPage(q, page, limit));
      }
      const data = searchVet(dataType, q);
      return res.json(paginate(data, page, limit));
    }
    res.json(listVetCorpusPage(dataType, page, limit));
  };
}

// GET /api/veterinaires/medicaments
/**
 * @swagger
 * /veterinaires/medicaments:
 *   get:
 *     summary: Liste les médicaments vétérinaires (ANMV)
 *     tags: [Vétérinaires]
 *     parameters:
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *         description: Terme de recherche (nom ou numéro AMM)
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *     responses:
 *       200:
 *         description: Liste des médicaments vétérinaires
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
 *                         $ref: '#/components/schemas/MedicamentVeterinaire'
 */
router.get('/medicaments', listHandler('medicaments'));

// GET /api/veterinaires/medicaments/{num}
/**
 * @swagger
 * /veterinaires/medicaments/{num}:
 *   get:
 *     summary: Détail d'un médicament vétérinaire
 *     description: |
 *       Retourne le médicament avec présentations, compositions et temps d'attente liés.
 *     tags: [Vétérinaires]
 *     parameters:
 *       - in: path
 *         name: num
 *         required: true
 *         schema:
 *           type: string
 *         description: Numéro AMM (7 chiffres, complété par des zéros à gauche si nécessaire)
 *     responses:
 *       200:
 *         description: Détail complet du médicament vétérinaire
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/MedicamentVeterinaire'
 *                 - type: object
 *                   properties:
 *                     presentations:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/PresentationVeterinaire'
 *                     compositions:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/CompositionVeterinaire'
 *                     temps_attente:
 *                       type: array
 *                       items:
 *                         type: object
 *       404:
 *         description: Médicament vétérinaire non trouvé
 */
router.get('/medicaments/:num', (req, res) => {
  const medicament = getMedicamentByNum(req.params.num);
  if (!medicament) {
    return res.status(404).json({ error: 'Médicament vétérinaire non trouvé' });
  }

  const metadata = getVetMetadata();
  res.json({
    ...medicament,
    presentations: getRelatedByNum('presentations', req.params.num, config.detailHydrateRelatedLimit),
    compositions: getRelatedByNum('compositions', req.params.num, config.detailHydrateRelatedLimit),
    temps_attente: getRelatedByNum('temps_attente', req.params.num, config.detailHydrateRelatedLimit),
    metadata: {
      last_updated: metadata.last_updated,
      source: metadata.source
    }
  });
});

// GET /api/veterinaires/compositions
/**
 * @swagger
 * /veterinaires/compositions:
 *   get:
 *     summary: Liste les compositions vétérinaires
 *     tags: [Vétérinaires]
 *     parameters:
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *     responses:
 *       200:
 *         description: Liste des compositions vétérinaires
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
 *                         $ref: '#/components/schemas/CompositionVeterinaire'
 */
router.get('/compositions', listHandler('compositions'));

// GET /api/veterinaires/presentations
/**
 * @swagger
 * /veterinaires/presentations:
 *   get:
 *     summary: Liste les présentations vétérinaires (scan linéaire sur libellé/GTIN)
 *     tags: [Vétérinaires]
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema:
 *           type: string
 *         description: Sous-chaîne recherchée dans le libellé ou le GTIN
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *     responses:
 *       200:
 *         description: Liste des présentations vétérinaires
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
 *                         $ref: '#/components/schemas/PresentationVeterinaire'
 */
router.get('/presentations', listHandler('presentations'));

module.exports = router;
