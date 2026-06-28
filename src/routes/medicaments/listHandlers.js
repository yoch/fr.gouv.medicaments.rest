'use strict';

const express = require('express');
const {
  createListHandler,
  createPaginate
} = require('../../utils/routeHelpers');
const {
  listCorpusPage,
  search,
  getMetadata
} = require('../../services/dataLoader');

const paginate = createPaginate(getMetadata);
const listHandler = createListHandler({
  getMetadata,
  search,
  listCorpusPage
});

const router = express.Router();

// GET /api/medicaments/specialites
/**
 * @swagger
 * /medicaments/specialites:
 *   get:
 *     summary: Liste les spécialités pharmaceutiques
 *     tags: [Médicaments]
 *     parameters:
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *         description: Terme de recherche (recherche par début de mot et approximative)
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Numéro de page
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Nombre d'éléments par page
 *     responses:
 *       200:
 *         description: Liste des spécialités
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
 *                         $ref: '#/components/schemas/Medicament'
 */
router.get('/specialites', listHandler('specialites'));

// GET /api/medicaments/presentations
/**
 * @swagger
 * /medicaments/presentations:
 *   get:
 *     summary: Liste les présentations
 *     tags: [Médicaments]
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
 *         description: Liste des présentations
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
 *                         $ref: '#/components/schemas/Presentation'
 */
router.get('/presentations', listHandler('presentations'));

// GET /api/medicaments/compositions
/**
 * @swagger
 * /medicaments/compositions:
 *   get:
 *     summary: Liste les compositions
 *     tags: [Médicaments]
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
 *         description: Liste des compositions
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
 *                         $ref: '#/components/schemas/Composition'
 */
router.get('/compositions', listHandler('compositions'));

module.exports = router;
