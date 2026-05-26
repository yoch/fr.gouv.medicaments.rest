# Attribution mémoire — pipeline d’indexation (passation agent minisearch)

Document de synthèse pour reprise dans le dépôt `@yoch/minisearch` ou poursuite d’optimisation.  
Projet source : `fr.gouv.medicaments.rest` (API BDPM + vétérinaire).

---

## 1. Contexte et observation produit

- Stack : CSV (`csv-parse`) et/ou XML vétérinaire (`fast-xml-parser`) → corpus en mémoire → `FrozenMiniSearch.fromDocuments()` (`@yoch/minisearch`).
- Observation terrain : **~600 Mo RSS** juste après construction, puis **~280–310 Mo RSS** stabilisé.
- Contrainte : le **corpus métier doit rester en mémoire** après l’index (lookup par `res.id` → ligne dans `dataCache`). Ne pas proposer de supprimer ce corpus en prod.

**Important — nommage :** en prod ce n’est pas le tableau `documents[]` d’index qui persiste, mais **`dataCache`** (lignes CSV/objets complets). Les `documents[]` sont **vidés** après `fromDocuments` dans `buildFrozenIndexFromRows`.

---

## 2. Localisation du code

| Étape | Fichier | Symbole |
|-------|---------|---------|
| Parse CSV BDPM | `src/services/dataLoader.js` | `parseFileStreaming()` |
| Corpus persistant | `src/services/dataLoader.js` | `dataCache`, `cisIndexes` |
| Documents d’index (éphémères) | `src/services/dataLoader.js` | `buildIndexDocument()` |
| Build index | `src/utils/frozenMiniSearch.js` | `buildFrozenIndexFromRows()` → `FrozenMiniSearch.fromDocuments()` |
| Options recherche | `src/utils/searchRanking.js` | `miniSearchOptions` |
| Config par type | `src/services/dataLoader.js` | `createIndexIncremental()` |
| Lookup | `src/services/dataLoader.js` | `dataCache[type][res.id]` (`id` = index de ligne) |
| Vétérinaire | `src/services/vetDataLoader.js` | streaming produits + dict XML |
| Démarrage | `src/server.js` | `loadData()` puis `loadVetData()` |

```javascript
// src/utils/frozenMiniSearch.js — documents éphémères
const frozen = FrozenMiniSearch.fromDocuments(documents, options);
documents.length = 0;
return frozen;
```

---

## 3. Configuration `fromDocuments` (réelle)

- **`idField`** : implicite `id` (entier = `rowIndex`).
- **`storeFields`** : `['id']` uniquement (pas de duplication du corpus via store).
- **`tokenize`** / **`processTerm`** : `tokenizeSearchText` + `normalizeSearchText` (NFD, sans accents, lowercase).
- **`searchOptions`** : `combineWith: AND`, `prefix` sauf termes purement numériques, `fuzzy: 0.2` sauf termes commençant par un chiffre.
- **`boost`** : par type (ex. spécialités : `denomination: 3`, `cis: 2`, …).

Exemple spécialités :

```javascript
{
  fields: ['cis', 'denomination', 'forme_pharma', 'titulaire'],
  storeFields: ['id'],
  ...miniSearchOptions,
  boost: { denomination: 3, cis: 2, forme_pharma: 0.5, titulaire: 1 }
}
```

### Volumes (BDPM + HAS)

| Type | Documents | Champs indexés |
|------|-----------|----------------|
| specialites | 15 848 | cis, denomination, forme_pharma, titulaire |
| presentations | 20 905 | cis, cip7, cip13, libelle, indications |
| compositions | 32 389 | cis, denomination_substance, dosage |
| avis_smr / avis_asmr | 15 257 / 9 906 | libellés HAS |
| autres | generiques, conditions, ruptures, mitm, substances | voir `dataLoader.js` |

- Corpus `dataCache` (JSON) ≈ **39 Mo**.
- Σ `estimatedStructuredBytes` (10 index BDPM) ≈ **44,5 Mo**.
- `storeFields` : `storedFieldsJsonBytes` négligeable (ex. ~175 Ko / 15 848 docs spécialités). La duplication utile est **texte tokenisé (postings + radix)** vs chaînes dans `dataCache`.

---

## 4. Parsing (sans refactor)

**CSV** : API streaming (`createReadStream` → `pipe(parser)`), mais **accumulation complète** dans `records[]`. Après `end`, parser/stream non référencés.

