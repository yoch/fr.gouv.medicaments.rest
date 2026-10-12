# Audit de recherche et de rétention — 12 octobre 2026

Référence : API 1.7.0, commit `0d442ea8bef9776772b54b8196728b80d4b356eb`,
avec FrozenMiniSearch 1.12.0, sous Node.js 24.19.0. La revue inclut les chemins
`matchIds()` et `matchInfo: false` ajoutés depuis le premier audit mémoire.

## Défauts reproduits et corrigés

| Défaut | Conséquence observée | Correction |
| --- | --- | --- |
| Fusion par CIS sans tri dans plusieurs modes de source | `aspirine` plaçait le résultat flou « GALIUM APARINE » avant les spécialités ASPIRINE. D'autres inversions existaient pour `doliprane` et `amoxicilline`. | Qualité de correspondance, puis libellé, avant la pagination dans les quatre modes de source. |
| Comparateur de critères non transitif | Deux boosts égaux pouvaient empêcher la priorité du résultat le plus pertinent. | Ordre lexicographique qualité, boost, puis position initiale. |
| Poids des champs fournis au mauvais niveau d'options | Le boost de dénomination était ignoré dans les recherches classées par score. | Configuration dans `searchOptions.boost`, sans modifier les options partagées. |
| Lecture et rapprochement de dosage | Faux grammes dans « 10 gélules » ; `100 000 UI` lu comme `0 UI` ; `POUR CENT` et `unités` ignorés ; confusion entre `0,1 µg` et `1 µg` ; volume de `250 mg/5 ml` jeté ; une seule quantité commune suffisait. | Quantités lues telles qu'écrites et converties (mg, ml, UI, %, concentration `/ml`), tolérance relative de 2 %, boost proportionnel aux quantités retrouvées, départage par le moins de quantités en trop. |
| Paramètres répétés et recherche sans limite de longueur | `q=x&q=y` ou `source=human&source=mixed` provoquaient des HTTP 500 ; un très long terme flou allouait une matrice quadratique. | Réponse JSON HTTP 400 pour les valeurs non scalaires ; `q` limité à 512 caractères avant l'appel au moteur, limite inscrite dans OpenAPI. |

Après correction, `aspirine` commence par les spécialités ASPIRINE et conserve
11 résultats dans le corpus testé. Les critères structurés restent des boosts,
jamais des filtres.

## Choix du rapprochement de dosage

Trois règles ont été mesurées avec `node scripts/audit/audit-dosage-matching.js` :
28 cas réalistes dont la pertinence est fixée à la main, et 4 226 cas du corpus où
`q` est le premier mot de la dénomination et `dosage` le dosage recopié. La
R-précision est la part de pertinents parmi les R premiers résultats ; le plafond
est de 96 % sur le corpus, un critère ne franchissant jamais un niveau de qualité.

| Règle | Corpus : R-précision / 1er pertinent | Dosage recopié | Dosage simplifié | Écriture équivalente |
| --- | ---: | ---: | ---: | ---: |
| `main` (une quantité de masse commune suffit) | 82 % / 83 % | 40 % | 67 % | 37 % |
| Normalisation des concentrations | 84 % / 85 % | 49 % | 55 % | 43 % |
| Comptage des quantités écrites (retenu) | 94 % / 96 % | 73 % | 81 % | 58 % |

Diviser par le volume se trompait dès que la dose compte plus que la concentration :
pour `méthotrexate 25 mg/ml`, les seringues 10 mg/0,4 ml et 15 mg/0,6 ml passaient en
tête. Cette normalisation ne retrouvait pas non plus la suspension `250 mg/5 ml`
pour `amoxicilline 250 mg`. Le comptage règle ces cas et les associations comme
`500 mg/62,5 mg`. Garder `/ml` sans volume comme unité porte le premier résultat
pertinent de 86 % à 94 % sur ces concentrations ; lire `/1 ml` de la même façon
faisait perdre `ORAMORPH 20 mg/1 ml` pour `20 mg` sans gain global, et n'a pas été
retenu. Le séparateur de milliers n'est lu que devant une unité internationale :
devant `mg`, il collait le chiffre d'un nom au dosage (`MAG 2 100 mg`).

