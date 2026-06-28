# scripts/benchmark

Scripts de comparaison et de diagnostic performance. Hors runtime de prod.

## `debug_ranking.js`, `analyze_scores.js`

Références de comparaison pour le ranking, utilisant la bibliothèque `minisearch`
(classique, non frozen) comme baseline. `minisearch` n'est **pas** une dépendance
de prod — pour exécuter ces scripts :

```bash
npm install --no-save minisearch
node scripts/benchmark/debug_ranking.js
node scripts/benchmark/analyze_scores.js
```

Utile pour vérifier qu'un changement de ranking dans `@yoch/frozenminisearch`
ou dans `src/utils/searchRanking.js` ne régresse pas par rapport au comportement
MiniSearch canonique.

## Autres scripts

- `vet-xml-parsers.js` — compare les parsers XML vétérinaires (`fast-xml-parser`,
  `@nodable/flexible-xml-parser`). `fast-xml-parser` est en `devDependencies`.
- `analyze-interning-candidates.js` — liste les champs BDPM à faible cardinalité
  candidats à l'interning.
- `analyze-bdpm-corpus-size.js` — empreinte par colonne du corpus BDPM.
- `compare-bdpm-interning.js` / `compare-vet-streaming.js` — comparaisons
  avant/après via worktrees git éphémères (commits hardcodés).
- `stress-test-prod.js` — charge contre une instance locale/prod.
- `analyze_boosting.js`, `analyze_search_llm.js`, `benchmark_boosting.js`,
  `benchmark_search_after.js` — diagnostics ad hoc ranking/boosting.
