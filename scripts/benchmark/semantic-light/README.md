# Benchmark v2 : Recherche sémantique "ultra-light" sur `fr.gouv.medicaments.rest` (`FrozenMiniSearch`)

Expérimentation en **mode recherche** évaluant des pistes crédibles, légères et sans "bulldozer" pour enrichir la recherche sur le corpus figé BDPM + RCP (`@yoch/frozenminisearch`).

## 1. Réserves méthodologiques adressées dans cette v2

1. **Incomplétude de `CIS_GENER_bdpm.txt`** : sur **15 845** spécialités BDPM (**13 599** commercialisées, **2 246** non commercialisées), `CIS_GENER` ne couvre que **8 127 spécialités (51,3 %)**. Des marques majeures en sont absentes ou très partielles (`DOLIPRANE`, `EFFERALGAN`, `KARDEGIC`, `DAFALGAN`, `ELIQUIS`, `IMODIUM`…).
2. **Lien automatique Marque ↔ Molécule (`CIS_bdpm × CIS_COMPO`)** : en unifiant les codes substance BDPM (et en privilégiant la fraction thérapeutique `FT` puis `SA`), l'extraction automatique construit **3 074 liens marque → substance(s) canonique(s)** et **3 296 signatures moléculaires** sans aucun dictionnaire manuel (y compris bi-substances comme `AUGMENTIN → acide clavulanique + amoxicilline`).
3. **Couverture et hygiène des RCP (`rcp_md/*.md`)** : **10 260** spécialités ont une section `4.1` (indications), **10 264** une section `4.8` (effets indésirables), **9 577** une classe pharmacothérapeutique et **11 717** un code ATC (MITM + RCP). Mélanger `4.1` et `4.8`/`4.3` dans un même champ crée de graves faux positifs (ex. médicaments *provoquant* des céphalées qui remontent pour *soigner* un mal de tête).
4. **Suite d'évaluation rigoureuse et anti-fuite (`226` requêtes)** :
   - `F1_exact_typo_atc` (31) : exact, fautes de frappe, dosage, forme, CIS, ATC.
   - `F2_subst_cis_gener` (40) : substitutions dans `CIS_GENER` avec piège *princeps en #1*.
   - `F3_equiv_marque_mol` (30) : équivalents et questions molécule hors `CIS_GENER` (piège : même marque en #1 ou opioïde en substitution d'un antalgique simple).
   - `F4_clinique_pro` (30) : terminologie médicale / RCP / ATC.
   - `F5a_patient_lex` (20) : requêtes patient bruitées correspondant au petit lexique figé v1 (18 mots).
   - `F5b_patient_oov` (30) : requêtes patient courantes **strictement hors lexique v1** (maux de tête, mal aux dents, aphtes, verrue, bouton de fièvre, diarrhée, constipation, toux grasse/sèche, hémorroïdes, gale, etc.).
   - `F6_pieges_polarite` (18) : antonymes (`tension` vs `TENSIONORME`, `fer` vs chélateurs, `sommeil` vs éveil), effet indésirable `4.8` vs indication `4.1`, contre-indication `4.3/4.6`, négations explicites (`sans paracetamol`, `sans aspirine`, `sans ibuprofene`, `sans codeine`), bigrammes négatifs (`SANS SUCRE` sur requête diabète).
   - `F7_contraintes_statut` (12) : pédiatrie / posologie adulte, sans ordonnance (OTC), voie cutanée vs injectable, collyre, grossesse compatible.
   - `F8_bruit_valide` (5) : formulations conversationnelles longues mais valides.
   - `F8_hors_perimetre` (10) : requêtes hors périmètre (vétérinaire, SAMU 15, mutuelle optique, brosse à dents, cosmétique Sephora, croquettes) mesurant le taux d'hallucination (`OOS_Hall`).

## 2. Reproduction locale

Depuis la racine du dépôt (dans une worktree contenant `data/` et `rcp_md/` ou reliée via `git-common-dir`) :

```bash
node scripts/benchmark/semantic-light/run_rigorous_bench.js
```

## 3. Résultats observés

### Empreinte mémoire & temps de build (15 845 documents)

| Artefact | Temps build | Termes / Vocab | Taille disque (`.msbin` / `.gz`) | RAM runtime |
| :--- | ---: | ---: | ---: | ---: |
| `Idx RichRaw (pos)` | 523 ms | 36 582 | 1.58 MB / 1.56 MB | ~index MiniSearch |
| `Idx AutoBDPM (2A+2B)` | 583 ms | 36 722 | 1.68 MB / 1.65 MB | ~index MiniSearch |
| `Idx AutoBDPM+Morph (2C)` | 1 003 ms | 50 662 | 2.41 MB / 2.37 MB | +38 % vocab |
| `Idx RcpSafety (4.8/4.3)` | 2 043 ms | 25 789 | 3.31 MB / 3.29 MB | chargé à la demande / dédié |
| `LSA-128 Int8` (SVD pure JS) | 11.6 s | 10 609 | `docVecs.gz` = 0.96 MB | **3.31 MB** |
| `LSA-256 Int8` (SVD pure JS) | 41.9 s | 10 609 | `docVecs.gz` = 1.78 MB | **6.54 MB** |

### Performance globale (216 requêtes valides + 10 hors-périmètre)

| Modèle | P@1 | Hit@5 | Prec@5 | R@10 | MRR@10 | Trap@5 | Comm@3 | OOS_Hall | Empty | p50 ms | p95 ms |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `M0_PROD_Hybrid` (prod réel) | 13.0 % | 13.0 % | 7.8 % | 13.4 % | 0.130 | 4.2 % | 12.8 % | 0.0 % | 85.6 % | 0.4 | 1.6 |
| `M1_Rich_BM25_OR` (brut) | 35.2 % | 47.7 % | 32.6 % | 53.2 % | 0.405 | **64.4 %** | 81.0 % | 100.0 % | 0.0 % | 17.4 | 82.5 |
| `M1b_Rich_Clean` (hygiène seule) | 45.8 % | 61.1 % | 45.4 % | 67.6 % | 0.520 | 31.9 % | 99.7 % | 100.0 % | 0.0 % | 1.4 | 18.5 |
| `M2_AutoBDPM_2A2B` (0 lexique) | 72.2 % | 81.9 % | 64.7 % | 86.1 % | 0.764 | **1.9 %** | 99.4 % | 100.0 % | 0.0 % | 1.3 | 28.3 |
| `M2b_AutoBDPM_Morph` (2C) | 71.8 % | 81.5 % | 64.7 % | 88.0 % | 0.762 | 2.3 % | 99.7 % | 100.0 % | 0.0 % | 1.9 | 30.2 |
| `M2c_Auto_LexV1` (+18 mots v1) | 74.5 % | 82.4 % | 65.8 % | 86.1 % | 0.779 | 2.3 % | 99.2 % | 100.0 % | 0.0 % | 1.7 | 27.2 |
| `M3_LSA128_Pure` | 38.0 % | 53.2 % | 39.1 % | 57.9 % | 0.438 | 42.6 % | 71.3 % | 80.0 % | 15.3 % | 4.0 | 4.8 |
| `M3_LSA256_Pure` | 37.5 % | 51.9 % | 38.7 % | 57.9 % | 0.435 | 40.7 % | 69.6 % | 80.0 % | 15.3 % | 8.5 | 9.2 |
| `M3_Hyb_LSA128` (0 lexique) | **75.0 %** | 85.6 % | 69.1 % | **90.3 %** | 0.795 | 2.3 % | **100.0 %** | 100.0 % | 0.0 % | 5.3 | 22.7 |
| `M3_Hyb_LSA256` (0 lexique) | 74.1 % | **88.0 %** | **69.4 %** | 89.8 % | **0.801** | 2.3 % | **100.0 %** | 100.0 % | 0.0 % | 10.3 | 29.1 |
| `M3_Hyb_LSA256_Gate` (+seuil) | 74.1 % | **88.0 %** | **69.4 %** | 89.8 % | **0.801** | 2.3 % | **100.0 %** | 70.0 % | 0.0 % | 9.9 | 26.9 |

### Détail `MRR@10` par catégorie

| Catégorie (`N`) | `M0_PROD` | `M1_OR` | `M1b_Clean` | `M2_Auto` | `M2b_Morph` | `M2c_LexV1` | `LSA256_Pure` | `Hyb_LSA128` | `Hyb_LSA256` |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `F1_exact_typo_atc` (31) | 0.584 | 0.973 | 0.978 | **1.000** | **1.000** | **1.000** | 0.484 | 0.984 | 0.957 |
| `F2_subst_cis_gener` (40) | 0.000 | 0.040 | 0.065 | **0.903** | **0.903** | **0.903** | 0.061 | 0.789 | 0.867 |
| `F3_equiv_marque_mol` (30) | 0.000 | 0.116 | 0.174 | 0.900 | 0.873 | 0.900 | 0.329 | **0.967** | 0.958 |
| `F4_clinique_pro` (30) | 0.333 | 0.820 | 0.866 | 0.843 | 0.859 | 0.843 | 0.864 | 0.909 | **0.934** |
| `F5a_patient_lex` (20) | 0.000 | 0.239 | 0.528 | 0.527 | 0.578 | **0.721** | 0.600 | 0.620 | 0.682 |
| `F5b_patient_oov` (30) | 0.000 | 0.400 | 0.513 | 0.519 | 0.529 | 0.519 | 0.409 | **0.600** | 0.573 |
| `F6_pieges_polarite` (18) | 0.000 | 0.277 | 0.687 | 0.648 | 0.600 | 0.648 | 0.657 | **0.766** | 0.701 |
| `F7_contraintes_statut` (12) | 0.000 | 0.396 | **0.554** | 0.472 | 0.467 | 0.472 | 0.204 | 0.521 | 0.500 |
| `F8_bruit_valide` (5) | 0.000 | 0.233 | **0.629** | 0.429 | 0.333 | 0.295 | 0.450 | 0.600 | 0.500 |

## 4. Conclusions scientifiques et limites honnêtes

1. **L'essentiel du gain immédiat provient de l'hygiène + des liens BDPM automatiques (`M2_AutoBDPM_2A2B`)** : passer de `0.130` (`M0_PROD`) à **`0.764 MRR@10`** avec **1,9 % de pièges** coûte **1,68 Mo** d'index `.msbin` et **1,3 ms** en médiane, sans aucun dictionnaire de symptômes ni ML lourd.
2. **La LSA Int8 (Approche 3) est inutilisable seule, mais utile en hybride RRF (+3.3 à +6.5 Mo RAM)** :
   - Sur la terminologie clinique (`F4`), `M3_Hyb_LSA256` atteint **100 % Hits@5 (`0.934 MRR`)**.
   - Sur `F5a_patient_lex` (sans lexique), `LSA256` comble automatiquement une large part du fossé (`0.527 → 0.682 MRR`), prouvant une réelle découverte de co-occurrences cliniques (*diabète ↔ glycémie*, *cholestérol ↔ statine*).
3. **Les deux approches restent loin d'une vraie compréhension sémantique (29 échecs analysés sur `M3_Hyb_LSA256`)** :
   - **Mur terminologique patient ↔ ANSM (`F5b` bloqué à `0.57–0.60 MRR` / `66.7 % Hits@5`)** : la SVD n'apprend que les co-occurrences *présentes* dans les RCP. Des expressions absentes du jargon ANSM (*"bouton de fièvre"* ≠ *herpès labial*, *"vers dans le ventre"* ≠ *oxyurose*, *"bleu / bosse"* ≠ *hématome / contusion*) restent inaccessibles sans supervision sémantique externe.
   - **Capture par mot dominant et homonymie** : `HUMEX MAL DE GORGE` / `LYSOPAÏNE MAUX DE GORGE` capturent *"mal aux dents"*, *"mal au dos / sciatique"*, *"mal de crâne"* parce que `mal`/`maux` est dans leur dénomination ; `TENSIONORME` / `CARDIOCALM` capturent *"tension"* ; `FIBROVEIN` (sclérothérapie des varices) capture *"caillot dans les veines"*.
   - **Portée logique, causalité et négation fine (`F6`)** : *"faire baisser"* vs *"augmenter"*, *"toux grasse"* vs `HUMEX TOUX SECHE`, *"contre-indiqué pendant la grossesse"* (où *"grossesse"* apparaît aussi dans les RCP autorisés en `4.6`).
   - **Hors-périmètre (`OOS_Hall = 70 %–100 %`)** : dès que la requête hors sujet contient un mot médical ou usuel banal (*"brosse à dents"*, *"crème visage"*, *"urgence 15"*), BM25+LSA retourne des spécialités au lieu de s'abstenir.

## 5. Fichiers

- [`lib/text_utils.js`](lib/text_utils.js) — normalisation, masquage de bigrammes négatifs (`sanssucre`, `sansordonnance`), lemmatiseur léger.
- [`lib/bdpm_loader.js`](lib/bdpm_loader.js) — chargement complet BDPM + unification des codes substance + extraction auto marques↔molécules + parsing séparé des rubriques RCP (`4.1`, `4.3`, `4.6`, `4.8`, `5.1`, ATC).
- [`lib/lsa_engine.js`](lib/lsa_engine.js) — SVD randomisée de Halko en pur JS + index vectoriel `Int8Array` (0 dépendance externe).
- [`lib/query_processor.js`](lib/query_processor.js) — analyse d'intention, négations, contraintes statutaires/âge, lexique v1 figé pour test de fuite.
- [`lib/eval_suite.js`](lib/eval_suite.js) — suite de 226 requêtes (`F1..F8`).

---

## 6. Mise à jour de mission (novembre 2026) — pipeline `B0→B4`, garde-fous A1 et `FrozenVectorIndex` (`@yoch/frozenminisearch@1.13.0`)

> **Avertissement :** les sections 1–5 ci-dessus documentent l'exploration historique v2 (corpus enrichi RCP + prototype `lib/lsa_engine.js`). Le code courant de la branche `experiment/semantic-light-search` sépare strictement le runtime applicatif (`src/search/`), l'évaluation corrigée sans RCP (`scripts/benchmark/semantic-light/mission/`), et l'extension générique dans `yoch/frozenminisearch` (branche `feat/semantic-light-aux`).

### Architecture retenue

| Composant | Rôle | Emplacement |
| :--- | :--- | :--- |
| Mode historique inchangé (`B0`, `legacy`) | Par défaut sur `/api/medicaments/search` | [`src/services/searchOrchestrator.js`](../../../src/services/searchOrchestrator.js) |
| Interpréteur structuré & alias BDPM (`B1` / `B2`, opt-in `mode=structured\|concepts`) | Extraction dosage (`kg` poids patient exclu des doses autonomes), précédence stricte des paramètres explicites (`conflicts`, `criteria_match` exact vs `criteria_status` `matched/expanded/contradicted/unknown/unsupported`), taxonomie légère cacheable en B1, `ConceptStore` paresseux en B2 (non matérialisé sur B1, codes numériques et rejets de garde-fou) | [`src/search/structuredQueryParser.js`](../../../src/search/structuredQueryParser.js), [`src/search/conceptStore.js`](../../../src/search/conceptStore.js), [`src/search/experimentalSearch.js`](../../../src/search/experimentalSearch.js) |
| Garde-fou A1 intentions & négations | Détection négations/exclusions multi-entités (`pas de X`, `sans X ni Y`, critères explicites négatifs comme `voie="non orale"`), propriétés RCP cliniques (`contre-indiqu*`, `non contre-indiqu*`, `grossesse`, `enceinte`, `compatible`, `allaitement`, `effets indésirables`), poids patient (`kg`), préservation des qualificatifs littéraux BDPM (`sans sucre`, `sans conservateur`, `sans alcool`) | [`src/search/queryIntentGuard.js`](../../../src/search/queryIntentGuard.js) |
| Extension générique zéro-dépendance | Sous-chemins dédiés `@yoch/frozenminisearch/vectors` & `./vectors/train` (0 octet ajouté au bundle lexical principal) : `FrozenVectorIndex` (`FXV1` v2 Float32 / Int8 / PQ8 avec normes reconstruites vérifiées au chargement, `mappingFingerprint`, `representationVersion` + `snapshotId` obligatoires, filtre pré-k strict) | Dépôt `yoch/frozenminisearch` (`feat/semantic-light-aux`) |
| Protocoles DEV/HELDOUT gelé, B3/B4, empreinte isolée et HTTP E2E | Suites de **non-régression** `eval_suite_v3.json` (46 dev / 62 heldout) & `eval_residual_v1.json` (24 dev / 34 heldout), repli **strictement expérimental** borné (`candidate_cap=40`, `candidate_cap_scope: 'global_merged'`, `total_semantics: bounded_lower_bound`, filtre pré-k, `b2.total === 0 && safety.supported && cos >= 0.55`), comparaison `Float32 / Int8 / PQ32 / PQ16`, manifeste [`reproducibility_manifest.json`](mission/reproducibility_manifest.json) | [`mission/`](mission/) |

> **Statut du repli vectoriel (`research_only_not_promoted`) :** le repli sémantique `FXV1` n'est pas promu sur la route de production `/api/medicaments/search` (`B0` par défaut, `B1`/`B2` opt-in sans modèle). Prérequis : encodeur WordPiece statique externe (`data/search-indexes/mission-semantic/`, +15,2 Mo), deux index `FXV1` construits hors ligne (+2,6 Mo binaires) et garde-fou A1 préalable. Limites connues : gain ciblé sur quelques formulations patient `R2` (+0,031 `nDCG@10` sur `eval_residual_v1` heldout), nul sur fautes d'orthographe sévères (`R1`) et DCI étrangères (`R3`) ; `eval_suite_v3` et `eval_residual_v1` ont été itérées conjointement avec les règles et mesurent la **non-régression** (et non la généralisation sur requêtes inédites). La fenêtre bornée s'applique désormais globalement après fusion/tri BDPM+ANMV (`candidate_cap_scope: 'global_merged'`).

### Chiffres mesurés sur la version courante (`heldout` réexécuté après audit/correctifs avec seuil `minScore = 0.55` gelé sur DEV)

- **`V3 HELDOUT` (55 requêtes valides + 4 impossibles + 3 OOS, sans réétiquetage comme nouveau heldout)** :
  - `B0_legacy` : `Id@1 = 0.636`, `Var@1 = 0.618`, `MRR@10 = 0.624`, `nDCG@10 = 0.517`, `Empty = 0.345`, `OOS non-vide = 0.000`.
  - `B1_structured` : `Id@1 = 0.855`, `Var@1 = 0.836`, `MRR@10 = 0.855`, `nDCG@10 = 0.843`, `Empty = 0.109`, `OOS non-vide = 0.000`.
  - `B2_concepts` : `Id@1 = 0.982`, `Var@1 = 0.945`, `MRR@10 = 0.967`, `nDCG@10 = 0.964`, `Empty = 0.000`, `OOS non-vide = 0.000`.
  - `Hybrid_Int8_Tarball_055` (`FrozenVectorIndex@1.13.0 Int8`, seuil gelé `0.55`) : identique à `B2_concepts` sur V3 (delta marginal `0.000`).
- **`RESIDUAL HELDOUT` (30 requêtes résiduelles dures + 2 impossibles + 2 OOS)** :
  - `B2_concepts` : `Id@1 = 0.400`, `Var@1 = 0.333`, `nDCG@10 = 0.370`, `Empty = 0.533` (`R2 = 0.571 Id@1 / 0.286 Var@1 / 0.449 nDCG@10`).
  - `Hybrid_Int8_Tarball_055` : `Id@1 = 0.433` (`+0.033`), `Var@1 = 0.367` (`+0.034`), `nDCG@10 = 0.401` (`+0.031`), `Empty = 0.467` (`-0.066`), `OOS non-vide = 0.000` (`R2 = 0.714 Id@1 / 0.429 Var@1 / 0.584 nDCG@10`, gain marginal ciblé sur formulations patient sans alias, nul sur fautes d'orthographe sévères `R1` et DCI cross-lingues `R3`).
- **Coût isolé (`--expose-gc`, N = 15 845 BDPM + 3 213 ANMV)** & **HTTP E2E apparié (4 rondes alternées, 280 req/mode)** :
  - `B0` retenu : `82.89 MiB` (`heap+external`, peak RSS `338.61 MiB`) ; `B2` allégé : `110.67 MiB` (+`27.78 MiB`, `721 ms` build `ConceptStore`, vs +`76.50 MiB` avant allègement) ; `FXV1_Int8` + encodeur WordPiece `static_mrl_128d_int8` : `135.77 MiB` retenus (`2.59 MB` binaires `FXV1` + `15.18 MB` vocab/poids WordPiece, `73.98 ms` build `FXV1`, `25.64 ms` `loadBinary` avec vérification des normes reconstruites Int8).
  - HTTP Express p50 / p95 (`/api/medicaments/search` pour `legacy/structured/concepts`, route compagnon de bench pour `hybrid_int8`) : `legacy` `2.42 / 4.84 ms`, `structured` `2.87 / 7.20 ms`, `concepts` `2.90 / 6.80 ms`, `hybrid_int8` `3.66 / 12.79 ms` (delta médian apparié `hybrid_int8 - concepts = +0.100 ms`).

Reproduction (avec `FROZENMINISEARCH_PKG_ROOT` pointant vers un répertoire externe contenant le paquet décompressé `@yoch/frozenminisearch@1.13.0`) :

```bash
DATA_DIR=/chemin/vers/data FROZENMINISEARCH_PKG_ROOT=/chemin/vers/pkg-verify node --expose-gc scripts/benchmark/semantic-light/mission/measure_isolated_footprint.js --variant=FXV1_Int8
DATA_DIR=/chemin/vers/data FROZENMINISEARCH_PKG_ROOT=/chemin/vers/pkg-verify node scripts/benchmark/semantic-light/mission/run_final_validation.js
```
- [`run_rigorous_bench.js`](run_rigorous_bench.js) — orchestration complète et comparaison des 11 modèles.
