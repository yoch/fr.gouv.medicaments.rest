# Audit comparatif — MiniSearch vs SQLite FTS5 (BDPM)

**Date :** 2026-05-25T20:05:32.920Z

## Résumé exécutif

| Indicateur | Valeur |
|------------|--------|
| Cas de recherche comparés | 15 |
| Top 1 identique (CIS/libellé) | **86.7%** (13/15) |
| Top 5 identique | **73.3%** (11/15) |
| Volume total identique | **86.7%** (13/15) |
| `match_quality` top 1 identique | **100%** (15/15) |
| Chargement MiniSearch | 5680 ms |
| Chargement SQLite FTS (même pipeline) | 5580 ms |
| RSS après chargement (MiniSearch) | 406.05 Mo |
| RSS après chargement (SQLite FTS full) | 406.8 Mo |
| RSS après chargement (SQLite FTS lean) | 264.93 Mo |
| Écart RSS full Mini vs SQLite | 0.75 Mo |
| Économie RSS lean vs full SQLite | **-141.87 Mo** |
| Taille `data/bdpm.sqlite` | 40.55 Mo |

> **Profils :** `full` charge tout en RAM + tous les index MiniSearch. `sqlite_lean` (avec `DATA_LOAD_PROFILE=sqlite_lean`) exclut présentations/compositions de la RAM et les index MiniSearch des 3 grands datasets FTS.

## Consommation mémoire

Mesures par processus Node isolé (`--expose-gc` si disponible).

| Phase | MiniSearch RSS | SQLite FTS RSS | MiniSearch heap | SQLite FTS heap |
|-------|----------------|----------------|-------------------|-----------------|
| Avant chargement | 53.49 Mo | 53.71 Mo | 4.47 Mo | 4.47 Mo |
| Après `loadData()` (full) | 406.05 Mo | 406.8 Mo | 283.86 Mo | 283.87 Mo |
| Après `loadData()` (sqlite_lean) | — | 264.93 Mo | — | 142.65 Mo |
| Après campagne recherche (full) | 603.57 Mo | 638.36 Mo | 284.08 Mo | 284.21 Mo |
| Après campagne recherche (lean) | — | 359.5 Mo | — | 142.98 Mo |
| Delta RSS au chargement | 352.56 Mo | 353.09 Mo | — | — |

### Interprétation mémoire

En profil **full**, l'écart RSS après chargement MiniSearch vs SQLite FTS est de **0.75 Mo** (quasi identique) : les deux chargent les tableaux complets et les index MiniSearch.

En profil **sqlite_lean** (`DATA_LOAD_PROFILE=sqlite_lean` + `SEARCH_BACKEND=sqlite_fts`), l'économie au chargement est d'environ **141.87 Mo RSS** et **141.22 Mo heap** : présentations/compositions ne sont plus en RAM, ni les 3 index MiniSearch lourds.

La base SQLite sur disque (40.55 Mo) reste ouverte via connexion persistante ; les jointures CIS→présentations/compositions passent par SQL à la demande.

Le fuzzy SQLite est désormais borné aux candidats FTS/prefix (plus de scan intégral), ce qui réduit les pics RAM en recherche par rapport à la version précédente.

## Performance recherche (latence p50, 30 itérations après warmup)

| Catégorie | Type | Requête | p50 MiniSearch (ms) | p50 SQLite FTS (ms) | Ratio Mini/SQLite |
|-----------|------|---------|---------------------|---------------------|-------------------|
| nom_complet | specialites | `doliprane` | 1.6 | 84.1 | 0.019 |
| prefix | specialites | `doli` | 0.95 | 84.58 | 0.011 |
| fuzzy | specialites | `dolipranr` | 1 | 82.67 | 0.012 |
| cis_exact | specialites | `60234100` | 0.08 | 5.82 | 0.014 |
| sans_accent | specialites | `paracetamol` | 2.25 | 82.84 | 0.027 |
| avec_accent | specialites | `paracétamol` | 1.9 | 84.21 | 0.023 |
| titulaire | specialites | `pfizer` | 3.21 | 89.63 | 0.036 |
| forme_pharma | specialites | `comprimé` | 110.52 | 222.66 | 0.496 |
| libelle | presentations | `doliprane` | 0.24 | 113.75 | 0.002 |
| indications | presentations | `migraine` | 0.25 | 114.58 | 0.002 |
| substance | compositions | `paracetamol` | 1.9 | 108.55 | 0.018 |
| substance_2 | compositions | `tramadol` | 0.71 | 122.76 | 0.006 |
| code_atc | mitm | `N02BE01` | 0.97 | 1.5 | 0.647 |
| substances_index | substances | `paracetamol` | 0.26 | 0.25 | 1.04 |
| groupe | generiques | `amoxicilline` | 0.99 | 1.27 | 0.78 |

**Moyenne p50 globale :** MiniSearch 8.46 ms — SQLite FTS 79.94 ms

## Écarts de résultats (top 5 / volume / match_quality)

| Catégorie | Requête | Δ count | Top1 OK | Top5 OK | MQ top1 OK | Mini #1 | SQLite #1 |
|-----------|---------|---------|---------|---------|------------|---------|-----------|
| nom_complet | `doliprane` | 0 | oui | **non** | oui | DOLIPRANE 500 mg, gélule (prefix) | DOLIPRANE 500 mg, gélule (prefix) |
| prefix | `doli` | 0 | **non** | **non** | oui | DOLIPRANECAPS 1000 mg, gélule (prefix) | DOLIPRANE 500 mg, gélule (prefix) |
| fuzzy | `dolipranr` | 16 | oui | oui | oui | DOLIPRANE 500 mg, gélule (fuzzy) | DOLIPRANE 500 mg, gélule (fuzzy) |
| cis_exact | `60234100` | 16 | oui | **non** | oui | DOLIPRANE 1000 mg, comprimé (exact) | DOLIPRANE 1000 mg, comprimé (exact) |
| forme_pharma | `comprimé` | 0 | **non** | **non** | oui | ZONISAMIDE NEURAXPHARM 100 mg, comprimésécable (fuzzy) | FEMI, comprimé (fuzzy) |

## Recommandations

- Affiner le ranking FTS5 (poids BM25, fuzzy tokenisé, champs secondaires) avant toute bascule publique.
- Optimiser SQLite FTS : connexion persistante (éviter open/close par requête), cache prepared statements, LIMIT plus strict sur candidats fuzzy.
- Pour réduire la RAM, il faudra une phase 3 sans reconstruction MiniSearch (FTS + lookups SQL uniquement), pas seulement `SEARCH_BACKEND=sqlite_fts`.
- Conserver `SEARCH_BACKEND=compare` en préproduction pour détecter les dérives de ranking après chaque refresh BDPM.

## Artefacts

- `reports/audit_backend_comparison.json` — données brutes
- `reports/audit_backend_comparison.md` — ce rapport
