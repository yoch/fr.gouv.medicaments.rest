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

// GET /api/medicaments/groupes-generiques
/**
 * @swagger
 * /medicaments/groupes-generiques:
 *   get:
 *     summary: Liste les groupes génériques
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
 *         description: Liste des groupes génériques
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
 *                         $ref: '#/components/schemas/GroupeGenerique'
 */
router.get('/groupes-generiques', listHandler('generiques'));

// GET /api/medicaments/conditions
/**
 * @swagger
 * /medicaments/conditions:
 *   get:
 *     summary: Conditions de prescription et de délivrance
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
 *         description: Liste des conditions
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
 *                         $ref: '#/components/schemas/Condition'
 */
router.get('/conditions', listHandler('conditions'));

// GET /api/medicaments/disponibilite
/**
 * @swagger
 * /medicaments/disponibilite:
 *   get:
 *     summary: Disponibilité et ruptures de stock
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
 *         description: Liste des disponibilités
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
 *                         $ref: '#/components/schemas/Disponibilite'
 */
router.get('/disponibilite', listHandler('ruptures'));

// GET /api/medicaments/substances
/**
 * @swagger
 * /medicaments/substances:
 *   get:
 *     summary: Liste les substances actives
 *     tags: [Médicaments]
 *     parameters:
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Liste des substances
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResponse'
 */
router.get('/substances', listHandler('substances'));

module.exports = router;
