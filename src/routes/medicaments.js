const express = require('express');
const {
  listCorpusPage,
  search,
  getMetadata,
  getSpecialiteByCis,
  getRelatedByCis,
  getGeneriquesForCis,
  bdpmExtraitUrl,
  isHasAvisLoaded,
  DETAIL_HYDRATE_RELATED_LIMIT
} = require('../services/dataLoader');
const { executeHybridSearch } = require('../services/searchOrchestrator');
const { shapeSearchResults, normalizeDetail } = require('../utils/searchResponseShape');
const { renderSearchMarkdown, normalizeFormat } = require('../utils/searchMarkdown');

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

function listHandler(dataType, defaultLimit = 100) {
  return (req, res) => {
    const { q, page = 1, limit = defaultLimit } = req.query;
    if (q) {
      const data = search(dataType, q);
      return res.json(paginate(data, page, limit));
    }
    res.json(listCorpusPage(dataType, page, limit));
  };
}

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

// GET /api/medicaments/specialites/:cis
/**
 * @swagger
 * /medicaments/specialites/{cis}:
 *   get:
 *     summary: Détail d'une spécialité
 *     description: |
 *       Retourne la spécialité avec présentations, compositions, conditions et génériques liés.
 *       Si le serveur est démarré avec `LOAD_HAS_AVIS=false` (profil allégé), les champs
 *       `avis_smr` et `avis_asmr` sont **absents** de la réponse. Utiliser les routes
 *       `/medicaments/avis-smr` et `/medicaments/avis-asmr` uniquement lorsque les avis HAS
 *       sont chargés (`LOAD_HAS_AVIS` non défini ou `true`).
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
 *                     conditions:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Condition'
 *                     generiques:
 *                       $ref: '#/components/schemas/GroupeGeneriqueDetail'
 *                     avis_smr:
 *                       type: array
 *                       description: |
 *                         Présent uniquement si `LOAD_HAS_AVIS` n'est pas `false`.
 *                       items:
 *                         $ref: '#/components/schemas/AvisSMR'
 *                     avis_asmr:
 *                       type: array
 *                       description: |
 *                         Présent uniquement si `LOAD_HAS_AVIS` n'est pas `false`.
 *                       items:
 *                         $ref: '#/components/schemas/AvisASMR'
 *       404:
 *         description: Spécialité non trouvée
 */
router.get('/specialites/:cis', (req, res) => {
  const { cis } = req.params;
  const specialite = getSpecialiteByCis(cis);

  if (!specialite) {
    return res.status(404).json({ error: 'Spécialité non trouvée' });
  }

  const detailLimit = DETAIL_HYDRATE_RELATED_LIMIT;
  const presentations = getRelatedByCis('presentations', cis, detailLimit);
  const compositions = getRelatedByCis('compositions', cis, detailLimit);
  const conditions = getRelatedByCis('conditions', cis, detailLimit);
  const generiques = getGeneriquesForCis(cis);

  const metadata = getMetadata();
  const payload = {
    ...specialite,
    presentations,
    compositions,
    conditions,
    generiques,
    metadata: {
      last_updated: metadata.last_updated,
      source: metadata.source
    }
  };

  if (isHasAvisLoaded()) {
    payload.avis_smr = getRelatedByCis('avis_smr', cis, detailLimit);
    payload.avis_asmr = getRelatedByCis('avis_asmr', cis, detailLimit);
  }

  res.json(payload);
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
router.get('/interet-therapeutique-majeur', listHandler('mitm'));

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

// GET /api/medicaments/infos-importantes (désactivé — réactiver avec dataLoader.infos)
// /**
//  * @swagger
//  * /medicaments/infos-importantes:
//  *   get:
//  *     summary: Informations de sécurité importantes
//  *     tags: [Médicaments]
//  *     parameters:
//  *       - in: query
//  *         name: q
//  *         schema:
//  *           type: string
//  *     responses:
//  *       200:
//  *         description: Liste des informations de sécurité
//  *         content:
//  *           application/json:
//  *             schema:
//  *               allOf:
//  *                 - $ref: '#/components/schemas/ApiResponse'
//  */
// router.get('/infos-importantes', listHandler('infos'));

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