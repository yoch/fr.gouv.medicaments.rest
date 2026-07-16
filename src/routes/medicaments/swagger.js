'use strict';

/**
 * Annotations OpenAPI pour les routes BDPM (medicaments).
 *
 * Centralisées ici plutôt que éparpillées dans les fichiers de handlers —
 * ces derniers restent focalisés sur la logique HTTP. swagger-jsdoc scanne
 * les fichiers sous src/routes et ramasse les blocs @swagger.
 */

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

/**
 * @swagger
 * /medicaments/disponibilite:
 *   get:
 *     summary: Disponibilité et ruptures de stock (fichier BDPM CIS_CIP_Dispo_Spec)
 *     description: |
 *       Source BDPM structurée (CIS, CIP13, statuts, dates, lien ANSM).
 *       Pour le MVP tools chat, préférer `/medicaments/disponibilite/alerts`.
 *       Les dates restent au format source `JJ/MM/AAAA`. Voir docs/MVP_BDPM_DISPONIBILITE.md.
 *     tags: [Médicaments]
 *     parameters:
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *         description: Recherche textuelle (libellé de statut)
 *       - in: query
 *         name: cis
 *         schema:
 *           type: string
 *         description: Filtre exact sur le CIS
 *       - in: query
 *         name: cip13
 *         schema:
 *           type: string
 *         description: Filtre exact sur le CIP13 (souvent absent si toute la spécialité est concernée)
 *       - in: query
 *         name: code_statut
 *         schema:
 *           type: string
 *           enum: ['1', '2', '3', '4']
 *         description: |
 *           1 = Rupture de stock, 2 = Tension d'approvisionnement,
 *           3 = Arrêt de commercialisation, 4 = Remise à disposition.
 *           Préférer ce filtre au libellé (typos source possibles).
 *       - in: query
 *         name: date_mise_a_jour_min
 *         schema:
 *           type: string
 *         description: |
 *           Garde les entrées dont `date_mise_a_jour` ≥ cette date.
 *           Accepte `JJ/MM/AAAA` ou `YYYY-MM-DD`. Ne simule pas une date absente.
 *       - in: query
 *         name: lien_ansm
 *         schema:
 *           type: string
 *           format: uri
 *         description: |
 *           Filtre sur l'URL de fiche ANSM (normalisée : sans www, query, hash, slash final).
 *           Une URL peut correspondre à plusieurs CIS.
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
 *             examples:
 *               rupture:
 *                 summary: Rupture de stock
 *                 value:
 *                   data:
 *                     - cis: '64805678'
 *                       code_statut: '1'
 *                       libelle_statut: Rupture de stock
 *                       date_debut: '14/02/2024'
 *                       date_mise_a_jour: '10/07/2026'
 *                       lien_ansm: https://ansm.sante.fr/disponibilites-des-produits-de-sante/medicaments/exemple
 *                   pagination:
 *                     total: 1
 *                     page: 1
 *                     limit: 100
 *                     pages: 1
 *               remise:
 *                 summary: Remise à disposition
 *                 value:
 *                   data:
 *                     - cis: '65643371'
 *                       code_statut: '4'
 *                       libelle_statut: Remise à disposition
 *                       date_debut: '15/06/2026'
 *                       date_mise_a_jour: '15/06/2026'
 *                       date_remise_dispo: '15/06/2026'
 *                       lien_ansm: https://ansm.sante.fr/disponibilites-des-produits-de-sante/medicaments/exemple
 */

/**
 * @swagger
 * /medicaments/disponibilite/alerts:
 *   get:
 *     summary: Alertes de disponibilité (forme tool MVP BDPM)
 *     description: |
 *       Surface tool-ready pour `get_bdpm_disponibilite_alerts`.
 *       Tri par `date_mise_a_jour` décroissante. Pas de `medical_domain`.
 *       Voir docs/MVP_BDPM_DISPONIBILITE.md.
 *     tags: [Médicaments]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 30
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: cis
 *         schema:
 *           type: string
 *       - in: query
 *         name: cip13
 *         schema:
 *           type: string
 *       - in: query
 *         name: code_statut
 *         schema:
 *           type: string
 *           enum: ['1', '2', '3', '4']
 *       - in: query
 *         name: date_mise_a_jour_min
 *         schema:
 *           type: string
 *       - in: query
 *         name: lien_ansm
 *         schema:
 *           type: string
 *           format: uri
 *     responses:
 *       200:
 *         description: Liste d'alertes MVP
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 generated_at:
 *                   type: string
 *                   format: date-time
 *                 data_last_updated_at:
 *                   type: string
 *                   format: date-time
 *                 alerts_count:
 *                   type: integer
 *                 alerts:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       medicine_name:
 *                         type: string
 *                         nullable: true
 *                       status:
 *                         type: string
 *                       updated_at:
 *                         type: string
 *                         nullable: true
 *                       expected_return:
 *                         type: string
 *                         nullable: true
 *                       detail_url:
 *                         type: string
 *                         nullable: true
 *                       cis:
 *                         type: string
 *                       cip13:
 *                         type: string
 *                         nullable: true
 *                       code_statut:
 *                         type: string
 *                 pagination:
 *                   type: object
 */

