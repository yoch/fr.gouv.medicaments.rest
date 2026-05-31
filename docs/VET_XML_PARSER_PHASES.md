# Parsing XML vétérinaire — phases et notes

## Phase 1 (en production)

**Objectif :** supprimer le contenu RCP des objets JS produit tout en gardant le découpage readline éprouvé.

**Flux :**

1. [`streamMedicinalProductsXml.js`](../src/utils/streamMedicinalProductsXml.js) — lecture ligne à ligne, extraction de chaque bloc `<medicinal-product>…</medicinal-product>`.
2. [`vetXmlParser.js`](../src/utils/vetXmlParser.js) — `@nodable/flexible-xml-parser` avec `skip.tags` :
   - `..paragraphes-rcp` — contenu ignoré (pas de chaîne résiduelle).
   - `..lien-rcp` — ignoré en prod (`lien_rcp` API reconstruit depuis `nom` + `maj-rcp`).
3. [`vetDataLoader.js`](../src/services/vetDataLoader.js) — remplissage corpus + indexation inchangés.

**Pourquoi pas `stopNodes` (fast-xml-parser) :** `stopNodes` laisse le corps RCP comme une grosse `string` sur l’objet (~38 Mo cumulés sur le fichier produits complet en bench).

**Dépendances :** `@nodable/flexible-xml-parser` uniquement (builder compact intégré au paquet, pas de `import()` ESM séparé).

**Mesures (amm-vet-fr-v2-v.xml, 3213 produits, mai 2026) :**

| Indicateur | Baseline FXP | Phase 1 |
|------------|----------------|---------|
| Parse bench (durée) | ~8,3 s | ~7,6 s |
| `paragraphes-rcp` dans objets | ~37,8 M car. | 0 |
| `vet_cache_only_stream` RSS (profil vet seul) | — | **~163 Mo** |

Bench : `npm run benchmark:vet-xml`  
Profil : `PROFILE_VET=1 PROFILE_BDPM=0 node --expose-gc scripts/profile-load-memory-highfreq.js`

**Tests scan RCP :** [`scanVetProductsXml.js`](../tests/helpers/scanVetProductsXml.js) utilise `VET_SKIP_SCAN_TAGS` (seul `paragraphes-rcp` ignoré) pour conserver `<lien-rcp>` dans les tests d’équivalence.

---

## Phase 2 (non retenue en prod — notes pour la suite)

**Idée :** `parser.parseStream(fs.createReadStream(productsPath))` sur le fichier entier, sans readline.

**Résultat mesuré (bench + profil chargement complet) :**

- Bench parse seul : **+112 Mo** heap pour l’arbre JS complet.
- Profil `loadVetData` : pic stream **~714 Mo RSS** / **~628 Mo heap** vs **~163 Mo RSS** en phase 1.

**Conclusion :** `parseStream` sans sink **aggrave** la mémoire (arbre global de tous les produits). Ne pas activer en production sans phase 3.

**Code de référence :** `extractMedicinalProductsFromGroup()` + bench phase `phase2` dans [`scripts/benchmark-vet-xml-parsers.js`](../scripts/benchmark-vet-xml-parsers.js) (désactivée par défaut ; `BENCHMARK_PHASES` sans `phase2`).

---

## Phase 3 (à décider)

**Objectif :** combiner `parseStream` (plus de buffer readline géant par produit) et mémoire bornée (pas d’arbre global).

**Pistes (doc `@nodable/flexible-xml-parser`) :**

- `OutputBuilder` custom (`@nodable/compact-builder`) avec `onTagClose` sur `medicinal-product` : émettre le produit au callback, ne pas l’ajouter au parent (`return null` casse la pile — utiliser balise discard + `_addChildTo` noop, ou sous-classe `CompactBuilder`).
- `getOutput()` ne retient que les métadonnées racine (`Informations` / `date-jeu-de-donnees`).

**Risques :**

- `@nodable/compact-builder` est ESM-only → Jest peut exiger `--experimental-vm-modules` si import dynamique, ou builder inline minimal.
- Première implémentation avait fuite mémoire (~800 Mo) avec `onTagClose` + `return null` (pile builder non dépilée).

**Critère de succès envisagé :** `vet_cache_only_stream` nettement sous la phase 2, proche ou meilleur que phase 1, sans concaténation readline des blocs RCP.

---

## Fichiers du commit phase 1

| Fichier | Rôle |
|---------|------|
| `src/utils/vetXmlParser.js` | Parsers singletons + `parseProductBlock(block, parser)` |
| `src/services/vetDataLoader.js` | Chargeur prod |
| `tests/helpers/scanVetProductsXml.js` | Scan tests RCP |
| `scripts/benchmark-vet-xml-parsers.js` | Comparaison baseline / phase1 / phase2 |
| `package.json` | `@nodable/flexible-xml-parser` ; `fast-xml-parser` en devDep (bench) |
