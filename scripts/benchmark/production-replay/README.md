# Banc de test BDPM sur appels réels de production

Outil d'évaluation hors ligne des modes de recherche `legacy` (B0), `structured` (B1) et `concepts` (B2) sur des appels d'outil réels, rejoués sur un snapshot figé du corpus et notés à l'aveugle par un juge LLM.

Ce dossier ne modifie ni l'application ni FrozenMiniSearch. Python ≥ 3.10, bibliothèque standard uniquement ; Node ≥ 20 et les dépendances déjà installées du projet pour le rejeu. Aucun modèle, corpus ni service distant n'est téléchargé par le banc.

## Ce qui est public, ce qui ne l'est pas

Ce dépôt ne contient que le **code** du banc, ses rubriques, son protocole et des tests sur **données exclusivement synthétiques** (`python -m unittest discover -s tests`). Les extractions de production, les partitions préparées, les rejeux, les jugements et les rapports restent dans un répertoire privé hors dépôt (`private/`, voir `.gitignore`) : ils proviennent d'usages réels et ne sont pas anonymisés. Aucun résultat chiffré n'est publié ici.

## Fichiers

- `bench.py` : import, partitions, packets à l'aveugle, client de jugement, validation, agrégation.
- `replay.cjs` : adaptateur local B0/B1/B2, au SHA vérifié, sur un snapshot partagé.
- `contract.json` : correspondance des arguments de tool vers l'API.
- `prompts/` : rubriques séparées moteur / formulation des appels.
- `PROTOCOL.md` : critères de validation et limites des mesures.
- `tests/` : données exclusivement synthétiques.
- `anthropic_schema_shim.py` : proxy local Chat Completions → Anthropic (adaptation de schéma uniquement ; voir ci-dessous).
- `private/` : données de production préparées, à exclure de Git et des partages publics.

Le code est ciblé sur les interfaces observées dans `yoch/fr.gouv.medicaments.rest`, `experiment/semantic-light-search@f4ef0b9d8e7ac00d61ea4054a5fccc9f0406eb5f`, avec B0 historique dans ce même checkout. La base `main` observée était `8787e979300b499db653b31d110e5a016e70e4d3`. Revalider les refs distantes avant un rejeu ou une modification : un nom de branche ne vaut pas preuve.

## 1. Installer les deux archives dans un répertoire privé

Décompresser l'archive de code et l'archive de données privées au même endroit. Elles ont toutes deux une racine `bdpm_production_bench/`.

```bash
cd /chemin/prive/bdpm_production_bench
python -m unittest discover -s tests -v
node --check replay.cjs
```

`private/prepared/` contient déjà la préparation de l'extraction fournie. NE PAS publier ce répertoire, même si les IDs techniques ont été remplacés. Des noms de médicaments, critères et réponses restent des données issues d'usages réels. Aucune garantie d'anonymisation n'est revendiquée.

Pour régénérer depuis les sources, utiliser un **nouveau** répertoire :

```bash
python bench.py prepare \
  --calls /chemin/prive/bdpm_calls.jsonl.gz \
  --index /chemin/prive/bdpm_calls_index.tsv \
  --summary /chemin/prive/summary.json \
  --out /chemin/prive/prepared_v1
```

`--force` est réservé à une régénération volontaire : il invalide les artefacts dérivés. Les arguments originaux ne sont jamais corrigés ou tronqués lors du rejeu. Les partitions sont déterministes à données/seed identiques ; les IDs d'appels sont pseudonymisés avec un sel privé.

### Contrat du tool : contrôle indispensable

Les appels ont `query`, parfois `forme`, `dosage`, `voie` ou `limit`. Les défauts **limit=10**, **source=auto**, **page=1** sont des hypothèses explicites, cohérentes avec les réponses et l'API, mais **le wrapper LangGraph de production n'a pas été inspecté**. Confirmer ces défauts avant la campagne finale. S'ils diffèrent, modifier `contract.json` et préparer un nouveau jeu ; ne pas réécrire les arguments explicites.