/**
 * @swagger
 * /medicaments/disponibilite/alerts/{alertId}:
 *   get:
 *     summary: Détail d'une alerte de disponibilité (MVP BDPM)
 *     description: |
 *       Surface tool-ready pour `get_bdpm_disponibilite_details`.
 *       `alertId` = hash opaque 12 hex renvoyé par la liste.
 *     tags: [Médicaments]
 *     parameters:
 *       - in: path
 *         name: alertId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Détail alerte + spécialité + ruptures CIS
 *       404:
 *         description: Alerte non trouvée
 */

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

/**
 * @swagger
 * /medicaments/avis-smr:
 *   get:
 *     summary: Liste les avis SMR (Service Médical Rendu)
 *     description: |
 *       Indisponible si LOAD_HAS_AVIS=false (réponse 410 Gone).
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
 *         description: Avis HAS non chargés (LOAD_HAS_AVIS=false)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Les avis HAS (SMR/ASMR) ne sont pas chargés sur ce serveur (LOAD_HAS_AVIS=false).
 */

/**
 * @swagger
 * /medicaments/avis-asmr:
 *   get:
 *     summary: Liste les avis ASMR (Amélioration du Service Médical Rendu)
 *     description: |
 *       Indisponible si LOAD_HAS_AVIS=false (réponse 410 Gone).
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
 *         description: Avis HAS non chargés (LOAD_HAS_AVIS=false)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Les avis HAS (SMR/ASMR) ne sont pas chargés sur ce serveur (LOAD_HAS_AVIS=false).
 */

/**
 * @swagger
 * /medicaments/interet-therapeutique-majeur:
 *   get:
 *     summary: Médicaments d'Intérêt Thérapeutique Majeur (MITM)
 *     description: Indisponible si LOAD_MITM=false (réponse 410 Gone).
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

/**
 * @swagger
 * /medicaments/specialites/{cis}:
 *   get:
 *     summary: Détail d'une spécialité
 *     description: |
 *       Retourne la spécialité avec présentations, compositions, conditions, ruptures
 *       (disponibilité BDPM) et génériques liés.
 *       Si le serveur est démarré avec LOAD_HAS_AVIS=false (profil allégé), les champs
 *       avis_smr et avis_asmr sont absents de la réponse. Utiliser les routes
 *       /medicaments/avis-smr et /medicaments/avis-asmr uniquement lorsque les avis HAS
 *       sont chargés (LOAD_HAS_AVIS non défini ou true).
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
 *                     ruptures:
 *                       type: array
 *                       description: Lignes CIS_CIP_Dispo_Spec liées à ce CIS
 *                       items:
 *                         $ref: '#/components/schemas/Disponibilite'
 *                     generiques:
 *                       $ref: '#/components/schemas/GroupeGeneriqueDetail'
 *                     avis_smr:
 *                       type: array
 *                       description: |
 *                         Présent uniquement si LOAD_HAS_AVIS n'est pas false.
 *                       items:
 *                         $ref: '#/components/schemas/AvisSMR'
 *                     avis_asmr:
 *                       type: array
 *                       description: |
 *                         Présent uniquement si LOAD_HAS_AVIS n'est pas false.
 *                       items:
 *                         $ref: '#/components/schemas/AvisASMR'
 *       404:
 *         description: Spécialité non trouvée
 */

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
 *       - in: query
 *         name: dosage
 *         schema:
 *           type: string
 *         description: "Critère de scoring optionnel (non filtrant). Ex. '1 g', '500 mg'. Comparé au dosage présent dans la dénomination ; réordonne à l'intérieur d'un même niveau de pertinence sans écarter de résultats."
 *       - in: query
 *         name: forme
 *         schema:
 *           type: string
 *         description: "Critère de scoring optionnel (non filtrant). Ex. 'comprimé', 'solution injectable'. Comparé à forme_pharma."
 *       - in: query
 *         name: voie
 *         schema:
 *           type: string
 *         description: "Critère de scoring optionnel (non filtrant). Ex. 'orale', 'cutanée'. Comparé à voies_admin."
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

module.exports = {};