**XML vétérinaire** : dict en `readFileSync` (~911 Ko) ; produits (~51 Mo fichier) en streaming par bloc `<medicinal-product>` ; arbre JS intermédiaire par bloc, jeté après extraction vers `vetCache`.

**Note opérationnelle :** `loadData()` / `loadVetData()` ne sont pas réentrants. En cas de reload concurrent (ex. in-process + intervalle court), `dataCache` peut être partiellement rempli jusqu’à la fin du chargement. À éviter en prod ou à protéger par un verrou si besoin.

---

## 5. Environnement de mesure

| Paramètre | Valeur |
|-----------|--------|
| Node | v22.22.0 |
| `@yoch/minisearch` | 8.0.0-beta.1 (installé ; package.json ^8.0.0-beta.2) |
| GC | `node --expose-gc` + `global.gc()` avant chaque mesure |
| Scripts | `scripts/profile-index-memory.js`, `scripts/profile-memory-settle.js` |

---

## 6. Tableau mémoire — construction (chemin prod, gc avant mesure)

| Étape | heapUsed (Mo) | rss (Mo) | Notes |
|-------|---------------|----------|-------|
| baseline | 3,4 | 42 | |
| after_loadData (BDPM) | 131,3 | 307–335 | `dataCache` + 10 index + `cisIndexes` |
| after_loadVetData (BDPM+vet) | 150,8 | **~601** | pic RSS observé |
| steady heap | ~151 | — | Stable sur 3 min |

Pic isolé `fromDocuments` (spécialités seules, script) : heap **60,7** / RSS **148,6** pendant build ; RSS post-build avec corpus **~129**.

---

## 7. Stabilisation RSS (test 3 min — BDPM + vet)

**Méthode :** `scripts/profile-memory-settle.js` avec `SETTLE_MINUTES=3`, `SETTLE_INTERVAL_SEC=15`, après `loadData()` + `loadVetData()`.

| t après fin construction | heapUsed (Mo) | rss (Mo) |
|--------------------------|---------------|----------|
| 0 | 150,77 | **597,91** |
| +15 s | 150,75 | **597,91** |
| **+30 s** | 150,75 | **280,67** |
| +60 s … +181 s | 150,76–77 | **280,67** (plateau) |

**Conclusions :**
- La chute **600 → ~280 Mo RSS** n’apparaît pas avant **~30 s** après la fin de construction (mesure à 5 s était trompeuse).
- **heapUsed stable** (~151 Mo) : rendu RSS par l’OS / allocateur, pas compaction heap majeure.
- Pic surtout **pendant / à la fin de l’indexation** (cumul corpus + `documents[]` temporaires + structures frozen), pas « parse seul ».

---

## 8. `frozenMemoryBreakdown` (agrégat BDPM)

Fonction exportée : `frozenMemoryBreakdown(frozen)` depuis `@yoch/minisearch`.

| Index | documentCount | termCount | estimatedStructured (Mo) | storedFieldsJson (Ko) |
|-------|---------------|-----------|--------------------------|------------------------|
| specialites | 15 848 | 23 015 | 6,33 | 175 |
| presentations | 20 905 | 59 366 | **14,25** | 234 |
| compositions | 32 389 | 20 796 | 6,57 | 369 |
| avis_smr | 15 257 | 11 317 | 4,71 | 168 |
| avis_asmr | 9 906 | 12 901 | 4,71 | 105 |
| generiques | 10 704 | 1 999 | 1,30 | 115 |
| conditions | 28 151 | 346 | 1,97 | 319 |
| ruptures | 766 | 11 | 0,05 | 7 |
| mitm | 7 711 | 11 703 | 2,87 | 82 |
| substances | 3 896 | 3 815 | 0,87 | 41 |
| **Σ** | | | **~44,5** | |

Vétérinaire (médicaments) : ~1,4 Mo structuré / 3 213 docs.

Postings + radix dominent ; `storedFieldsJsonBytes` marginal.

---

## 9. Estimations

- **Index structuré** ≈ 45 Mo (breakdown).
- **Corpus JSON** ≈ 39 Mo.
- **Heap steady** ≈ 151 Mo → corpus + index + maps + overhead V8 cohérents.
- **RSS steady** ≈ **281 Mo** (BDPM+vet, t ≥ 30 s) vs **~206 Mo** (BDPM seul, t ≥ 15 s après construction — §14).

