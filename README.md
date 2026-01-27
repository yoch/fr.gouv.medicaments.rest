# API REST - Base de données publique des médicaments

![Maintenance](https://img.shields.io/badge/Maintained%3F-yes-green.svg)
![Node.js](https://img.shields.io/badge/Node.js-v20+-green.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Contributions](https://img.shields.io/badge/contributions-welcome-brightgreen.svg)
[![GitHub latest commit](https://badgen.net/github/last-commit/yoch/fr.gouv.medicaments.rest)](https://github.com/yoch/fr.gouv.medicaments.rest/commit/)

API REST publique pour exploiter les données de la base de données publique des médicaments du gouvernement français.

Ce projet est un fork du travail original de **Mathieu Vedie** disponible sur le dépôt [Gizmo091/fr.gouv.medicaments.rest](https://github.com/Gizmo091/fr.gouv.medicaments.rest).

## Fonctionnalités

- ✅ Téléchargement automatique des données (mise à jour toutes les 24h)
- ✅ Fichiers de données inclus dans le repo (fallback si serveur indisponible)
- ✅ Métadonnées de téléchargement stockées dans `data/meta.json`
- ✅ Conversion automatique en UTF-8 pour tous les fichiers
- ✅ Recherche par préfixe et fuzzy (tolérance aux fautes de frappe)
- ✅ Pagination
- ✅ API sans clé d'authentification
- ✅ Réponses JSON
- ✅ Attribution correcte des données gouvernementales

## Endpoints disponibles

### Health Check
- `GET /api/health` - Status de l'API

### Spécialités pharmaceutiques
- `GET /api/medicaments/specialites` - Liste des spécialités
- `GET /api/medicaments/specialites/:cis` - Détail d'une spécialité avec données liées
- `GET /api/medicaments/specialites?q=doliprane` - Recherche (préfixe/approximative)

### Autres endpoints
- `GET /api/medicaments/presentations` - Présentations
- `GET /api/medicaments/compositions` - Compositions
- `GET /api/medicaments/generiques` - Groupes génériques
- `GET /api/medicaments/ruptures` - Ruptures de stock
- `GET /api/medicaments/search?q=aspirine` - Recherche globale

### Paramètres de requête
- `q` - Terme de recherche (supporte prefix search et fuzzy search)
- `page` - Numéro de page (défaut: 1)
- `limit` - Nombre d'éléments par page (défaut: 100, max: 1000)


### Notes

- Le conteneur clone automatiquement la dernière version du repository depuis GitHub
- L'application se met à jour automatiquement au redémarrage du conteneur
## Documentation

- **[API Reference (Markdown)](API_REFERENCE.md)**
- **Swagger UI**: `http://localhost:3000/api-docs`
- **OpenAPI Spec**: `http://localhost:3000/api-docs.json`

## Fonctionnalités Clés
- **Recherche avancée** (supporte prefix search et fuzzy search).
- **Informations de sécurité** et alertes ANSM.
- **Recherche par substance** active.
- **Mise à jour automatique** des données toutes les 24h.
- **Performance** élevée (données en mémoire).

## Installation
- Aucune installation locale de Node.js n'est requise

## Développement local

```bash
npm install
npm run dev
```

## Attribution

Cette API utilise la "base de données publique des médicaments" fournie par le gouvernement français.
