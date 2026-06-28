# Changelog

Toutes les modifications notables de ce projet sont documentées dans ce fichier.

Le format est basé sur [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
et ce projet adhère au [Semantic Versioning](https://semver.org/lang/fr/).

## [Non publié]

## [1.2.4] - 2026-06-28

### Corrigé

- Schéma `CIS_CIP_bdpm.txt` restauré (13 colonnes gouv) : régression du commit « profil allégé » qui raccourcissait le schéma CSV et décalait `cip13`, les taux de remboursement et les prix.
- Version Swagger lue depuis `package.json` (plus de décalage avec la version npm).

### Ajouté

- `corpusLightProfile` : omission RAM / index sur champs lourds sans tronquer le parsing CSV (`CORPUS_LIGHT_PROFILE=true`, indépendant de `LOAD_HAS_AVIS`).
- `GET /config` : feature flags et limites runtime pour le debug.
- `bdpmInterning` : liste centralisée des champs internés, alignée sur `scripts/analyze-interning-candidates.js`.
- Tests de non-régression CIP13 (`bdpmPresentationSchema`, `corpusLightProfile`, `bdpmInterning`) et scripts `analyze:interning` / `measure:bdpm-resident`.

### Modifié

- Interning présentations réaligné sur les nouveaux champs (`statut_admin`, `declaration`, `agrement_collectivite`) ; retrait de `indications`.
- Compositions et spécialités : interning étendu (`designation_element`, `reference_dosage`, `titulaire`, etc.) après mesures de cardinalité.

## [1.2.2] - 2026-06-23

### Modifié

- `@yoch/frozenminisearch` 1.6.0, `@nodable/flexible-xml-parser` 1.4.0.
- Script `analyze-vet-cache-size.js` : métriques index sans `_memoryBreakdown` (retiré en 1.6).
- Test équivalence `lien-rcp` : normalise les `++` ANMV (espaces doubles dans le XML source).

## [1.2.1] - 2026-06-07

### Modifié

- Index de recherche : `storeFields` vide par défaut — l’`id` document n’est plus dupliqué dans le store JSON (lookup inchangé via `corpus[res.id]`).

## [1.2.0] - 2026-05-29

### Ajouté

- Stockage corpus en tuples (`rowStore`, schémas centralisés) pour réduire l’empreinte mémoire BDPM et vétérinaire.
- Pagination des listes sans matérialiser tout le corpus (`listCorpusPage`, `listVetCorpusPage`).
- Script `analyze-bdpm-corpus-size.js` et tests unitaires `rowStore`.

### Modifié

- Index CIS/num sur indices de ligne plutôt que références objet.
- Chargement vétérinaire : écriture directe en tuples (sans objets intermédiaires).
- Recherche partagée via `corpusSearch` (matérialisation uniquement sur les hits).

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

[Non publié]: https://github.com/yoch/fr.gouv.medicaments.rest/compare/v1.2.4...HEAD
[1.2.4]: https://github.com/yoch/fr.gouv.medicaments.rest/compare/v1.2.2...v1.2.4
[1.2.2]: https://github.com/yoch/fr.gouv.medicaments.rest/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/yoch/fr.gouv.medicaments.rest/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/yoch/fr.gouv.medicaments.rest/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/yoch/fr.gouv.medicaments.rest/releases/tag/v1.1.0
[1.0.0]: https://github.com/yoch/fr.gouv.medicaments.rest/commit/716f95f
