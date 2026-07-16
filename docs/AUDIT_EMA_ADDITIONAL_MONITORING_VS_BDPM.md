# Audit — EMA additional monitoring vs BDPM surveillance renforcée

Rapport généré le 2026-07-16T11:11:24.387Z. L’artefact EMA XLSX est régénérable dans `tmp/audit/` (gitignored). Stats JSON : `tmp/audit/ema-bdpm-monitoring-stats.json`.

## Décision de périmètre

Cette comparaison porte sur la **pharmacovigilance** (médicaments sous surveillance additionnelle, triangle noir) et non sur les ruptures ou tensions d’approvisionnement. Elle ne doit pas alimenter `get_ansm_medication_alerts`.

La source EMA est la [liste officielle des médicaments sous surveillance additionnelle](https://www.ema.europa.eu/en/human-regulatory-overview/post-authorisation/pharmacovigilance-post-authorisation/medicines-under-additional-monitoring/list-medicines-under-additional-monitoring). Elle est revue mensuellement par le PRAC ; la BDPM expose déjà un indicateur français `surveillance_renforcee` au niveau CIS.

## Sources collectées

| Source | URL | Format | Taille |
| --- | --- | --- | --- |
| EMA | https://www.ema.europa.eu/en/documents/additional-monitoring/list-medicinal-products-under-additional-monitoring_en.xlsx | application/vnd.openxmlformats-officedocument.spreadsheetml.sheet | 167785 octets |
| BDPM spécialités | https://base-donnees-publique.medicaments.gouv.fr/download/file/CIS_bdpm.txt | TSV (windows-1252) | 3165296 octets |

## Schéma EMA observé

Feuille : `Additional monitoring list`.

Colonnes : `Product name`, `Active substance (s)`, `Reason (s) on list`, `Marketing authorisation holder (s)`, `Link to product information`, `Date of inclusion`.

| Mesure | Valeur |
| --- | --- |
| Produits EMA | 419 |
| Spécialités BDPM | 15848 |
| CIS BDPM avec `surveillance_renforcee=oui` | 499 |
| Correspondances exactes nom EMA ↔ dénomination BDPM parmi ces CIS | 0 (0 %) |
| Correspondances lâches (sous-chaîne / 1er token) | 434 (87 %) |
| Exemples de motifs EMA | New biological, new active substance, PASS¹; New active substance and new biological; New biological; New biological, new active substance and Conditional marketing authorisation; PASS¹; New biological, new active substance, authorized under exceptional circumstances; New active substance; New active substance, new biological; New active substance, new biological and Conditional Marketing Authorisation; Authorised under exceptional circumstances |

## Go / no-go Temps 2 (surveillance)

| Décision | Statut | Justification |
| --- | --- | --- |
| Utiliser EMA pour le MVP disponibilité | **NO-GO** | Domaine pharmacovigilance ≠ stock |
| Ingestion EMA dans cette API | **NO-GO** (sauf besoin produit explicite) | Jointure exacte faible (0 % des CIS « oui ») ; motifs EMA utiles seulement si demandés |
| Conserver `surveillance_renforcee` BDPM | **GO — garder tel quel** | Signal simple déjà exposé sur `/specialites` |

## Limites de jointure

- L’EMA publie des **produits autorisés dans l’UE**, alors que la BDPM utilise des spécialités françaises identifiées par CIS.
- Le nom EMA peut couvrir un produit centralisé, une présentation ou une marque différente de la dénomination BDPM ; une correspondance exacte n’est donc qu’un indicateur conservateur.
- L’EMA n’est pas une source d’état de stock, de disponibilité, de recommandations de dispensation ou de rupture.

## Recommandation

Conserver le champ BDPM `surveillance_renforcee` comme signal simple déjà disponible. N’ajouter une ingestion EMA que si un besoin produit explicite exige ses **motifs détaillés** ou une actualisation mensuelle indépendante ; dans ce cas, concevoir une ressource distincte et ne pas modifier les tools de disponibilité.
