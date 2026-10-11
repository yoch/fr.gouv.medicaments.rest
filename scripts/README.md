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

## Audit de rétention mémoire

Le rapport et les résultats de référence sont dans
[`docs/AUDIT_MEMOIRE.md`](../docs/AUDIT_MEMOIRE.md). Les deux scripts ci-dessous
travaillent localement, sans contacter la production ni modifier les corpus :

```bash
CORPUS_LIGHT_PROFILE=true AUDIT_TRAFFIC_MODE=normal \
  node --expose-gc --max-semi-space-size=8 scripts/memory/audit-retention.js
node --expose-gc scripts/memory/audit-resource-errors.js
```

Le premier charge les fichiers locaux, émet du trafic HTTP, mesure le tas et les
ressources, puis recharge les mêmes données. `AUDIT_FORCE_GC=0` observe le GC
naturel ; `AUDIT_TRAFFIC_MODE=mixed` inclut les recherches à un caractère. Le
second injecte des erreurs dans des workers isolés et vérifie le pool avec des
générations changeantes. Les résultats restent dans `tmp/memory-audit/`.

## Prérequis

Les scripts mémoire nécessitent `node --expose-gc` (active `global.gc`) :
`gcBeforeMeasure` (dans `src/utils/loadGc.js`) l'utilise pour des mesures reproductibles.

Les scripts de `benchmark/` qui comparent au MiniSearch canonique nécessitent
`npm install --no-save minisearch` (non dépendance de prod).
