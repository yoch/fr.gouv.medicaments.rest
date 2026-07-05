# API REST - Base de données publique des médicaments

![Maintenance](https://img.shields.io/badge/Maintained%3F-yes-green.svg)
![Node.js](https://img.shields.io/badge/Node.js-v20+-green.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Contributions](https://img.shields.io/badge/contributions-welcome-brightgreen.svg)
[![GitHub latest commit](https://badgen.net/github/last-commit/yoch/fr.gouv.medicaments.rest)](https://github.com/yoch/fr.gouv.medicaments.rest/commit/)

API REST publique pour exploiter les données de la base de données publique des médicaments du gouvernement français.

Ce projet est un fork du travail original de **Mathieu Vedie** disponible sur le dépôt [Gizmo091/fr.gouv.medicaments.rest](https://github.com/Gizmo091/fr.gouv.medicaments.rest).

## Fonctionnalités

- ✅ Fichiers de données inclus dans le repo (fallback si source indisponible)
- ✅ Téléchargement automatique des données (mise à jour toutes les 24h)
- ✅ Conversion automatique en UTF-8 pour tous les fichiers
- ✅ Recherche par préfixe et fuzzy (tolérance aux fautes de frappe)
- ✅ Pagination
- ✅ Réponses JSON

## Endpoints disponibles

### Health Check
- `GET /health` — status de l'API et mémoire processus

### Spécialités pharmaceutiques
- `GET /api/medicaments/specialites` - Liste des spécialités
- `GET /api/medicaments/specialites/:cis` - Détail d'une spécialité avec données liées
- `GET /api/medicaments/specialites?q=doliprane` - Recherche (préfixe/approximative)

### Autres endpoints
- `GET /api/medicaments/presentations` - Présentations
- `GET /api/medicaments/compositions` - Compositions
- `GET /api/medicaments/avis-smr` - Avis SMR
- `GET /api/medicaments/avis-asmr` - Avis ASMR
- `GET /api/medicaments/groupes-generiques` - Groupes génériques
- `GET /api/medicaments/conditions` - Conditions de prescription
- `GET /api/medicaments/disponibilite` - Ruptures de stock
- `GET /api/medicaments/interet-therapeutique-majeur` - MITM
- `GET /api/medicaments/substances` - Substances actives
- `GET /api/medicaments/search?q=aspirine` - Recherche globale (BDPM, avec fallback ANMV en `source=auto`)
- `GET /api/medicaments/search?q=sultrian&source=veterinary` - Recherche vétérinaire uniquement
- `GET /api/medicaments/search?q=doliprane&limit=10&format=markdown&detail=summary` - Format compact pour agents LLM

### Médicaments vétérinaires (ANMV / Anses)
- `GET /api/veterinaires/medicaments` - Liste / recherche par nom
- `GET /api/veterinaires/medicaments/:num` - Détail d'un médicament vétérinaire
- `GET /api/veterinaires/compositions` - Recherche par substance active
- `GET /api/veterinaires/presentations` - Présentations (filtre libellé / GTIN)

### Paramètres de requête
- `q` - Terme de recherche (supporte prefix search et fuzzy search)
- `page` - Numéro de page (défaut: 1)
- `limit` - Nombre d'éléments par page (défaut: 100, max: 1000)
- `source` - Sur `/api/medicaments/search` : `auto` (défaut), `human`, `veterinary`, `mixed`
- `format` - Sur `/api/medicaments/search` : `json` (défaut), `markdown`
- `detail` - Sur `/api/medicaments/search` : `full` (défaut), `summary`

## Documentation

- **[API Reference (Markdown)](API_REFERENCE.md)**
- **Swagger UI**: `http://localhost:3000/api-docs`
- **OpenAPI Spec**: `http://localhost:3000/api-docs.json`

## Usage bibliothèque

Le point d'entrée npm (`require('fr.gouv.medicaments.rest')`) est sans effet de bord : il ne télécharge pas les données, ne charge pas les corpus et ne démarre pas de serveur.

```js
const { createApp, bdpm, vet, executeHybridSearch } = require('fr.gouv.medicaments.rest');

const app = createApp();

await bdpm.loadData();
await vet.loadVetData();

const { results } = executeHybridSearch('doliprane', 'auto');
```

Les exports publics exposent les façades BDPM/ANMV et la création d'app Express. Les états mutables internes ne font pas partie de l'API publique.

## Développement local

```bash
npm install
npm run dev
```

## Validation

```bash
npm test -- --runInBand
npm run test:all
npx knip
```

`npm test` garde les tests lourds désactivés. `npm run test:all` charge les corpus et valide les contrats HTTP complets.

## Attribution

Cette API utilise la ["base de données publique des médicaments"](https://www.data.gouv.fr/datasets/base-de-donnees-publique-des-medicaments-base-officielle) fournie par le gouvernement français.
