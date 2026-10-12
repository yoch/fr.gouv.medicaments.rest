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
| Normalisation de dosage incomplète | Faux grammes dans « 10 gélules » ; UI, volumes et pourcentages identiques non reconnus ; confusion entre `0,1 µg` et `1 µg` ; dénominateur des concentrations ignoré. | Unités entières et comparables, conversions de masse/volume, tolérance relative de 2 %, normalisation de `/ml` et `/l`. |
| Paramètres répétés et recherche sans limite de longueur | `q=x&q=y` ou `source=human&source=mixed` provoquaient des HTTP 500 ; un très long terme flou allouait une matrice quadratique. | Réponse JSON HTTP 400 pour les valeurs non scalaires ; `q` limité à 512 caractères avant l'appel au moteur, limite inscrite dans OpenAPI. |

Après correction, `aspirine` commence par les spécialités ASPIRINE et conserve
11 résultats dans le corpus testé. `40 mg/ml` correspond à `200 mg/5 ml`, mais
plus à `40 mg/5 ml`. Les critères structurés restent des boosts, jamais des filtres.

La PR FrozenMiniSearch associée corrige aussi les clés littérales `__proto__`
(termes, champs indexés et champs stockés) qui pouvaient disparaître ou changer
le prototype d'un objet résultat. Les corrections de cette API fonctionnent avec
la version 1.12.0 déjà publiée ; sa dépendance n'est pas remplacée par une branche Git.

## Vérifications

- Suite complète avec corpus BDPM/ANMV : **306 tests, 32 suites réussies**, avec
  FrozenMiniSearch 1.12.0 publié comme avec le bundle local corrigé.
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
```

## Limites du résultat

Le dosage repose sur les quantités présentes dans la dénomination. Le moteur ne
relie pas chaque quantité à une substance, ne normalise pas les dénominateurs en
masse/temps/poids corporel et ne calcule pas d'équivalence entre différentes
formulations. `forme` et `voie` restent des rapprochements de libellés.
Ces limites sont distinctes des erreurs d'unité et de tri corrigées ici.

Les essais bornés et la revue ne prouvent pas l'absence absolue de défauts ou de
rétention sur toute charge. Le suivi du même PID en production, avec heapUsed,
external, RSS et événements de rechargement, reste la vérification de durée.
