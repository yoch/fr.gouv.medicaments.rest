# Pagination de recherche avec FrozenMiniSearch 1.10

## Intégration

`@yoch/frozenminisearch` passe de 1.9.0 à 1.10.0. Les recherches de liste
utilisent désormais son option `limit` lorsque la dernière requête sur le même
index a déjà établi les qualités des correspondances et le total exact.

Le classement HTTP est **qualité (`exact`, `prefix`, `fuzzy`), puis score BM25**.
Un simple `index.search(q, { limit })` peut écarter une correspondance exacte
avant que l'API ne la classe : le meilleur score peut venir d'un autre champ,
par exemple le titulaire. Il faut aussi préserver `pagination.total`.

Pour chaque index immuable, un `WeakMap` conserve uniquement la dernière requête,
son total, les trois effectifs et un `Uint8Array` des qualités par identifiant de
ligne. La première requête effectue une recherche et un classement complets,
en un seul passage de calcul des scores. Elle ne crée une entrée que si une page
suivante existe : une recherche dont tous les résultats tiennent dans la page
demandée ne remplace pas l'entrée d'une autre requête en cours de pagination.
Les requêtes suivantes qui portent sur
la même chaîne et demandent une page contenue dans un niveau de qualité utilisent :

- `filter` pour retenir ce niveau de qualité ;
- `limit` pour conserver le préfixe des scores nécessaire à la page ;
- le total exact déjà calculé, puis la tranche correspondant à la page.

Par exemple, la page 2 avec 20 résultats demande les 40 meilleurs scores de son
niveau si celui-ci commence au premier résultat. Si le niveau commence après
des résultats exacts, cette limite est calculée relativement au début du niveau.
Une page à cheval sur plusieurs niveaux conserve le classement complet.
Une page au-delà du total connu retourne immédiatement une liste vide.

Le moteur calcule encore les scores des candidats : `limit` borne la sélection,
le tri et les résultats produits ; ce mécanisme n'est pas un arrêt anticipé du
parcours de l'index. La normalisation et les expressions régulières utilisées
pour déterminer la qualité sont aussi préparées une fois par requête.

## Périmètre et mémoire

Les routes de liste BDPM indexées et les listes ANMV de médicaments et de
compositions utilisent ce mécanisme dans leurs loaders communs. Les présentations
ANMV utilisent leur filtre linéaire existant.

La recherche globale/hybride conserve les ensembles complets : elle fusionne et
déduplique plusieurs index, trie par qualité et libellé, et applique des critères
supplémentaires. Les recherches d'alertes de disponibilité filtrent aussi après
la recherche. Tronquer leurs candidats au score BM25 changerait leurs résultats
ou leurs totaux.

Le cache garde une seule requête par index et par processus, sans score, réponse
JSON ou résultats complets. Son tableau occupe un octet par ligne du corpus,
plus la chaîne et les petits objets de comptage. Par exemple : 15 883 octets
pour les spécialités du jeu mesuré, 20 911 pour les présentations et 32 439 pour
les compositions. Ce sont les tailles des tableaux, pas une mesure du RSS.
Avec une entrée sur chacun des 12 index de recherche (BDPM et ANMV), les
tableaux totalisent 154 204 octets sur le jeu du 11 octobre 2026 ; la part du
tas JS est inférieure au bruit de mesure, pour un RSS d'environ 340 Mo.
Une requête différente remplace l'entrée ; un nouvel index après rechargement
n'a pas d'entrée. Des clients qui alternent leurs requêtes peuvent donc perdre
le bénéfice du cache. Les pages profondes demandent un préfixe plus grand.

## Mesures reproductibles

Après installation et téléchargement des données BDPM :

```sh
npm ci
npm run download-data
npm run benchmark:search-pagination
```

Le benchmark vérifie l'égalité des lignes, scores, qualités et totaux avec une
recherche complète. Il mesure uniquement la recherche et le classement paginé,
sans HTTP, matérialisation JSON ou chargement initial. La référence complète
bénéficie également de la nouvelle préparation du classificateur : les gains
ci-dessous isolent le mécanisme de pagination.

