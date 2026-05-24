const express = require('express');
const {
  getData,
  search,
  getMetadata,
  getSpecialiteByCis,
  getRelatedByCis,
  getGeneriquesForCis
} = require('../services/dataLoader');

const router = express.Router();

const MAX_LIMIT = 1000;

function paginate(data, page = 1, limit = 100) {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(MAX_LIMIT, Math.max(1, parseInt(limit, 10) || 100));
  const offset = (safePage - 1) * safeLimit;
  const paginatedData = data.slice(offset, offset + safeLimit);
  const metadata = getMetadata();

  return {
    data: paginatedData,
    pagination: {
      total: data.length,
      page: safePage,
      limit: safeLimit,
      pages: Math.ceil(data.length / safeLimit)
    },
    metadata: {
      last_updated: metadata.last_updated,
      source: metadata.source
    }
  };
}



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
router.get('/specialites', (req, res) => {
  const { q, page = 1, limit = 100 } = req.query;
  let data = getData('specialites');

  if (q) {
    data = search('specialites', q);
  }

  res.json(paginate(data, page, limit));
});

// GET /api/medicaments/specialites/:cis
/**
 * @swagger
 * /medicaments/specialites/{cis}:
 *   get:
 *     summary: Détail d'une spécialité
 *     tags: [Médicaments]
 *     parameters:
 *       - in: path
 *         name: cis
 *         required: true
 *         schema:
 *           type: string
 *         description: Code Identifiant de Spécialité
 *     responses:
 *       200:
 *         description: Détail complet du médicament
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Medicament'
 *                 - type: object
 *                   properties:
 *                     presentations:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Presentation'
 *                     compositions:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Composition'
 *                     generiques:
 *                       $ref: '#/components/schemas/GroupeGeneriqueDetail'
 *       404:
 *         description: Spécialité non trouvée
 */
router.get('/specialites/:cis', (req, res) => {
  const { cis } = req.params;
  const specialite = getSpecialiteByCis(cis);

  if (!specialite) {
    return res.status(404).json({ error: 'Spécialité non trouvée' });
  }

  const presentations = getRelatedByCis('presentations', cis);
  const compositions = getRelatedByCis('compositions', cis);
  const avis_smr = getRelatedByCis('avis_smr', cis);
  const avis_asmr = getRelatedByCis('avis_asmr', cis);
  const conditions = getRelatedByCis('conditions', cis);
  const generiques = getGeneriquesForCis(cis);

  const metadata = getMetadata();
  res.json({
    ...specialite,
    presentations,
    compositions,
    avis_smr,
    avis_asmr,
    conditions,
    generiques,
    metadata: {
      last_updated: metadata.last_updated,
      source: metadata.source
    }
  });
});

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
router.get('/presentations', (req, res) => {
  const { q, page = 1, limit = 100 } = req.query;
  let data = getData('presentations');

  if (q) {
    data = search('presentations', q);
  }

  res.json(paginate(data, page, limit));
});

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
router.get('/compositions', (req, res) => {
  const { q, page = 1, limit = 100 } = req.query;
  let data = getData('compositions');

  if (q) {
    data = search('compositions', q);
  }

  res.json(paginate(data, page, limit));
});

// GET /api/medicaments/avis-smr
/**
 * @swagger
 * /medicaments/avis-smr:
 *   get:
 *     summary: Liste les avis SMR (Service Médical Rendu)
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
 */
router.get('/avis-smr', (req, res) => {
  const { q, page = 1, limit = 100 } = req.query;
  let data = getData('avis_smr');

  if (q) {
    data = search('avis_smr', q);
  }

  res.json(paginate(data, page, limit));
});

// GET /api/medicaments/avis-asmr
/**
 * @swagger
 * /medicaments/avis-asmr:
 *   get:
 *     summary: Liste les avis ASMR (Amélioration du Service Médical Rendu)
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
 */
router.get('/avis-asmr', (req, res) => {
  const { q, page = 1, limit = 100 } = req.query;
  let data = getData('avis_asmr');

  if (q) {
    data = search('avis_asmr', q);
  }

  res.json(paginate(data, page, limit));
});

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
router.get('/groupes-generiques', (req, res) => {
  const { q, page = 1, limit = 100 } = req.query;
  let data = getData('generiques');

  if (q) {
    data = search('generiques', q);
  }

  res.json(paginate(data, page, limit));
});

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
router.get('/conditions', (req, res) => {
  const { q, page = 1, limit = 100 } = req.query;
  let data = getData('conditions');

  if (q) {
    data = search('conditions', q);
  }

  res.json(paginate(data, page, limit));
});

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
router.get('/disponibilite', (req, res) => {
  const { q, page = 1, limit = 100 } = req.query;
  let data = getData('ruptures');

  if (q) {
    data = search('ruptures', q);
  }

  res.json(paginate(data, page, limit));
});

// GET /api/medicaments/interet-therapeutique-majeur
/**
 * @swagger
 * /medicaments/interet-therapeutique-majeur:
 *   get:
 *     summary: Médicaments d'Intérêt Thérapeutique Majeur (MITM)
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
router.get('/interet-therapeutique-majeur', (req, res) => {
  const { q, page = 1, limit = 100 } = req.query;
  let data = getData('mitm');

  if (q) {
    data = search('mitm', q);
  }

  res.json(paginate(data, page, limit));
});

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
router.get('/substances', (req, res) => {
  const { q, page = 1, limit = 100 } = req.query;
  let data = getData('substances');

  if (q) {
    data = search('substances', q);
  }

  res.json(paginate(data, page, limit));
});

// GET /api/medicaments/infos-importantes
/**
 * @/swagger
 * /medicaments/infos-importantes:
 *   get:
 *     summary: Informations de sécurité importantes
 *     tags: [Médicaments]
 *     parameters:
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Liste des informations de sécurité
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResponse'
 */
/*
router.get('/infos-importantes', (req, res) => {
  const { q, page = 1, limit = 100 } = req.query;
  let data = getData('infos');

  if (q) {
    data = search('infos', q);
  }

  res.json(paginate(data, page, limit));
});
*/

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
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *     responses:
 *       200:
 *         description: Résultats de recherche (Liste structurée de médicaments avec leurs présentations et compositions)
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
 */
router.get('/search', (req, res) => {
  const { q, page = 1, limit = 50 } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Paramètre de recherche "q" requis' });
  }

  const specialites = search('specialites', q);
  const presentations = search('presentations', q);
  const compositions = search('compositions', q);

  const matchQualityRank = { exact: 3, prefix: 2, fuzzy: 1 };
  const matchQualityByCis = {};
  for (const item of [...specialites, ...presentations, ...compositions]) {
    const previous = matchQualityByCis[item.cis];
    if (!previous || matchQualityRank[item.match_quality] > matchQualityRank[previous]) {
      matchQualityByCis[item.cis] = item.match_quality;
    }
  }

  // Ordre des CIS : insertion via specialites puis presentations puis compositions (inchangé)
  const matchedCis = new Set(Object.keys(matchQualityByCis));

  const results = Array.from(matchedCis).map(cis => ({
    type: 'medicament',
    match_quality: matchQualityByCis[cis],
    ...(getSpecialiteByCis(cis) || { cis }),
    presentations: getRelatedByCis('presentations', cis),
    compositions: getRelatedByCis('compositions', cis)
  }));

  const response = paginate(results, page, limit);
  response.search = { query: q };
  res.json(response);
});

module.exports = router;