Diagnostic hors prod (`after_index_corpus_only`) : index seul spécialités ~**7–8 Mo heap** une fois `dataCache` nullé.

---

## 10. Hypothèses (classées)

| Probabilité | Hypothèse |
|-------------|-----------|
| Très haute | Pic pendant `fromDocuments` avec tout `dataCache` déjà chargé + `documents[]` temporaires |
| Très haute | Superposition BDPM + vet ; RSS pic ~600 Mo puis rendu OS différé (~30 s) |
| Haute | Corpus + ~45 Mo structures index + overhead |
| Faible | Duplication `storeFields` |
| Faible | Buffers CSV encore référencés après parse |

---

## 11. Leviers (sans supprimer `dataCache`)

1. `LOAD_HAS_AVIS=false` si acceptable : −2 gros CSV/index HAS.
2. Réduire champs indexés sur gros textes (`indications`, libellés HAS) — cible principale postings/radix (`presentations` ~14 Mo).
3. Vet : chargement différé / process séparé pour éviter pic RSS superposé à BDPM.
4. `storeFields: ['id']` déjà minimal — gain marginal à le vider.

---

## 12. Pour minisearch — questions ouvertes

- **Versions** : Node 22.x ; `@yoch/minisearch` 8.0.0-beta.1.
- **Options exactes** : §3.
- **Chiffres** : pic RSS ~601 Mo ; steady RSS ~281 Mo (t ≥ 30 s) ; heap ~151 Mo ; Σ structured ~45 Mo.
- **Question** : *« Le pic est-il surtout pendant finalize/index ou déjà après parse ? »*  
  → **Pendant / à la fin de l’indexation**, avec corpus déjà en RAM. Le parse augmente progressivement le heap ; le pic RSS ~600 Mo est lié au build index (surtout fin vet) + rétention allocateur, puis rendu OS ~30 s plus tard.
- **Question** : *« Pourquoi RSS >> heap + structured ? »*  
  → Arènes V8 / mmap non rendus immédiatement ; heap stable après GC alors que RSS chute plus tard.

---

## 13. Reproductibilité

```bash
# Profil détaillé par étapes
node --expose-gc scripts/profile-index-memory.js

# Stabilisation post-construction
SETTLE_MINUTES=3 SETTLE_INTERVAL_SEC=15 node --expose-gc scripts/profile-memory-settle.js

# BDPM seul, 1 min
PROFILE_VET=0 SETTLE_MINUTES=1 SETTLE_INTERVAL_SEC=15 node --expose-gc scripts/profile-memory-settle.js
```

Variables : `LOAD_HAS_AVIS=false`, `PROFILE_VET=0`, `SETTLE_MINUTES`, `SETTLE_INTERVAL_SEC`.

---

## 14. BDPM seul — stabilisation 1 min

**Commande :** `PROFILE_VET=0 SETTLE_MINUTES=1 SETTLE_INTERVAL_SEC=15 node --expose-gc scripts/profile-memory-settle.js`  
**Durée construction :** ~6 s (`loadData` uniquement).

| t après fin construction | heapUsed (Mo) | rss (Mo) | heapTotal (Mo) |
|--------------------------|---------------|----------|----------------|
| 0 (construction_end) | 131,30 | **288,01** | 184 |
| +15 s | 130,44 | **205,37** | 137 |
| +30 s … +60 s | 130,44 | **205,62–75** | ~136 (plateau) |

**Résumé BDPM seul :**
- Pic RSS à la fin de construction : **~288 Mo** (pas ~600 Mo — le vet multiplie le pic).
- Palier stabilisé (≥15 s, stable 1 min) : **~206 Mo RSS**, **~130 Mo heap**.
- Δ RSS construction → plateau : **≈ −82 Mo** rendus à l’OS entre t+0 et t+15 s.
- Vet ajoute ~**+300 Mo** de pic RSS transitoire (601 vs 288) et ~**+75 Mo** de RSS steady (281 vs 206).

Comparaison rapide :

| Scénario | RSS pic (fin construction) | RSS steady (≥30 s) | heap steady |
|----------|----------------------------|--------------------|-------------|
| BDPM seul | ~288 Mo | ~206 Mo | ~130 Mo |
| BDPM + vet | ~598 Mo | ~281 Mo | ~151 Mo |
