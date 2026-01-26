# API REST - Base de données publique des médicaments

![Maintenance](https://img.shields.io/badge/Maintained%3F-yes-green.svg)
![Maintainer](https://img.shields.io/badge/maintainer-Mathieu%20Vedie-blue)
![Node.js](https://img.shields.io/badge/Node.js-v18+-green.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Contributions](https://img.shields.io/badge/contributions-welcome-brightgreen.svg)

[![GitHub latest commit](https://badgen.net/github/last-commit/Gizmo091/fr.gouv.medicaments.rest)](https://github.com/Gizmo091/fr.gouv.medicaments.rest/commit/)

[!["Buy Me A Coffee"](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://www.buymeacoffee.com/mathieuvedie)

API REST publique pour exploiter les données de la base de données publique des médicaments du gouvernement français.

## 🌐 Démo en ligne

**Service hébergé à titre d'exemple :** [bdpmgf.vedielaute.fr](http://bdpmgf.vedielaute.fr)

> ⚠️ Ce service de démonstration est fourni à titre d'exemple uniquement. Pour un usage en production, nous recommandons d'héberger votre propre instance.

## Fonctionnalités

- ✅ Téléchargement automatique des données (mise à jour toutes les 24h)
- ✅ Fichiers de données inclus dans le repo (fallback si serveur indisponible)
- ✅ Métadonnées de téléchargement stockées dans `data/meta.json`
- ✅ Conversion automatique en UTF-8 pour tous les fichiers
- ✅ Recherche avec wildcards (* et ?)
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
- `GET /api/medicaments/specialites?q=doliprane*` - Recherche avec wildcard

### Autres endpoints
- `GET /api/medicaments/presentations` - Présentations
- `GET /api/medicaments/compositions` - Compositions
- `GET /api/medicaments/generiques` - Groupes génériques
- `GET /api/medicaments/ruptures` - Ruptures de stock
- `GET /api/medicaments/search?q=aspirine` - Recherche globale

### Paramètres de requête
- `q` - Terme de recherche (supporte * et ?)
- `page` - Numéro de page (défaut: 1)
- `limit` - Nombre d'éléments par page (défaut: 100, max: 1000)
- `pretty` - Formatage JSON (true/1 pour JSON indenté)

## Démarrage avec Docker

### Méthode rapide (sans cloner le repo)

```bash
# Télécharger uniquement le docker-compose.yml
curl -O https://raw.githubusercontent.com/Gizmo091/fr.gouv.medicaments.rest/main/docker-compose.yml

# Lancer le service (le repo sera cloné automatiquement dans le conteneur)
docker-compose up -d

# Vérifier le status
curl http://localhost:3000/api/health

# Voir les logs
docker-compose logs -f
```

#### Utiliser un port personnalisé

```bash
# Méthode 1 : Avec un fichier .env
echo "PORT=8080" > .env
docker-compose up -d

# Méthode 2 : Variable d'environnement
PORT=8080 docker-compose up -d

# Vérifier sur le nouveau port
curl http://localhost:8080/api/health
```

### Notes

- Le conteneur clone automatiquement la dernière version du repository depuis GitHub
- L'application se met à jour automatiquement au redémarrage du conteneur
## Documentation

- **[API Reference (Markdown)](API_REFERENCE.md)**
- **Swagger UI**: `http://localhost:3000/api-docs`
- **OpenAPI Spec**: `http://localhost:3000/api-docs.json`

## Fonctionnalités Clés
- **Recherche avancée** avec wildcards (`*`, `?`).
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