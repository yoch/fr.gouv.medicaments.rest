# Changelog

Toutes les modifications notables de ce projet sont documentées dans ce fichier.

Le format est basé sur [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
et ce projet adhère au [Semantic Versioning](https://semver.org/lang/fr/).

## [Non publié]

### Modifié

- Profil allégé agents : `LOAD_MITM=false` (comme `LOAD_HAS_AVIS`), champs retirés des schémas (`presentations`, `compositions` partiels, vet `medicaments`).

### Ajouté

- Factory `defineCorpusRecord` (champs dérivés de `corpusSchemas`), doc `docs/CORPUS_CLASSES.md`, script `compare-corpus-memory.js`, utils `corpusPaging` / `miniSearchIndexConfig`.

### Modifié

- Corpus BDPM et vétérinaire : stockage en **classes ES6** à forme fixe (`src/models/bdpm`, `src/models/vet`) avec `corpusStore` (helpers sur tableaux d’instances) à la place des tuples `rowStore`.
- Champs dérivés `url_bdpm` et `lien_rcp` : **getters** sur le prototype (non stockés en RAM) ; sérialisation API via `toJSON()`.
- Scripts `analyze-bdpm-corpus-size.js`, `analyze-vet-cache-size.js` et benchmark `compare-corpus-memory.js` adaptés aux instances.

### Supprimé

- `rowStore.js` et tests `rowStore.test.js` (remplacés par `corpusRecords.test.js`).

### Benchmark mémoire (classes vs tuples v1.2.0)

Comparer sur la même machine avec `node --expose-gc` :

```bash
git checkout v1.2.0 && node --expose-gc scripts/compare-corpus-memory.js --vet --label=tuple
git checkout main && node --expose-gc scripts/compare-corpus-memory.js --vet --label=classes
```

**Décision** : les index FrozenMiniSearch dominent toujours l’empreinte (~45 Mo) ; le corpus (chaînes partagées) est une fraction du RSS. Les classes améliorent la lisibilité et l’accès typé ; le gain RSS par rapport aux tuples n’est **pas garanti** — valider avec le script ci-dessus avant déploiement. Régression acceptable si ≤ 3 Mo RSS documentée.

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

[Non publié]: https://github.com/yoch/fr.gouv.medicaments.rest/compare/v1.2.1...HEAD
[1.2.1]: https://github.com/yoch/fr.gouv.medicaments.rest/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/yoch/fr.gouv.medicaments.rest/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/yoch/fr.gouv.medicaments.rest/releases/tag/v1.1.0
[1.0.0]: https://github.com/yoch/fr.gouv.medicaments.rest/commit/716f95f
