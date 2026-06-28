'use strict';

const express = require('express');
const {
  getMetadata,
  getSpecialiteByCis,
  getRelatedByCis,
  getGeneriquesForCis,
  isHasAvisLoaded,
  DETAIL_HYDRATE_RELATED_LIMIT
} = require('../../services/dataLoader');

const router = express.Router();

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

module.exports = router;
