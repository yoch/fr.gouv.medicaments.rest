# Changelog

Toutes les modifications notables de ce projet sont documentées dans ce fichier.

Le format est basé sur [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
et ce projet adhère au [Semantic Versioning](https://semver.org/lang/fr/).

## [Non publié]

## [1.1.0] - 2026-05-26

### Ajouté

- Format `markdown` et paramètre `detail=summary` sur `/api/medicaments/search` pour les agents LLM.
- Indication explicite lorsque les avis HAS sont absents (`LOAD_HAS_AVIS=false`).

### Modifié

- Optimisation mémoire de l’index de recherche (FrozenMiniSearch, `@yoch/minisearch`) rendue nécessaire par les fichiers XML vétérinaires volumineux.
- Réduction du pic mémoire au démarrage : chargement vétérinaire différé (15 s), chargement allégé et indexation en une seule passe.
- Pertinence des recherches multi-termes (tokenisation alignée sur MiniSearch, moindre influence des chiffres) et fallback BDPM → ANMV pour les requêtes vétérinaires.
- Fuzzy désactivé uniquement pour les termes commençant par un chiffre ; préfixe conservé pour les autres.
- Lookups liés aux médicaments vétérinaires en O(1).
- Vérification des mises à jour BDPM et vétérinaires espacée à 72 h.
- Retrait des fichiers BDPM volumineux du dépôt (téléchargement à l’installation).

### Corrigé

- Troncature sur l’endpoint de détail vétérinaire.

## [1.0.0] - 2025-07-07

API REST sur la base BDPM (projet d’origine de Mathieu Vedie, puis fork et évolutions maintenues sur ce dépôt).

[Non publié]: https://github.com/yoch/fr.gouv.medicaments.rest/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/yoch/fr.gouv.medicaments.rest/releases/tag/v1.1.0
[1.0.0]: https://github.com/yoch/fr.gouv.medicaments.rest/commit/716f95f
