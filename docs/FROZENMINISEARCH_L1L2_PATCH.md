# frozenminisearch — patch L1+L2 et mesures mémoire (pic BDPM)

## Contexte

Objectif : réduire le pic mémoire (`heapUsed`) au chargement BDPM (~146k enregistrements, 10 index frozenminisearch construits séquentiellement).

**Méthodologie de mesure corrigée** : le sampler 100ms (`createMemorySampler`) **sous-estime** le vrai pic — il rate les pics brefs juste avant les GCs, notamment les pics « avant major GC » quand old space se remplit. On mesure désormais avec `--trace-gc` : V8 reporte la taille exacte du heap **à chaque GC** (ligne `Scavenge X (Y) -> Z (W) MB`), le pic est le `max(X)` sur toute la run. Capture exacte, pas un échantillon.

Scripts de mesure :
- `scripts/memory/measure-bdpm-peak.js` — chargeur BDPM minimal (tourne avec `--trace-gc`).
- `scripts/memory/sweep-semi-space.js` — orchestrateur : sweep `--max-semi-space-size` × N runs, parse `--trace-gc`, rapporte min/médiane/max.

### Mesures A/B propres (trace-gc, 5 runs, pic exact avant GC)

| config | runs (Mo) | min | médiane | max |
|--------|-----------|-----|---------|-----|
| default (auto=64), **sans** L1+L2 | 138.5, 139.9, 143.2, 143.2, 143.3 | 138.5 | **143.2** | 143.3 |
| default (auto=64), **avec** L1+L2 | 138.7, 143.2, 129.0, 143.5, 139.6 | 129.0 | 139.6 | 143.5 |
| semi-space=8, sans L1+L2 | 167.1, 127.9, 167.7, 167.5, 98.6 | 98.6 | 167.1 | 167.7 |
| semi-space=6, avec L1+L2 | 139.4, 117.8, 167.3, 166.3, 134.7 | 117.8 | 139.4 | 167.3 |
| semi-space=4, avec L1+L2 | 103.3, 154.9, 100.1, 166.8, 145.0 | 100.1 | 145.0 | 166.8 |

Résident après GC : ~70 Mo (stable, indépendant de la config).

### Conclusions corrigées

