# Architecture — fr.gouv.medicaments.rest

API REST monolithique Express servant les données BDPM (médicaments humains) et
ANMV (médicaments vétérinaires). Monolithe simple : routes → services → utils.

## Pipeline de chargement

```
source (CSV / XML)  →  downloader (sync périodique)  →  loader (parse + index)
   →  corpus (corpusStore)  +  index FrozenMiniSearch  →  état domaine (state.js)
```

- **Down**load : `dataDownloader.js` (BDPM, fichiers texte tabulés) et
  `vetDataDownloader.js` (ANMV, archive 7z). Partagent `download/syncHelpers.js`
  (hash, probe distant, download atomique, metadata JSON).
- **Load** : `dataLoader.js` (BDPM) et `vetDataLoader.js` (ANMV).
  - BDPM : streaming `fromAsyncIterable` — parse + index en une passe, pas
    d’accumulation `records[]`. Le corpus est alimenté via `corpusStore.push`.
  - Vet : streaming XML par bloc `<medicinal-product>` puis `buildFrozenIndexFromRows`.
- **État** : `services/bdpm/state.js` et `services/vet/state.js` centralisent
  corpus, index, metadata et index secondaires (CIS / num). Les exports non
  runtime (`exportApi.js`) sont isolés.
- **Specs d’index** : `search/indexSpecs.js` — source unique des champs, boost,
  `primaryField` et `idField` pour BDPM et vet (consommé par loaders + export).

## Recherche — 3 couches de ranking

1. **FrozenMiniSearch (BM25-like)** — `@yoch/frozenminisearch`. Score plein-texte
   sur les champs indexés. `tokenize`/`processTerm` via `searchRanking.js`
   (NFD, sans accents, lowercase). Options : `combineWith: AND`, `prefix` sauf
   termes numériques, `fuzzy: 0.2` sauf termes commençant par un chiffre.
2. **Post-ranking `match_quality`** — `corpusSearch.js` + `searchRanking.js`.
   Classe les hits (exact > prefix > fuzzy) et `match_via` (champ primaire >
   secondaire). Constantes `MATCH_QUALITY_RANK` / `MATCH_VIA_RANK` dans
   `searchRanking.js`.
3. **Orchestrateur hybride** — `searchOrchestrator.js`. Fusionne les hits BDPM
   (clé `cis`) et vet (clé `num`) via `mergeSearchHits`, ordonne par score
   puis qualité, déduplique par clé primaire.

## Configuration

`src/config.js` — source unique : parse toutes les variables d’environnement
(documentées dans `.env.example`) et expose un objet figé. Aucun autre module
ne lit `process.env` directement. `runtimeConfig.js` expose l’endpoint `/config`
en mappant `config` vers la forme publique (clés snake_case conservées).

## Routes

```
src/routes/
  medicaments/
    index.js            # montage router (agrégation)
    listHandlers.js     # /specialites, /presentations, /compositions
    listHandlersMisc.js # /groupes-generiques, /conditions, /substances
    disponibiliteHandlers.js # /disponibilite, /disponibilite/alerts
    detailHandlers.js   # /specialites/:cis
    avisHandlers.js     # /avis-smr, /avis-asmr, /interet-therapeutique-majeur (410 si HAS désactivée)
    searchHandler.js    # /search
    disabled.js         # réserve d'endpoints désactivés (voir ci-dessous)
  veterinaires.js
```

Helpers partagés : `utils/routeHelpers.js` (`createListHandler`).

## Endpoints et sources désactivés (réserve stratégique)

Conservés pour réactivation future, **non branchés au runtime**. Ne pas
supprimer sans discussion explicite.

| Élément | Localisation | Condition de réactivation |
|---------|--------------|---------------------------|
| `GET /api/medicaments/infos-importantes` | `src/routes/medicaments/disabled.js` | `dataLoader` doit supporter le type `infos` (parser `CIS_InfoImportantes.txt` + index + corpus record) |
| `CIS_InfoImportantes.txt` | `BDPM_DISABLED_FILES` dans `dataDownloader.js` | Idem — décommenter dans `BDPM_FILES` une fois le loader prêt |
| `HAS_LiensPageCT_bdpm.txt` | `BDPM_DISABLED_FILES` dans `dataDownloader.js` | Réactiver si exposition des liens CT HAS |

## Profilage mémoire

Scripts dans `scripts/memory/` (hors runtime prod) : pic RSS/heap, empreinte
des index frozen, heap snapshots. Voir `docs/MEMORY_INDEXING_HANDOFF.md` pour
les mesures de référence et `scripts/README.md` pour l’usage.
