# scripts/

Scripts hors runtime de production : profilage mémoire, benchmarks, extraction RCP.
Aucun de ces fichiers n'est chargé par `src/server.js`.

## Organisation

| Dossier | Rôle |
|---------|------|
| `memory/` | Profilage mémoire résident : pic RSS/heap, empreinte des index frozen, heap snapshots. |
| `benchmark/` | Comparaisons de ranking, parsers, interning, streaming. Voir `benchmark/README.md`. |
| `extract_rcp.py`, `convert_rcp_to_markdown.py` | Extraction RCP depuis `CIS_RCP.csv` (hors Node). |

## Prérequis

Les scripts mémoire nécessitent `node --expose-gc` (active `global.gc`) :
`gcBeforeMeasure` (dans `src/utils/loadGc.js`) l'utilise pour des mesures reproductibles.

Les scripts de `benchmark/` qui comparent au MiniSearch canonique nécessitent
`npm install --no-save minisearch` (non dépendance de prod).
