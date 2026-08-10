# MVP disponibilités — contrat BDPM

Hypothèse produit : source primaire = fichier BDPM `CIS_CIP_Dispo_Spec` (exposé par cette API). Les tools chat `get_ansm_*` sont remplacés par des wrappers fins sur les routes ci-dessous.

Voir aussi [AUDIT_PHASE2_DECISION.md](./AUDIT_PHASE2_DECISION.md) et [AUDIT_ANSM_EXPORT_VS_BDPM_DISPO.md](./AUDIT_ANSM_EXPORT_VS_BDPM_DISPO.md).

## Tools chat ↔ routes API

| Tool chat | Route API |
|-----------|-----------|
| `get_bdpm_disponibilite_alerts` | `GET /api/medicaments/disponibilite/alerts` |
| `get_bdpm_disponibilite_details` | `GET /api/medicaments/disponibilite/alerts/:alertId` |

`force_refresh` et le cache journalier restent **côté chat** (re-appel HTTP). L’API sert le corpus BDPM déjà en mémoire ; aucun flag d’env dédié.

## Champs alerte (liste)

| Champ | Source BDPM |
|-------|-------------|
| `id` | Hash court opaque SHA-1₁₂ de `cis:cip13:url_normalisée` |
| `medicine_name` | `denomination` de la spécialité (jointure CIS) |
| `status` | `libelle_statut` |
| `updated_at` | `date_mise_a_jour` normalisée `YYYY-MM-DD` si parseable |
| `expected_return` | `date_remise_dispo` normalisée `YYYY-MM-DD` si parseable |
| `detail_url` | `lien_ansm` |
| `cis`, `cip13`, `code_statut` | Champs bruts |

**Retiré du contrat** : `medical_domain` (absent BDPM).

Grain = **1 ligne BDPM** (CIS ± CIP). Une même `detail_url` ANSM peut regrouper plusieurs `id`.

Filtres exacts (`cis`, `cip13`, `code_statut`, `date_mise_a_jour_min`, `lien_ansm`) : si `lien_ansm` et `cis` sont fournis ensemble, la map URL est utilisée en premier, puis les autres critères filtrent. Un `lien_ansm` non normalisable → **HTTP 400**.

### Recherche texte `q` (liste alerts uniquement)

`GET /disponibilite/alerts?q=<nom|DCI|CIS|CIP13>` résout les CIS comme `/medicaments/search` (indexes specialites / presentations / compositions), puis projette les lignes ruptures via `rupturesByCis`. Combinable avec les filtres exacts (intersection). Au plus ~100 CIS résolus.

- Liste vide (`alerts: []`, `total: 0`) = aucune alerte BDPM pour la requête (médicament inconnu **ou** connu sans ligne de rupture) — **pas** de 404.
- Ne pas confondre avec `GET /disponibilite?q=` : sur l’endpoint brut, `q` cherche dans `libelle_statut` uniquement.
- Filtrer par statut : `code_statut=1|2|3|4`, jamais `q=rupture`.

## Détail

Réponse : `alert_id`, `cis`, `medicine_name`, `specialite`, `ruptures[]`, `detail_url`, `source: "bdpm"`.

Pas de reco pharmacien / ville / hôpital / contingentement (hors corpus). Le chat peut renvoyer `detail_url` et indiquer que le narratif ANSM n’est pas dans ce MVP.

## Écarts vs ancien MVP ANSM

- Plus de domaines médicaux
- Noms = dénominations CIS, pas titres familles ANSM
- `expected_return` = date structurée, pas texte libre
- Orphelins ANSM (sans ligne BDPM) non listés