Le flag `--confirm-tool-contract` acte cette vérification par l'opérateur. Il n'est pas une preuve automatique.

## 2. Calibrer le juge avant d'examiner le test final

`prepare` répartit les requêtes par **groupes de fuite** (répétitions, questions identiques, conversations reliées) en `development` / `calibration` / `test_locked` (environ 60 / 20 / 20 %, graine fixe). Les effectifs réels figurent dans le `profile.json` privé de chaque préparation.

Un pilote stratifié de requêtes de calibration (`--pilot-size`, 60 par défaut) est défini dans `pilot_request_ids.json` (équilibre de cas historiquement vides et de critères explicites). Il n'est pas un échantillon représentatif non pondéré du trafic.

`history-packets` construit des packets de calibration du juge à partir des réponses historiques enregistrées. Ils servent uniquement à vérifier la rubrique et la fidélité du juge sur les preuves enregistrées. Ils ne comparent pas les moteurs actuels et ne mesurent pas la justesse d'une réponse vide.

Pour les reconstruire :

```bash
python bench.py history-packets \
  --data private/prepared \
  --out private/judge_calibration_history_v2
```

Relire indépendamment un sous-échantillon du pilote, en couvrant identité exacte, dosage, forme/voie, association, source humaine/vétérinaire, requête impossible et preuve manquante. Le jugement attendu est documentaire, PAS une décision thérapeutique. Un second LLM ne remplace pas cette vérification, mais aide à repérer les désaccords.

## 3. Rejouer B0/B1/B2 dans l'environnement de l'agent

Le code applicatif doit être installé dans un checkout **propre** au SHA exact attendu. Le corpus BDPM/ANMV doit déjà être présent. Les sorties du banc doivent être **hors de DATA_DIR** et hors du code versionné. Le rejeu ne télécharge pas de données ; les accès réseau de l'application via `fetch/http/https` sont bloqués.

```bash
node replay.cjs \
  --repo /chemin/vers/fr.gouv.medicaments.rest \
  --expected-sha f4ef0b9d8e7ac00d61ea4054a5fccc9f0406eb5f \
  --data-dir /chemin/vers/data \
  --prepared "$PWD/private/prepared" \
  --out "$PWD/private/replay_calibration.jsonl" \
  --split calibration \
  --pilot-ids "$PWD/private/prepared/pilot_request_ids.json" \
  --rounds 4 \
  --confirm-tool-contract
```

Les moteurs reçoivent les mêmes arguments, y compris les critères explicites et la limite historique. Le code, la version résolue de la bibliothèque, les sources et les fichiers du corpus sont inventoriés. Le SHA et les sources sont revérifiés à la fin. Le runtime refuse une modification des fichiers suivis pendant le test.

La mesure de latence concerne l'appel applicatif direct **avec hydratation**, après préconstruction du ConceptStore et échauffement. Ce n'est pas une mesure HTTP ni une mesure d'initialisation à froid. La mémoire du processus partagé ne permet pas d'attribuer une empreinte isolée à chaque moteur. Les rondes alternent l'ordre des moteurs ; les timings bruts restent disponibles.

`--skip-vet` sert uniquement au diagnostic local : ces sorties sont refusées pour la comparaison finale. Si les loaders créent un cache au premier démarrage, préparer le corpus avant le rejeu : toute variation du snapshot pendant la campagne fait échouer sa validation.

## 4. Construire le pool de candidats à l'aveugle

```bash
python bench.py packets \
  --data private/prepared \
  --runs private/replay_calibration.jsonl \
  --split calibration --pilot \
  --systems B0,B1,B2 \
  --out private/judge_calibration_current
```

Pour chaque requête, on réunit les candidats des premiers résultats de tous les moteurs, dédupliqués par identité, sur le **même snapshot**. Les mêmes fiches ne sont jugées qu'une fois, puis leurs notes servent à évaluer tous les classements. Les champs `score`, `match_quality`, `match_via`, `criteria_match` et autres affirmations du moteur sont retirés. L'ordre des candidats est mélangé. Une fraction est rejugée dans l'ordre inverse.

