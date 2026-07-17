# scripts/

Scripts hors runtime de production : profilage mémoire, benchmarks, extraction RCP, audits sources.
Aucun de ces fichiers n'est chargé par `src/server.js`.

## Organisation

| Dossier | Rôle |
|---------|------|
| `audit/` | Comparaisons de sources publiques (ANSM export / fiches HTML, BDPM dispo, EMA monitoring). Artefacts dans `tmp/audit/` (gitignored). |
| `memory/` | Profilage mémoire résident : pic RSS/heap, empreinte des index frozen, heap snapshots. |
| `benchmark/` | Comparaisons de ranking, parsers, interning, streaming. Voir `benchmark/README.md`. |
| `extract_rcp.py`, `convert_rcp_to_markdown.py` | Extraction RCP depuis `CIS_RCP.csv` (hors Node). |

## Audits

```bash
npm run audit:ansm-dispo      # → docs/AUDIT_ANSM_EXPORT_VS_BDPM_DISPO.md
npm run audit:ansm-fiches     # → docs/AUDIT_ANSM_FICHE_BOT.md
npm run audit:ema-monitoring  # → docs/AUDIT_EMA_ADDITIONAL_MONITORING_VS_BDPM.md
```

## Prérequis

Les scripts mémoire nécessitent `node --expose-gc` (active `global.gc`) :
`gcBeforeMeasure` (dans `src/utils/loadGc.js`) l'utilise pour des mesures reproductibles.

Les scripts de `benchmark/` qui comparent au MiniSearch canonique nécessitent
`npm install --no-save minisearch` (non dépendance de prod).
