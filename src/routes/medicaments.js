const express = require('express');
const { getData, searchInData, getMetadata } = require('../services/dataLoader');

const router = express.Router();

function paginate(data, page = 1, limit = 100) {
  const offset = (page - 1) * limit;
  const paginatedData = data.slice(offset, offset + limit);
  const metadata = getMetadata();

  return {
    data: paginatedData,
    pagination: {
      total: data.length,
      page: parseInt(page),
      limit: parseInt(limit),
      pages: Math.ceil(data.length / limit)
    },
    metadata: {
      last_updated: metadata.last_updated,
      source: metadata.source
    }
  };
}

function sendResponse(res, data, pretty = false) {
  if (pretty === 'true' || pretty === '1') {
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.send(JSON.stringify(data, null, 2));
  } else {
    res.json(data);
  }
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
 *         description: Terme de recherche (supporte * et ?)
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
  const { q, page = 1, limit = 100, pretty } = req.query;
  let data = getData('specialites');

  if (q) {
    data = searchInData(data, q, ['denomination', 'forme_pharma', 'titulaire']);
  }

  sendResponse(res, paginate(data, page, limit), pretty);
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
 *       404:
 *         description: Spécialité non trouvée
 */
router.get('/specialites/:cis', (req, res) => {
  const { cis } = req.params;
  const { pretty } = req.query;
  const specialite = getData('specialites').find(item => item.cis === cis);

  if (!specialite) {
    return res.status(404).json({ error: 'Spécialité non trouvée' });
  }

  // Enrichir avec les données liées
  const presentations = getData('presentations').filter(p => p.cis === cis);
  const compositions = getData('compositions').filter(c => c.cis === cis);
  const avis_smr = getData('avis_smr').filter(a => a.cis === cis);
  const avis_asmr = getData('avis_asmr').filter(a => a.cis === cis);
  const conditions = getData('conditions').filter(c => c.cis === cis);

  const metadata = getMetadata();
  sendResponse(res, {
    ...specialite,
    presentations,
    compositions,
    avis_smr,
    avis_asmr,
    conditions,
    metadata: {
      last_updated: metadata.last_updated,
      source: metadata.source
    }
  }, pretty);
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
  const { q, page = 1, limit = 100, pretty } = req.query;
  let data = getData('presentations');

  if (q) {
    data = searchInData(data, q, ['libelle', 'cip7', 'cip13']);
  }

  sendResponse(res, paginate(data, page, limit), pretty);
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
  const { q, page = 1, limit = 100, pretty } = req.query;
  let data = getData('compositions');

  if (q) {
    data = searchInData(data, q, ['denomination_substance', 'dosage']);
  }

  sendResponse(res, paginate(data, page, limit), pretty);
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
  const { q, page = 1, limit = 100, pretty } = req.query;
  let data = getData('avis_smr');

  if (q) {
    data = searchInData(data, q, ['valeur_smr', 'libelle_smr']);
  }

  sendResponse(res, paginate(data, page, limit), pretty);
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
  const { q, page = 1, limit = 100, pretty } = req.query;
  let data = getData('avis_asmr');

  if (q) {
    data = searchInData(data, q, ['valeur_asmr', 'libelle_asmr']);
  }

  sendResponse(res, paginate(data, page, limit), pretty);
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
  const { q, page = 1, limit = 100, pretty } = req.query;
  let data = getData('generiques');

  if (q) {
    data = searchInData(data, q, ['libelle_groupe']);
  }

  sendResponse(res, paginate(data, page, limit), pretty);
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
  const { q, page = 1, limit = 100, pretty } = req.query;
  let data = getData('conditions');

  if (q) {
    data = searchInData(data, q, ['condition']);
  }

  sendResponse(res, paginate(data, page, limit), pretty);
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
  const { q, page = 1, limit = 100, pretty } = req.query;
  let data = getData('ruptures');

  if (q) {
    data = searchInData(data, q, ['libelle_statut']);
  }

  sendResponse(res, paginate(data, page, limit), pretty);
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
  const { q, page = 1, limit = 100, pretty } = req.query;
  let data = getData('mitm');

  if (q) {
    data = searchInData(data, q, ['denomination']);
  }

  sendResponse(res, paginate(data, page, limit), pretty);
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
  const { q, page = 1, limit = 100, pretty } = req.query;
  let data = getData('substances');

  if (q) {
    data = searchInData(data, q, ['denomination']);
  }

  sendResponse(res, paginate(data, page, limit), pretty);
});

// GET /api/medicaments/infos-importantes
/**
 * @swagger
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
router.get('/infos-importantes', (req, res) => {
  const { q, page = 1, limit = 100, pretty } = req.query;
  let data = getData('infos');

  if (q) {
    data = searchInData(data, q, ['texte_affichage']);
  }

  sendResponse(res, paginate(data, page, limit), pretty);
});

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
 *         description: Résultats de recherche
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResponse'
 */
router.get('/search', (req, res) => {
  const { q, page = 1, limit = 50, pretty } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Paramètre de recherche "q" requis' });
  }

  const specialites = searchInData(getData('specialites'), q, ['denomination', 'forme_pharma', 'titulaire']);
  const presentations = searchInData(getData('presentations'), q, ['libelle']);
  const compositions = searchInData(getData('compositions'), q, ['denomination_substance']);

  const results = [
    ...specialites.map(item => ({ ...item, type: 'specialite' })),
    ...presentations.map(item => ({ ...item, type: 'presentation' })),
    ...compositions.map(item => ({ ...item, type: 'composition' }))
  ];

  sendResponse(res, paginate(results, page, limit), pretty);
});

module.exports = router;