Le juge ne reçoit **pas** le dernier message utilisateur, les chat IDs, le nom du générateur ni les informations de session. Cela évalue le moteur à arguments fixés. L'audit de formulation des appels est distinct (section 7).

Deux moteurs produisant des preuves incompatibles pour le même document et le même snapshot déclenchent une erreur, au lieu de choisir arbitrairement l'une des versions.

## 5. Exécuter le LLM choisi, avec budget borné

Le client utilise une API **Chat Completions compatible**, avec JSON Schema lorsque supporté. Il fonctionne sans SDK. Les paramètres ne sont pas compatibles avec tous les serveurs : adapter le endpoint si nécessaire, sans changer la rubrique en cours d'évaluation. Ne pas choisir implicitement un modèle « latest » : figer l'identifiant et, si possible, sa révision.

Un essai à blanc n'envoie aucune requête :

```bash
export JUDGE_BASE_URL='http://127.0.0.1:8000/v1'
export JUDGE_MODEL='IDENTIFIANT_EXACT_DU_MODELE'

python bench.py judge \
  --packets private/judge_calibration_current \
  --base-url "$JUDGE_BASE_URL" --model "$JUDGE_MODEL" \
  --out private/judge_A.jsonl --max-requests 20
```

Ajouter `--execute` pour exécuter. Le programme conserve les sorties validées et reprend sans rejuger les packets déjà réussis. Il journalise les tokens rapportés, le modèle, les hashes de rubrique/payload et les erreurs. Les refus, JSON invalides et preuves inventées sont des **échecs de jugement**, jamais des notes nulles inventées. Un serveur ne supportant pas JSON Schema peut utiliser `--no-structured` ; la validation locale reste obligatoire.

Pour un fournisseur distant, le transfert est bloqué sans validation explicite du contenu :

```bash
export JUDGE_BASE_URL='https://ENDPOINT_AUTORISE/v1'
export JUDGE_API_KEY='CLE_DANS_L_ENVIRONNEMENT'
export JUDGE_MODEL='IDENTIFIANT_EXACT_DU_MODELE'
# Après lecture et approbation des packets à envoyer :
export APPROVED_PACKETS_SHA256="$(python -c 'import json; print(json.load(open("private/judge_calibration_current/manifest.json"))["packets_sha256"])')"

python bench.py judge \
  --packets private/judge_calibration_current \
  --base-url "$JUDGE_BASE_URL" --model "$JUDGE_MODEL" \
  --out private/judge_A.jsonl --max-requests 20 \
  --allow-remote --reviewed-packets-sha256 "$APPROVED_PACKETS_SHA256" --execute
```

**Ne pas exécuter ce second exemple avant autorisation du fournisseur et examen des données.**

**Proxy local vers un fournisseur distant.** Avec `anthropic_schema_shim.py`, `--base-url` pointe sur `127.0.0.1` : `bench.py` ne peut pas savoir que les packets partent ensuite chez un fournisseur. L'approbation est donc imposée par le proxy : il refuse de démarrer sans `APPROVED_PACKETS_SHA256`, et répond 403, sans rien transmettre, à toute requête dont l'en-tête `X-Bench-Reviewed-Packets-Sha256` (envoyé par `--reviewed-packets-sha256`) ne correspond pas.

```bash
APPROVED_PACKETS_SHA256="$APPROVED_PACKETS_SHA256" python anthropic_schema_shim.py 18492 &
python bench.py judge --packets private/judge_calibration_current \
  --base-url http://127.0.0.1:18492/v1 --model "$JUDGE_MODEL" --key-env ANTHROPIC_API_KEY \
  --reviewed-packets-sha256 "$APPROVED_PACKETS_SHA256" --out private/judge_A.jsonl --execute
```

