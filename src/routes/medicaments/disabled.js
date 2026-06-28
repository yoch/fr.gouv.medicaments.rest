'use strict';

/**
 * Réserve d'endpoints BDPM désactivés.
 *
 * Ces endpoints ne sont PAS branchés au routeur — conservés en commentaire
 * pour réactivation rapide en cas de changement d'avis. Pour réactiver :
 *   1. Implémenter le support du type de corpus côté loader (ex. `dataLoader.infos`)
 *   2. Décommenter le bloc ci-dessous et le déplacer dans `index.js`
 *
 * Ne pas supprimer ce fichier sans discussion explicite.
 */

const express = require('express');

// const { listHandler } = require('./handlers');
// const router = express.Router();

// GET /api/medicaments/infos-importantes
// Réactivation condition : dataLoader doit supporter le type 'infos'
// (parser CIS_InfoImportantes.txt + index FrozenMiniSearch + corpus record).
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

// module.exports = router;
