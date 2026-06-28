'use strict';

const express = require('express');
const {
  createListHandler
} = require('../../utils/routeHelpers');
const {
  listCorpusPage,
  search,
  getMetadata,
  isHasAvisLoaded,
  isMitmLoaded
} = require('../../services/dataLoader');

const listHandler = createListHandler({
  getMetadata,
  search,
  listCorpusPage
});

const router = express.Router();

function avisListHandler(dataType) {
  return (req, res) => {
    if (!isHasAvisLoaded()) {
      return res.status(410).json({
        error:
          'Les avis HAS (SMR/ASMR) ne sont pas chargés sur ce serveur (LOAD_HAS_AVIS=false).'
      });
    }
    return listHandler(dataType)(req, res);
  };
}

function mitmListHandler(dataType) {
  return (req, res) => {
    if (!isMitmLoaded()) {
      return res.status(410).json({
        error: 'Les MITM ne sont pas chargés sur ce serveur (LOAD_MITM=false).'
      });
    }
    return listHandler(dataType)(req, res);
  };
}

// GET /api/medicaments/avis-smr
/**
 * @swagger
 * /medicaments/avis-smr:
 *   get:
 *     summary: Liste les avis SMR (Service Médical Rendu)
 *     description: |
 *       Indisponible si `LOAD_HAS_AVIS=false` (réponse **410 Gone**).
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
 *         description: Liste des avis SMR
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
 *                         $ref: '#/components/schemas/AvisSMR'
 *       410:
 *         description: Avis HAS non chargés (`LOAD_HAS_AVIS=false`)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Les avis HAS (SMR/ASMR) ne sont pas chargés sur ce serveur (LOAD_HAS_AVIS=false).
 */
router.get('/avis-smr', avisListHandler('avis_smr'));

// GET /api/medicaments/avis-asmr
/**
 * @swagger
 * /medicaments/avis-asmr:
 *   get:
 *     summary: Liste les avis ASMR (Amélioration du Service Médical Rendu)
 *     description: |
 *       Indisponible si `LOAD_HAS_AVIS=false` (réponse **410 Gone**).
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
 *         description: Liste des avis ASMR
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
 *                         $ref: '#/components/schemas/AvisASMR'
 *       410:
 *         description: Avis HAS non chargés (`LOAD_HAS_AVIS=false`)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Les avis HAS (SMR/ASMR) ne sont pas chargés sur ce serveur (LOAD_HAS_AVIS=false).
 */
router.get('/avis-asmr', avisListHandler('avis_asmr'));

// GET /api/medicaments/interet-therapeutique-majeur
/**
 * @swagger
 * /medicaments/interet-therapeutique-majeur:
 *   get:
 *     summary: Médicaments d'Intérêt Thérapeutique Majeur (MITM)
 *     description: Indisponible si `LOAD_MITM=false` (réponse **410 Gone**).
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
 *         description: Liste des MITM
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
 *                         $ref: '#/components/schemas/MITM'
 */
router.get('/interet-therapeutique-majeur', mitmListHandler('mitm'));

module.exports = router;