La PR FrozenMiniSearch associée corrige aussi les clés littérales `__proto__`
(termes, champs indexés et champs stockés) qui pouvaient disparaître ou changer
le prototype d'un objet résultat. Les corrections de cette API fonctionnent avec
la version 1.12.0 déjà publiée ; sa dépendance n'est pas remplacée par une branche Git.

## Vérifications

- Suite complète avec corpus BDPM/ANMV : **325 tests, 32 suites réussies** avec
  FrozenMiniSearch 1.12.0 publié ; la version précédente de cette branche (306 tests)
  passait aussi avec le bundle local corrigé.
- `node scripts/audit/audit-search-correctness.js` : **80 combinaisons** sur le corpus
  réel (10 requêtes, quatre sources, avec/sans critères), ordre monotone de qualité,
  total exact et parité des deux premières pages avec la recherche complète.
- Régressions ciblées : classement avant pagination, priorité du boost de champ,
  transitivité du tri, unités/concentrations et réponses HTTP aux requêtes invalides.
- La bibliothèque corrigée a également passé son audit de parité de 20 250 assertions,
  ses tests source/navigateur et ses tests sur les bundles publiables.

Le CDN SheetJS a renvoyé HTTP 403 pendant `npm ci`. Pour ces essais, les autres
dépendances exactes du lockfile ont été installées avec un manifeste temporaire
omettant seulement l'outil de développement `xlsx`, inutilisé par le runtime et les
tests. Les manifestes et le lockfile du dépôt restent inchangés ; les audits XLSX
ne font pas partie de cette validation.

## Mémoire après les fusions

L'audit local de rétention utilise le corpus complet, FrozenMiniSearch 1.12.0,
1 800 requêtes mixtes, une concurrence de huit clients et six rechargements.
Le GC forcé sert au diagnostic des objets vivants.

| Point de mesure | Heap après GC (MiB) | RSS (MiB) | Descripteurs |
| --- | ---: | ---: | ---: |
| Données chargées | 82,00 | 234,03 | 21 |
| Premier lot de trafic | 83,48 | 237,07 | 29 |
| Sixième lot de trafic | 83,67 | 242,33 | 29 |
| Repos | 83,58 | 242,33 | 21 |
| Après six rechargements et retour des handlers | 81,68 | 259,40 | 21 |

Les **72 anciens index suivis sont libérés**. Le pool reste à 26 354 chaînes et
les huit connexions du trafic sont fermées au repos. Aucune accumulation
supplémentaire n'est observée ici ; le RSS élevé persiste malgré la libération des
objets. Reproduction, sans downloader ni accès à la production :

```sh
AUDIT_BATCHES=6 AUDIT_REQUESTS=300 AUDIT_RELOADS=6 AUDIT_IDLE_MS=1000 \
  AUDIT_OUT=tmp/memory-audit/retention.json \
  node --expose-gc --max-semi-space-size=8 scripts/memory/audit-retention.js
RUN_SLOW_TESTS=1 npm run test:serial
node scripts/audit/audit-search-correctness.js
node scripts/audit/audit-dosage-matching.js
```

## Limites du résultat

Le dosage repose sur les quantités présentes dans la dénomination. Le moteur ne
relie pas chaque quantité à une substance et ne calcule aucune équivalence de
concentration : `50 mg/ml` ne trouve pas `250 mg/5 ml`. Une association classée en
correspondance par préfixe (« AMOXICILLINE/ACIDE CLAVULANIQUE ») ne peut pas passer
devant les correspondances exactes, même avec son dosage complet.
`forme` et `voie` restent des rapprochements de libellés.
Ces limites sont distinctes des erreurs d'unité et de tri corrigées ici.

Les essais bornés et la revue ne prouvent pas l'absence absolue de défauts ou de
rétention sur toute charge. Le suivi du même PID en production, avec heapUsed,
external, RSS et événements de rechargement, reste la vérification de durée.