Chaque mode utilise 50 échauffements et 50 mesures, sur cinq séries dont l'ordre
tourne. La valeur retenue est la médiane des médianes des séries. Le mode sans
cache alterne la casse de requêtes équivalentes sur l'index réel pour provoquer
des changements de clé. Une collecte mémoire est demandée après l'échauffement
si Node est lancé avec `--expose-gc`.

Résultats locaux sous Node 24.19.0, Linux x64, AMD EPYC 9V74, FrozenMiniSearch
1.10.0 ; jeu BDPM présent pendant la vérification du 11 octobre 2026. Les données
évoluent et la machine est partagée : ces résultats ne prédisent pas une latence
HTTP en production. Les [mesures détaillées](SEARCH_PAGINATION_RESULTS.json)
incluent les tailles des corpus et toutes les variantes.

| Corpus / requête | Page / limite | Total | Complet | Page avec cache | Sans cache |
| --- | --- | ---: | ---: | ---: | ---: |
| Spécialités / `comprime` | 1 / 20 | 8 148 | 12,26 ms | 1,54 ms | 12,35 ms |
| Spécialités / `comprime` | 2 / 20 | 8 148 | 12,18 ms | 1,55 ms | 12,73 ms |
| Spécialités / `comprime` | 1 / 1000 | 8 148 | 12,62 ms | 1,98 ms | 12,59 ms |
| Présentations / `plaquette` | 1 / 20 | 11 367 | 21,49 ms | 1,44 ms | 22,35 ms |
| Spécialités / `doliprane` | 1 / 20 | 31 | 0,136 ms | 0,117 ms | 0,140 ms |
| Spécialités / `dolipranr` | 1 / 20 | 18 | 0,118 ms | 0,112 ms | 0,121 ms |
| Spécialités / `amoxicilline` | 1 / 20 | 125 | 0,207 ms | 0,133 ms | 0,217 ms |
| Compositions / `paracetamol` | 1 / 20 | 224 | 0,216 ms | 0,112 ms | 0,226 ms |

Ces mesures précèdent la règle « pas d'entrée sans page suivante » : `dolipranr`
(18 résultats pour une limite de 20) n'est plus mis en cache et garde le coût
complet, de l'ordre de 0,12 ms.

Sur ces recherches larges et répétées, le temps mesuré diminue de 84 à 93 %.
Sur les petites recherches, le gain absolu reste inférieur à 0,11 ms.
Le premier appel conserve le coût de la recherche complète, avec le stockage
des qualités ; il ne bénéficie pas de la sélection bornée.

## Dépendances et validation

Express passe en 5.3.0, express-rate-limit en 8.7.1, fast-xml-parser en 5.11.2,
Knip en 6.41.0 et Supertest en 7.3.1. Les autres dépendances directes étaient
déjà à leur dernière version publiée lors de cette mise à jour. Les dépendances
transitives sont actualisées dans leurs plages autorisées avec `npm update` ;
`npm ci` valide la reproductibilité du lockfile.

Les tests couvrent l'équivalence avec le classement complet, les codes CIS/CIP,
les égalités de score, les limites de niveaux, le décalage de page, les totaux,
les changements de requête et d'index, ainsi que les routes HTTP BDPM et ANMV.
Le runtime garde son support Node 20 ; les 199 tests, intégration comprise,
passent sous Node 24. Des vérifications natives sous Node 20.0.0 et 20.20.2 portent sur le
chargement de l'application et les recherches HTTP avec données BDPM réelles
et fixtures ANMV.

Knip 6.41.0 signale les mêmes trois exports inutilisés que 6.38.0
(`selectAlertRuptureIndices`, `DISPONIBILITE_ALERTS_Q_CIS_LIMIT`,
`collectBdpmMatches`) ainsi qu'une règle `ignore` obsolète. Ce constat préexistant
ne provient pas de cette intégration.
