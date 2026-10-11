# Parsing XML vétérinaire — phases et notes

## En production : découpage en blocs + saxes

**Flux :**

1. [`streamMedicinalProductsXml.js`](../src/utils/streamMedicinalProductsXml.js) — lecture par chunks, découpage synchrone des lignes, extraction de chaque bloc `<medicinal-product>…</medicinal-product>`. Les sous-arbres `paragraphes-rcp` et `lien-rcp` sont retirés dès le découpage.
2. [`vetXmlParser.js`](../src/utils/vetXmlParser.js) — [`saxes`](https://github.com/lddubeau/saxes) (parseur SAX strict, conforme XML 1.0, entités décodées) et un constructeur d'objet compact :
   - une balise feuille donne son texte, espaces normalisés, **sans conversion de type** ;
   - une balise répétée donne un tableau ;
   - les sous-arbres ignorés le sont aussi côté parseur (`VET_SKIP_PRODUCT_TAGS`).
3. [`loadPipeline.js`](../src/services/vet/loadPipeline.js) — remplissage du corpus puis indexation.

**Valeurs en texte :** l'ancien parseur convertissait `"0"` en nombre, et `parseTempsAttente` (`if (!route['qte-ta'])`) écartait alors les temps d'attente nuls (2 507 sur 5 699, corpus de mai 2026). Ils sont désormais exposés. Seul autre effet sur le corpus : une quantité `8.0` n'est plus réécrite en `8`.

**Mesures (amm-vet-fr-v2-v.xml, 53 Mo, 3 213 produits, Node 24, `--max-semi-space-size=8`) :**

| Étape | Avant (readline + flexible-xml-parser) | Après |
|-------|----------------------------------------|-------|
| `loadVetData` complet | 4,3–5,0 s | 1,4–1,7 s |
| Parsing des blocs seul | ~1,3 s | ~0,25 s |
| Heap retenu après chargement et GC | 11,4 Mo | 11,8 Mo |

**Copie des valeurs :** saxes renvoie des sous-chaînes du bloc. Sous V8, elles gardaient le bloc entier en vie (29,3 Mo retenus au lieu de 11,8 Mo) ; `leafText` recopie donc chaque valeur d'au moins 13 caractères. JavaScriptCore (Bun) n'est pas concerné.

Les RCP représentent 74 % du fichier (38 M de caractères sur 52 M) : ils sont retirés avant le parsing, ce qui reste plus rapide que de les faire traverser par un parseur.

Bench : `npm run benchmark:vet-xml` (fast-xml-parser, ancien comportement, contre saxes).

**Tests scan RCP :** [`scanVetProductsXml.js`](../tests/helpers/scanVetProductsXml.js) utilise `VET_SKIP_SCAN_TAGS` (seul `paragraphes-rcp` ignoré) pour conserver `<lien-rcp>` dans les tests d'équivalence.

---

## Historique

### Phase 1 — `@nodable/flexible-xml-parser` par bloc (remplacée)

Découpage readline puis `flexible-xml-parser` avec `skip.tags`. Retirait le contenu RCP des objets (≈ 37,8 M caractères conservés par `stopNodes` avec fast-xml-parser). Environ 45 % du temps de parsing partait dans la conversion des valeurs en nombres (`strnum`).

### Phase 2 — `parseStream` sur le fichier entier (non retenue)

Arbre global de tous les produits : pic ~714 Mo RSS / ~628 Mo heap, contre ~163 Mo en phase 1.

### Phase 3 — flux entier avec émission des produits (non retenue)

Mesurée en octobre 2026 :

- `flexible-xml-parser` en flux avec un `CompactBuilder` qui remet chaque produit au callback (`_addChildTo`) : sortie identique, ~110 Mo RSS, mais 3,3–3,8 s, car le parseur traverse les 38 M de caractères RCP (`skip.tags` comme `stopNodes`).
- `saxes` sur le fichier entier : sortie identique, 1,9 s, mais pic ~320 Mo à cause des événements texte des RCP.

### Alternatives comparées (parsing des 3 213 blocs)

| Parseur | Durée |
|---------|-------|
| flexible-xml-parser (phase 1) | ~1 300 ms |
| fast-xml-parser | 1 500–1 900 ms |
| sax | ~830 ms |
| htmlparser2 (xmlMode) | ~300 ms |
| saxes | ~280 ms |
| txml | ~230 ms, mais non validant et sans décodage des entités |
