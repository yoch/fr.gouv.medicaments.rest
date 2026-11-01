# Évaluation de Bun `--compile --aot` pour le serveur complet

Évaluation locale, branche `perf/bun-aot` (base `v1.7.2`), Bun `1.4.4-canary`,
Node 24.18, i7-3770 (4 cœurs / 8 threads), jeu de données BDPM + ANMV du
29 octobre 2026. Charge générée par `scripts/benchmark/http-load.js` (8 connexions
keep-alive, chauffe 1,5 à 3 s, mesure 4 à 10 s). Pour les comparaisons par
route, les serveurs sont épinglés sur le cœur 0 et le client sur le cœur 1 ; la
charge mixte n'est pas épinglée.

## Résumé

| Question | Réponse |
| --- | --- |
| Les locales sont-elles vraiment atteignables ? | **Non** pour FrozenMiniSearch : faux positif de l'analyse `--trim`. Oui pour le serveur, via `localeCompare(…, 'fr')`. |
| `--aot` avec le paquet npm actuel | Plus lent que le JIT sur la recherche (−45 à −55 %), plus rapide ailleurs. |
| `--aot` avec une bibliothèque FrozenMiniSearch compilée en AOT | Au niveau du JIT ou meilleur partout (jusqu'à +25 % sur la recherche floue), −6 % sur `paracetamol`. |
| `--aot --trim --trim-locales=fr` | 88 → 64 Mo, réponses identiques à Node, débit inchangé. |
| Mémoire résidente | AOT ≈ 225–245 Mo, JIT ≈ 265–275 Mo, Node ≈ 220–350 Mo selon le moment du GC. |

## 1. Pourquoi l'analyse `--trim` voit des locales

`--explain=trim` sur le build du moteur de recherche indique :

```
the compiler can't tell which API this program uses at src/FrozenMiniSearchCore.ts:246:9,
because the name is only known at run time
removed Intl.Locale … (intl): no code names it, but a name from run time could reach it
```

Ce n'est pas un usage d'`Intl` : le code de FrozenMiniSearch ne contient aucun
`Intl.`. La ligne 246 est `fieldLengthMatrix[docId * fieldCount + fieldId]`, un
accès indexé sur `Uint8Array | Uint16Array | Uint32Array`. Après neutralisation
de cet accès, l'avertissement se déplace sur `snap.fieldIds[name]`
(`binaryStructures.ts:77`), un accès par nom calculé. L'analyseur ne sait pas
prouver qu'une clé calculée ne désigne pas `Intl` ou `WebAssembly`, et
conserve donc ces API par prudence. Des reproductions minimales (union de
tableaux typés, classe générique, `any`) ne déclenchent pas l'avertissement : il
dépend du contexte global du programme.

Conclusion : à ignorer pour la bibliothèque. Dans le serveur, en revanche, `Intl`
est réellement utilisé :

- `src/services/searchOrchestrator.js` : tri `localeCompare(…, 'fr')` (3 sites) ;
- `src/utils/disponibiliteQuery.js` : `localeCompare`.

Il faut donc garder `Intl.Collator`, avec `--trim-locales=fr` (ou
`compile.trim.allow: ["intl"]`).

## 2. Le paquet npm n'a pas d'AOT

`@yoch/frozenminisearch@1.12.2` n'expose pas de condition d'export `"aot"` et ne
fournit pas d'`index.aot.ts`. Le serveur compile donc `dist/cjs/index.cjs`, du
JavaScript non typé : `--explain=missed-optimizations` y relève 878 pertes
(allocations, appels inconnus, gardes de boucle non remontées).

`bun compile --library src/index.ts --outdir <dir>` dans le dépôt minisearch
produit un paquet avec :

```json
"exports": { ".": { "aot": "./index.aot.ts", "types": "./index.d.ts", "default": "./index.js" } }
```

Le serveur se compile ensuite avec `bun build --compile --aot --conditions=aot`
avec ce paquet à la place de celui de `node_modules`. Cet écart explique à lui
seul la régression du build AOT « naïf ».

## 3. Mesures

### Charge mixte (9 routes en round-robin, 8 connexions, 10 s)

| Exécution | req/s | p50 | p95 | p99 |
| --- | ---: | ---: | ---: | ---: |
| Node 24 | 611 | 12,6 ms | 24,7 ms | 29,3 ms |
| Bun `--no-aot` (JIT) | 898 | 8,2 ms | 16,4 ms | 21,3 ms |
| Bun `--aot` + paquet npm | 769 | 9,5 ms | 18,4 ms | 22,3 ms |
| Bun `--aot` + bibliothèque AOT | **1 012** | **7,1 ms** | **14,7 ms** | **19,2 ms** |

### Par route, req/s (médiane de 2 passes, épinglé)

| Route | Node | JIT | AOT npm | AOT lib |
| --- | ---: | ---: | ---: | ---: |
| `/health` | 6 522 | 8 362 | 8 624 | 8 523 |
| recherche `paracetamol` | 607 | 751 | 394 | 708 |
| recherche `doliprane` (full) | 1 382 | 1 547 | 754 | 1 844 |
| recherche floue `dolipranr` | 1 119 | 1 194 | 581 | 1 487 |
| liste spécialités | 4 880 | 6 459 | 6 633 | 6 471 |
| détail spécialité | 5 584 | 7 973 | 8 209 | 7 934 |
| `disponibilite/alerts` | 113 | 226 | 270 | 268 |
| liste vétérinaire | 3 762 | 5 514 | 5 336 | 5 083 |
| `api-docs.json` | 2 328 | 2 823 | 3 017 | 2 900 |

Notes de lecture :

- Les routes sans recherche (listes, détails, dispo, vétérinaire, Swagger) sont
  équivalentes entre JIT et AOT, à ±5 % près selon la passe. Le bruit de la
  machine (navigateur et autres applications actives) atteint ±10 % d'une passe à
  l'autre ; les écarts inférieurs à 10 % ne sont pas significatifs.
- La régression de l'AOT npm est dans le chemin de recherche fixe, pas dans
  l'hydratation : même une requête sans résultat perd 40 %.
- Microbenchmark de `collectBdpmMatches` (ms, médiane) :

  | Requête | Node | Bun JIT | AOT npm | AOT lib |
  | --- | ---: | ---: | ---: | ---: |
  | `paracetamol` | 1,18 | 1,05 | 1,48 | **0,69** |
  | `doliprane` | 0,50 | 0,34 | 0,98 | **0,30** |
  | `dolipranr` (flou) | 0,35 | 0,40 | 0,95 | **0,29** |

  En AOT bibliothèque, le moteur est donc plus rapide que le JIT. L'écart restant
  sur `paracetamol` en HTTP (−6 %) n'est pas dans la recherche : la
  poignée complète sans Express coûte 1,07 ms en JIT et 1,16 ms en AOT, le tri
  `localeCompare` ≈ 0,12 ms dans les deux cas, hydratation et sérialisation JSON
  < 0,05 ms. Il se situe dans la pile HTTP/Express compilée.
- Le tri `localeCompare` n'est donc pas un goulot, et le remplacer par un
  `Intl.Collator` partagé ou par un tri par seaux ne change rien de mesurable.

### Mémoire (RSS après stabilisation)

| Exécution | Après chargement vet. | Plateau (+5 min) |
| --- | ---: | ---: |
| Node | 343 Mo | 222 Mo (après GC) |
| JIT | 434 Mo | 272 Mo |
| AOT npm | 339 Mo | 239 Mo |
| AOT lib | 342 Mo | 225 Mo |

Le pic au chargement est le même qu'avec Node ; le plateau est le plus bas en
AOT. Le CPU sous charge est comparable (≈ 85–100 % d'un cœur : le serveur est
mono-thread).

### `--trim`

| Build | Taille |
| --- | ---: |
| `--no-aot` | 137 Mo |
| `--aot` | 88 Mo |
| `--aot --trim --trim-locales=fr` | **64 Mo** |

Hello world : `--aot` 65 → 24,5 Mo avec `--trim`. Pour le serveur, le gain est
moindre car le runtime est réellement sollicité (HTTP, fichiers, flux, zlib,
`Intl`).

Vérifié sur le binaire `--trim` : les 9 routes API et Swagger répondent
(200), et les corps de `/search` (`paracetamol`, `acide` avec accents,
`agomelatine`) et de la liste vétérinaire sont **identiques à ceux du serveur
Node** (métadonnées exclues), ordre alphabétique français compris. Débit sans
écart avec le build non réduit.

## 4. Autres constats

- `--explain=missed-optimizations` du serveur : 15 738 lignes, principalement dans
  les dépendances (`axios` 1 193, FrozenMiniSearch npm 878, `swagger-jsdoc/yaml`
  300, `csv-parse`, `saxes`). Côté application, les plus touchées sont
  `vet/loadPipeline.js` (79), `searchOrchestrator.js` (72) et `dataLoader.js`
  (62), surtout des allocations d'objets qui s'échappent : structurel (résultats
  JSON), pas corrigeable sans réécriture.
- `--aot-log-type-mismatches` : aucun type incompatible rapporté à la
  compilation du serveur.
- Les avertissements `TS100058` de `xmlchars` (`new RegExp` dynamiques, exécutées
  par l'interpréteur) n'empêchent pas le build ; ces expressions ne sont
  utilisées que par le parseur XML vétérinaire.
- Le binaire ne sert pas `/` : `public/index.html` n'est pas embarqué
  (404/ENOENT). Les routes API et `/api-docs` fonctionnent. À régler avant tout
  déploiement (`import … with { type: 'file' }` ou assets embarqués).
- Les répertoires de données ne sont pas embarqués : `DATA_DIR` et
  `VET_DATA_DIR` doivent être fournis (support ajouté dans `7edaae2`).
- `--disallow-code-generation-from-strings` n'a pas été évalué en production : il
  n'est pas nécessaire pour le gain et pourrait casser une dépendance utilisant
  `new Function` (non vérifié).

## 5. Recommandations

1. **Ne pas livrer `--aot` avec le paquet npm actuel** : il est plus lent que le
   JIT sur la recherche, qui est le cœur de l'API.
2. Publier `@yoch/frozenminisearch` avec la condition `"aot"` (sortie de
   `bun compile --library`), puis compiler le serveur avec
   `--conditions=aot --trim --trim-locales=fr`.
3. Gain mesuré face au JIT : +13 % de débit en charge mixte, binaire 137 → 64 Mo,
   RSS de plateau −17 % ; face à Node : +66 % de débit.
4. Avant déploiement : embarquer `public/`, valider la suite `npm run test:integration`
   contre le binaire, et rejouer les mesures sur la machine cible (l'écart
   inter-passes de cette machine, partagée, est de ±10 %).

## Reproduire

```bash
# Moteur de recherche AOT (dépôt minisearch)
bun compile --library src/index.ts --outdir /tmp/fms-aot-lib

# Serveur (paquet temporairement remplacé par le lien vers fms-aot-lib)
bun build --compile --aot --conditions=aot --trim --trim-locales=fr \
  src/server.js --outfile /tmp/server-aot-lib-trim

# Charge
DATA_DIR=$PWD/data VET_DATA_DIR=$PWD/data/veterinaires PORT=3215 \
  ENABLE_RATE_LIMIT=false /tmp/server-aot-lib-trim &
npm run benchmark:http -- --base-url=http://127.0.0.1:3215 \
  --paths='/health,/api/medicaments/search?q=paracetamol&limit=10&detail=summary' \
  --duration=10
```