Le juge vérifie aussi, à chaque appel, que `model` dans la réponse est exactement le modèle demandé (`served_model`) ; un écart est une erreur de jugement, jamais une note. Les regex d'email/téléphone ne sont pas une anonymisation. Les proxies d'environnement et les redirects sont désactivés pour limiter un transfert involontaire. Les appels peuvent être facturés, y compris certains retries ; `--max-requests` borne les packets, pas un montant en euros. Une tentative réseau peut être répétée au maximum trois fois pour 429/5xx.

Pour le pilote historique déjà prêt, remplacer le chemin des packets par `private/judge_calibration_history`. Ne jamais concaténer ses jugements aux jugements des moteurs actuels.

## 6. Calculer des métriques sans inventer de vérité terrain

```bash
python bench.py score \
  --packets private/judge_calibration_current \
  --judgments private/judge_A.jsonl \
  --out private/report_calibration
```

Un second juge sur le même ensemble peut être fourni avec `--secondary private/judge_B.jsonl`. Les désaccords et jugements absents sont alors non résolus, pas transformés en consensus automatique. Pour un second juge sur seulement un échantillon, limiter son usage à la calibration/inspection : ne pas utiliser ce mode pour masquer les autres cas.

Sorties : rapport JSON/Markdown, scores par cas, file de revue privée. Sont présentés les moyennes par requête et pondérées par fréquence d'appel, les écarts appariés et des intervalles bootstrap par groupe. Ces intervalles mesurent une incertitude d'échantillonnage **conditionnelle aux notes du juge** : ils ne couvrent pas ses biais systématiques.

- `top1_grade3` : première fiche satisfaisant strictement les attributs documentés.
- `hit5_grade2plus`, `mrr10_grade2plus` : présence/rang d'une fiche utile.
- `ndcg_requested_k_pooled` : nDCG sur `k=min(10,limit demandé)`, avec idéal formé du **pool jugé**, pas de tout le corpus.
- Audit des contradictions documentaires en première position, y compris lorsque le pool n'a aucun positif.
- Couverture, erreurs de replay, erreurs du juge, exclusions, réponses vides et désaccords d'ordre.

**Pas de Recall global**, pas de score de traitement médical. Une réponse vide commune aux trois moteurs n'est pas notée « mauvaise » automatiquement : son absence de solution est inconnue tant qu'une vérification indépendante du corpus ne l'a pas établie. Les scores de classement publiés sont explicitement conditionnés au sous-ensemble jugé ; lire la couverture et les exclusions avant de les interpréter.

### Test final

Après gel du code, du snapshot, du contrat et du juge, rejouer `--split test_locked --unlock-test` sans `--pilot-ids`, puis construire les packets avec les mêmes flags. Ne pas régler règles, alias ou seuils en regardant ce test. Après ouverture, il devient une suite de validation consultée ; il faut de nouveaux appels futurs pour un nouveau test indépendant.

## 7. Audit séparé : qualité des arguments produits par l'agent

`prepare` conserve les derniers messages dans `context_private.jsonl`, séparé des données de recherche. Ce fichier **n'est pas inclus dans l'archive privée réduite livrée** : il se reconstruit localement à partir de l'export original.

```bash
python bench.py context-packets \
  --data /chemin/prive/prepared_v1 --split calibration --pilot \
  --include-user-context --out /chemin/prive/judge_context
```

Ce transfert n'est jamais implicite. Les packets contiennent des questions potentiellement sensibles, même après suppression de quelques motifs de contact. Après revue et autorisation, les mêmes commandes `judge` puis `score` s'appliquent, mais le résultat est un **audit d'alignement**, pas un score du moteur. Le contexte antérieur manquant et le rattachement heuristique imposent une catégorie `unknown`.

## Intégration dans le dépôt

Conserver le banc côté pharma/recherche, pas dans FrozenMiniSearch. Il dépend du contrat des outils et de la forme des données BDPM, pas du moteur générique. Réutiliser l'outillage existant et éviter une nouvelle famille d'alias npm. Le code est livrable séparément des données ; ne jamais pousser les journaux, partitions privées, questions, réponses ou jugements détaillés sur le dépôt public.
