'use strict';

/**
 * Annotations OpenAPI pour les routes vétérinaires.
 *
 * Séparées de veterinaires.js pour garder le fichier de routes focalisé
 * sur la logique HTTP. swagger-jsdoc scanne les fichiers sous src/routes
 * et ramasse ces blocs @swagger indépendamment de leur position.
 */

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

module.exports = {};