1. **Vrai baseline : ~143 Mo stable** (le « 178.6 Mo » du sampler était une surestimation au début de la session ; le sampler n'est pas fiable pour le pic).
2. **L1+L2 : ~3 Mo sur la médiane** (143.2 → 139.6), dans le bruit sur le max. Gain marginal mais cleanup légitime, sans downside.
3. **`--max-semi-space-size` n'est PAS un gain** : semi-space=8 est bimodal (98 ou 167), semi-space=6/4 ont un max à 167 Mo — **pire que default**. Le sampler nous trompait : il voyait le heap steady-state (plus bas avec petit semi-space) mais ratait les pics « avant major GC » (plus haut car un petit semi-space force plus de promotions vers old space → old space se remplit plus → major GC à un watermark plus élevé).

---

## Patch L1+L2 à appliquer dans frozenminisearch (source TS)

Référence : dist compilé `node_modules/@yoch/frozenminisearch/dist/cjs/index.cjs` reflète la structure TS 1:1. Adapter aux noms de fichiers/types de la source TS.

### L2 — `IncrementalPostingsAccumulator.finalize()`

**Fichier** : celui qui définit `IncrementalPostingsAccumulator` (probablement `src/postings/accumulator.ts` ou similaire).

**Problème** : `finalize()` appelle `this.clear()` après `scatterPostings()`. `clear()` appelle `truncate(0)` sur chaque `GrowableUint32Column`. Mais `truncate(0)` ne libère pas le buffer sous-jacent — la condition `length > 0 && length < this._buf.length` skip le slice quand `length === 0`. Le buffer sur-alloué (jusqu'à 2× via doublage de capacité) reste vivant jusqu'au GC de l'accumulateur, lui-même référencé par le builder jusqu'au GC du builder.

**Fix** : l'accumulateur n'est jamais réutilisé après `finalize()`. Remplacer les deux appels `this.clear()` (branche dense + branche sparse, juste après `this.scatterPostings(...)`) par une libération explicite des buffers :

```ts
// À la place de this.clear() dans les deux branches (dense et sparse) de finalize() :
this._docIds = null as unknown as GrowableUint32Column;
this._freqs = null as unknown as GrowableFreqColumn;
this._slotIds = null as unknown as GrowableUint32Column;
this._totalPostings = 0;
```

**Alternative plus propre** : ajouter une méthode `release()` à `GrowableUint32Column` / `GrowableFreqColumn` qui fait `this._buf = null; this._len = 0;`, et l'appeler depuis `finalize()`. Garde `clear()` intact pour l'API publique (truncate est sémantiquement « remet à zéro pour réutilisation », release est « libère définitivement »).

### L1 — `FrozenIndexBuilder.freezeParams()`

**Fichier** : celui qui définit `FrozenIndexBuilder` (probablement `src/builder.ts` ou `src/frozenIndexBuilder.ts`).

**Problème** : `freezeParams()` construit toutes les structures compactes dans des locaux (`postings`, `index`, `externalIds`, `storedFields`, `avgFieldLength`) et les retourne, mais **garde les anciennes structures growable référencées par `this`** (`this._postings`, `this._fieldLengthData`, `this._externalIds`, `this._seenIds`, `this._termIndex`, `this._terms`, `this._storedFields`, `this._avgFieldLength`, et les scratch `_fieldTermFreqScratch` / `_rawTokenScratch` / `_tokenScratch`). Ces résiduels restent vivants jusqu'au GC du builder lui-même, pas jusqu'à la fin du freeze. Quand plusieurs builders s'enchaînent, les résiduels s'overlap.

**Fix** : extraire `fieldLengthMatrix` dans un local (actuellement inline dans le return), puis nuller tous les champs `this.*` juste avant le `return` :

```ts
freezeParams(): FrozenIndexParams {
  // ... code existant inchangé jusqu'à :
  const storedFields = resizeStoredFields(this._storedFields, documentCount);
  const idLookup = createIdToShortIdLookup(externalIds, documentCount);
  const fieldLengthMatrix = materializeFieldLengthMatrix(
    this._fieldLengthData,
    documentCount * this._fieldCount
  );

  // L1: libérer les structures growable résiduelles maintenant.
  // Toutes les structures compactes sont déjà dans des locaux ci-dessus ;
  // le builder n'est jamais réutilisé après freezeParams().
  this._postings = null as unknown as IncrementalPostingsAccumulator;
  this._fieldLengthData = null as unknown as number[];
  this._externalIds = null as unknown as unknown[];
  this._seenIds = null as unknown as Set<unknown>;
  this._termIndex = null as unknown as Map<string, number>;
  this._terms = null as unknown as string[];
  this._storedFields = null as unknown as StoredFieldsLayout;
  this._avgFieldLength = null as unknown as number[];
  this._fieldTermFreqScratch = null as unknown as Map<string, number>;
  this._rawTokenScratch = null as unknown as Set<string>;
  this._tokenScratch = null as unknown as string[];

  return {
    options: this._options,
    documentCount,
    nextId: documentCount,
    fieldIds: this._fieldIds,      // gardé : retourné
    fieldCount: this._fieldCount,  // gardé : retourné
    externalIds,
    idLookup,
    storedFields,
    fieldLengthMatrix,
    avgFieldLength,
    index,
    termCount,
    postings,
  };
}
```

**Ne pas nuller** : `this._options`, `this._fieldIds`, `this._fieldCount` (retournés dans l'objet), `this._frozen` (flag d'état).

### Vérification côté lib

`npm test` dans frozenminisearch (tests unitaires builder/freeze).

### Vérification côté app (après bump de version)

```bash
npm install
npx jest                                                    # tests app verts
node --expose-gc --trace-gc scripts/memory/measure-bdpm-peak.js 2>&1 | \
  grep -oE '(Scavenge|Mark-Compact) [0-9]+\.[0-9]+' | awk '{print $2}' | sort -rn | head -1
# pic attendu ~140 Mo (vs ~143 sans patch), gain marginal mais réel sur la médiane
```

---

## Pistes qui émergent (mesures corrigées)

Le vrai pic (~143 Mo) = résident ~70 Mo + transient ~73 Mo. Le transient est le **watermark d'old space avant major GC** : garbage promu (objets CSV, scratch builder, strings) + structures builder vivantes pendant les builds.

Réductions possibles du transient :

1. **L3 — `_fieldLengthData` en `Uint16Array`** (lib) : élimine la copie transient de `materializeFieldLengthMatrix` + 4× plus petit résident. ~2-5 Mo.
2. **Piste CSV** (app) : réduire le garbage per-row (csv-parse sans `columns` → arrays, ou readline+split). ~10-15 Mo potentiel sur le watermark promu.
3. **Heap snapshot au pic** : `v8.writeHeapSnapshot()` déclenché au bon moment pour attribuer précisément les ~73 Mo transient (csv vs builder vs corpus vs cisIndexes). Décisionnel.
4. **Charger les index binaires pré-construits au démarrage** (app) : ÉCARTÉ — les binaires doivent être construits quelque part (process offline OU in-process au reload), le pic de build existe dans tous les cas ; déplacer le build ne supprime pas le pic.

---

## Interning sélectif des strings (app) — gain résident -12 Mo

### Diagnostic (heap snapshot résident)

Snapshot résident (post-load + gc) : 829,364 string nodes / 38.08 Mo, mais seulement **158,457 valeurs distinctes** → 670,907 copies dupliquées (29.64 Mo). Les duplicates viennent d'une poignée de champs BDPM à faible cardinalité : `statut_amm` ("Autorisation active" × 14870), `commercialisation` ("Commercialisée" × 13590), `forme_pharma` ("comprimé" × 13407), `surveillance_renforcee` ("Non" × 15354, "oui" × 15012), `etat_commercialisation` ("Présentation active" × 20804), `taux_remboursement` ("65%" × 9146), etc. V8 n'interne pas les strings heap issues d'I/O — chaque `CorpusRecord` stocke sa propre copie.

### Mise en œuvre (approche A : drapeau par champ)

- **`src/utils/stringPool.js`** : pool global `Map<string, string>` + `intern(s)` (O(1), dédup par référence). Null/empty passent à travers.
- **`src/models/defineCorpusRecord.js`** : option `lowCardinalityFields: string[]` → `lowCardSet`. Dans `fromCsv`, les champs du set passent par `intern(v)` avant `new CorpusRecord(...)`.
- **`src/models/bdpm/records.js`** : champs low-card marqués par classe :
  - Specialite : `forme_pharma, voies_admin, statut_amm, type_amm, commercialisation, surveillance_renforcee`
  - Presentation : `etat_commercialisation, taux_remboursement, indications`
  - Composition : `nature_composant`
  - AvisSmr / AvisAsmr : `motif_evaluation, valeur_smr/asmr, libelle_smr/asmr`
  - Generique : `type_generique`
  - Condition : `condition`
  - Rupture : `code_statut, libelle_statut`
  - Mitm : `code_atc`

On n'interne PAS les champs à haute cardinalité (`cis`, `cip13`, `denomination`, `libelle`, `titulaire`, `code_substance`, `denomination_substance`) — interner les codes uniques enflerait le pool pour 0 dédup.

### Mesures (trace-gc pour le pic, snapshot pour le résident)

| métrique | avant | après | gain |
|----------|-------|-------|------|
| Résident (heapUsed après GC) | 70 Mo | **58 Mo** | **-12 Mo** |
| Strings (self_size) | 38.08 Mo / 829k nodes | 25.66 Mo / 568k nodes | -12.4 Mo, -261k nodes |
| Pic trace-gc (médiane 5 runs) | 139.6 Mo | 138.1 Mo | ~-1.5 Mo (bruit) |

L'interning est un **gain résident** (-12 Mo, -17%), pas un gain sur le pic. Le pic reste dominé par le transient garbage (objets CSV per-row, scratch builder, document objects) que l'interning ne touche pas.

### Bénéfice secondaire : scénario reload

Au reload (rebuild sans restart), old resident + new build coexistent temporairement. Old resident 58 vs 70 Mo → la coexistence old+new baisse de ~12 Mo également.

### Tests

`npx jest` : 58 passed, 41 skipped (data-absent), 0 failed.

---

##État des pistes (synthèse corrigée)

- **L1+L2 (lib frozenminisearch)** : ~3 Mo sur le pic médian, cleanup légitime. Instructions ci-dessus.
- **Interning strings (app)** : **-12 Mo résident**, gain réel steady-state + reload. Implémenté et mesuré.
- **Flag V8 `--max-semi-space-size`** : PAS un gain (max 167 Mo > baseline 143). Écarté.
- **Pic load (~138 Mo)** : reste dominé par transient garbage entre GCs. Pistes restantes pour le pic : L3 (typed fieldLength, lib, ~2-5 Mo), piste CSV (réduire garbage per-row). Le heap snapshot ne peut pas attribuer le transient (garbage invisible aux safe points GC).

