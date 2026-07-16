# Décision Temps 2 — suite aux audits sources

Date de décision initiale : 2026-07-16 (après `npm run audit:ansm-dispo` et `npm run audit:ema-monitoring`).

**Mise à jour produit** : le MVP disponibilités est **recentré sur BDPM** (fichier `CIS_CIP_Dispo_Spec`). L’export ANSM n’est plus la source primaire des tools ; domaines médicaux et scrape fiche hors contrat. Voir [MVP_BDPM_DISPONIBILITE.md](./MVP_BDPM_DISPONIBILITE.md).

Rapports d’audit (constats inchangés) :

- [AUDIT_ANSM_EXPORT_VS_BDPM_DISPO.md](./AUDIT_ANSM_EXPORT_VS_BDPM_DISPO.md)
- [AUDIT_EMA_ADDITIONAL_MONITORING_VS_BDPM.md](./AUDIT_EMA_ADDITIONAL_MONITORING_VS_BDPM.md)

## Décisions

| Sujet | Décision | Action dans ce dépôt |
|-------|----------|----------------------|
| Source primaire MVP | **BDPM** `CIS_CIP_Dispo_Spec` | Routes `/disponibilite` + `/disponibilite/alerts` |
| Tools chat | `get_bdpm_disponibilite_alerts` / `_details` | Wrappers HTTP sur les routes ci-dessus (runtime chat hors dépôt) |
| Export ANSM | Hors contrat MVP BDPM | Pas d’ingestion ; `lien_ansm` reste clé de jointure optionnelle |
| Infos importantes BDPM | **NO-GO MVP** | Pas de réactivation `LOAD_INFOS` |
| Liste EMA additional monitoring | **NO-GO ingestion** | Conserver `surveillance_renforcee` tel quel |
| Fusion ANSM ⊕ BDPM | **NO-GO** | Pas de domaines / titres ANSM injectés dans le corpus |

## Constats clés (collecte audit)

- Export ANSM : schéma riche (`Titre`, dates ISO, `Domaine(s) médical(aux)`, `URL de la page`) — distinct du tableau HTML.
- Jointure URL ANSM ↔ BDPM ≈ **95 %**.
- Domaines médicaux : **uniquement** côté ANSM → volontairement absents du MVP BDPM.
- EMA : pharmacovigilance ≠ stock — hors MVP disponibilité.

## Livré (API)

- Filtres `/disponibilite` : `cis`, `cip13`, `code_statut`, `date_mise_a_jour_min`, `lien_ansm`
- Index `rupturesByCis` / `rupturesByLienAnsm`
- `GET /disponibilite/alerts` et `GET /disponibilite/alerts/:alertId`
- Champ `ruptures` sur `GET /specialites/:cis`
- Aucun changement de variables d’environnement en prod
