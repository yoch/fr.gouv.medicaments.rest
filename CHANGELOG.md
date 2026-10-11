# Changelog

Toutes les modifications notables de ce projet sont documentées dans ce fichier.

Le format est basé sur [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
et ce projet adhère au [Semantic Versioning](https://semver.org/lang/fr/).

## [Non publié]

### Modifié

- Produits ANMV analysés avec `saxes` à la place de `@nodable/flexible-xml-parser`, retiré des dépendances. Avec le nouveau lecteur, le chargement vétérinaire passe d'environ 4,5 s à 1,4–1,7 s sous Node 24. Les valeurs du XML restent en texte : une quantité `8.0` n'est plus réécrite en `8`. Voir `docs/VET_XML_PARSER_PHASES.md`.

### Corrigé

- Un produit vétérinaire au XML invalide est ignoré et signalé par un avertissement, au lieu d'interrompre tout le chargement ANMV.
- Temps d'attente vétérinaires de 0 (par exemple « lait : 0 heure ») : ils étaient ignorés car convertis en nombre, puis pris pour une valeur absente. `temps_attente` expose désormais ces 2 507 entrées ; 520 médicaments qui renvoyaient une liste vide en ont maintenant.
- Lecteur XML ANMV : évite les scans répétés du produit accumulé et les promesses par ligne. Sur les corpus mesurés sous Bun 1.4.3, le pic RSS médian au chargement passe de 466 à 338 Mio et la durée de 5,63 à 4,28 s ; les produits extraits sont identiques. Voir `docs/BUN_LOAD_MEMORY.md`.
## [1.5.3] - 2026-10-11

### Modifié

- PM2 lance Node avec `--max-semi-space-size=8` : la jeune génération V8 est plafonnée à 16 Mo au lieu d'un dimensionnement automatique (128 Mo mesurés sous Node 24). Pic RSS au chargement mesuré : environ 350 → 225 Mo, pour une durée de chargement inchangée. Prise en compte au prochain `pm2 startOrRestart ecosystem.config.js`.
- FrozenMiniSearch mis à jour en 1.11.0 (ajout de `searchPage()`, non utilisé ici ; `search()` et le format des index sont inchangés).

### Sécurité

- `xlsx` passe en 0.20.3, distribuée par le CDN SheetJS (le registre npm s'arrête à 0.18.5), et en `devDependencies` : seuls les scripts `audit:ansm-dispo` et `audit:ema-monitoring` l'utilisent. Corrige [GHSA-4r6h-8v6p-xvw6](https://github.com/advisories/GHSA-4r6h-8v6p-xvw6) et [GHSA-5pgg-2g8v-p4x9](https://github.com/advisories/GHSA-5pgg-2g8v-p4x9) ; `npm audit --omit=dev` ne signale plus de vulnérabilité.
- `npm run dev` utilise `node --watch` à la place de nodemon, retiré des dépendances avec sa chaîne `chokidar`/`braces` ([GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)). Seuls les modules chargés par le serveur sont surveillés, et non plus les écritures dans `data/`.

## [1.5.2] - 2026-10-11

### Modifié

- FrozenMiniSearch mis à jour en 1.10.0 ; les recherches de liste BDPM et ANMV réutilisent les qualités et le total de la dernière requête pour sélectionner les pages suivantes avec `limit`, en conservant le classement qualité puis score et les totaux exacts. Le cache n'est créé que si une page suivante existe.
- Normalisation et expressions régulières de classement préparées une seule fois par requête.
- Express 5.3.0, express-rate-limit 8.7.1, fast-xml-parser 5.11.2, Knip 6.41.0 et Supertest 7.3.1 ; dépendances transitives actualisées dans leurs plages semver. Le runtime reste compatible avec Node.js 20.

### Ajouté

- Tests de pagination de recherche, benchmark reproductible (`npm run benchmark:search-pagination`) et documentation `docs/SEARCH_PAGINATION.md`.

## [1.5.1] - 2026-08-10

### Ajouté

- Paramètre `q` sur `GET /api/medicaments/disponibilite/alerts` : nom commercial, DCI, CIS ou CIP13, résolu comme `/search` via les index BDPM, puis projeté sur les alertes par CIS.
- Configuration PM2 optionnelle pour Bun (`ecosystem.bun.config.js`) ; la configuration Node reste celle par défaut.

### Modifié

- Dépendances npm mises à jour (`npm update`, `npm audit fix`).

## [1.5.0] - 2026-07-17

### Ajouté

- Routes BDPM disponibilités / alertes (`/disponibilite`, `/disponibilite/alerts`) et audit des fiches HTML ANSM (`npm run audit:ansm-fiches`).

### Modifié

- Dépendances mises à jour (`npm update`, dont knip 6).
- PM2 reste sur Node (tentative Bun annulée, pas de gain en prod).

## [1.4.0] - 2026-07-06

### Ajouté

- Critères structurés optionnels `dosage`, `forme` et `voie` sur `GET /api/medicaments/search` : ils réordonnent les résultats à l'intérieur d'un même niveau de `match_quality`, sans jamais filtrer ; chaque fiche indique les critères satisfaits dans `criteria_match`.

### Modifié

- Mémoire réduite au chargement et pendant la pagination de recherche : la recherche globale n'hydrate que la page demandée, le flux XML ANMV écarte les balises inutiles pendant la lecture, et l'usage mémoire est journalisé après chargement puis à +30 s, +2 min et +5 min. Option de mise au point `POST_LOAD_GC` (ignorée en production).

### Corrigé

- `source=auto` conserve les correspondances BDPM faibles au lieu de les écarter.
- Classement `exact` des recherches par code CIS ou CIP.

## [1.3.0] - 2026-07-05

### Ajouté

- Entrée publique side-effect-free via `src/index.js` (`main` npm) pour créer l'app Express et accéder aux façades BDPM/ANMV sans démarrer le serveur.
- Tests production grade sur l'entrée publique, le bootstrap serveur, le mapping ANMV, les erreurs HTTP, la config runtime et Swagger.

### Modifié

- `src/app.js` porte désormais la composition Express ; `src/server.js` ne gère plus que le bootstrap runtime (download, load, refresh, listen).
- Planchers `package.json` relevés sur les dépendances directes validées après `npm update`.
- `csv-parse` mis à jour en `7.0.1`.

### Corrigé

- Mapping des médicaments vétérinaires ANMV : les champs `num_amm`, `date_amm`, `titulaire`, `forme_pharmaceutique`, `statut_amm`, `codes_atcvet`, `especes` et `maj_rcp` ne peuvent plus être décalés par un constructeur positionnel.
- GTIN vétérinaires normalisés à 14 chiffres pour préserver les zéros initiaux après parsing XML.

## [1.2.5] - 2026-06-28

### Corrigé

- `corpusLightProfile` réaligné sur l'intention du profil allégé (7766624) : omet `statut_admin`, `date_declaration`, `agrement_collectivite` ; conserve `honoraires`, `indications` et l'index `indications` (le parsing reste sur le schéma gouv 13 colonnes).

## [1.2.4] - 2026-06-28

### Corrigé

- Schéma `CIS_CIP_bdpm.txt` restauré (13 colonnes gouv) : régression du commit « profil allégé » qui raccourcissait le schéma CSV et décalait `cip13`, les taux de remboursement et les prix.
- Version Swagger lue depuis `package.json` (plus de décalage avec la version npm).

### Ajouté

- `corpusLightProfile` : omission RAM / index sur champs lourds sans tronquer le parsing CSV (`CORPUS_LIGHT_PROFILE=true`, indépendant de `LOAD_HAS_AVIS`).
- `GET /config` : feature flags et limites runtime pour le debug.
- `bdpmInterning` : liste centralisée des champs internés, alignée sur `scripts/benchmark/analyze-interning-candidates.js`.
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

[Non publié]: https://github.com/yoch/fr.gouv.medicaments.rest/compare/v1.5.3...HEAD
[1.5.3]: https://github.com/yoch/fr.gouv.medicaments.rest/compare/v1.5.2...v1.5.3
[1.5.2]: https://github.com/yoch/fr.gouv.medicaments.rest/compare/v1.5.1...v1.5.2
[1.5.1]: https://github.com/yoch/fr.gouv.medicaments.rest/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/yoch/fr.gouv.medicaments.rest/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/yoch/fr.gouv.medicaments.rest/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/yoch/fr.gouv.medicaments.rest/compare/v1.2.5...v1.3.0
[1.2.5]: https://github.com/yoch/fr.gouv.medicaments.rest/compare/v1.2.4...v1.2.5
[1.2.4]: https://github.com/yoch/fr.gouv.medicaments.rest/compare/v1.2.2...v1.2.4
[1.2.2]: https://github.com/yoch/fr.gouv.medicaments.rest/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/yoch/fr.gouv.medicaments.rest/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/yoch/fr.gouv.medicaments.rest/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/yoch/fr.gouv.medicaments.rest/releases/tag/v1.1.0
[1.0.0]: https://github.com/yoch/fr.gouv.medicaments.rest/commit/716f95f
