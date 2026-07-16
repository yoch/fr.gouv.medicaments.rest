# Audit — export ANSM vs BDPM disponibilité

Rapport généré le 2026-07-16T11:11:35.326Z. Les artefacts binaires et TSV sont régénérables sous `tmp/audit/` (gitignored). Stats JSON : `tmp/audit/ansm-bdpm-dispo-stats.json`.

## Sources collectées

| Source | URL | Format observé | Taille | Remarque |
| --- | --- | --- | --- | --- |
| Export ANSM | https://ansm.sante.fr/disponibilites-des-produits-de-sante/medicaments/export | application/vnd.ms-excel | 186368 octets | Feuille: Worksheet |
| BDPM disponibilités | https://base-donnees-publique.medicaments.gouv.fr/download/file/CIS_CIP_Dispo_Spec.txt | TSV (windows-1252) | 136772 octets | 8 colonnes attendues |
| BDPM spécialités (jointure CIS) | https://base-donnees-publique.medicaments.gouv.fr/download/file/CIS_bdpm.txt | TSV | 3165296 octets | Utilisé uniquement pour rapprocher les dénominations |

Content-Disposition ANSM : `attachment;filename="export_disponibilites-des-medicaments_16-07-2026_13-11-34.xls"`.

## Résultat synthétique

| Mesure | Export ANSM | BDPM | Interprétation |
| --- | --- | --- | --- |
| Lignes | 276 | 625 | Grains potentiellement différents |
| Dernière date de mise à jour | 2026-07-15 | 2026-07-15 | Comparer avec la date de collecte, pas seulement entre elles |
| URLs de détail uniques | 276 | 262 | Clé de jointure prioritaire |
| URLs jointes exactement | 261 | 261/276 côté ANSM (94.6 %) | Jointure par URL normalisée |
| Lignes ANSM sans lien exporté | 0 | — | À vérifier : l’export peut ne pas préserver les hyperliens |
| Lignes avec domaines médicaux | 276 | 0 (champ absent) | Bloquant pour MVP si on n’utilise que BDPM |
| Lignes avec remise renseignée | 91 | 119 | Présence du champ, formats potentiellement différents |
| CIP13 renseignés | — | 36 | Exclusif BDPM |
| Lignes BDPM sans dénomination locale | — | 12 | CIS non trouvé dans le fichier spécialités frais |
| Doublons exacts BDPM | — | 10 | 5 groupe(s) |
| Statuts identiques parmi les URLs jointes | 256 | 5 | Même libellé exact vs au moins une divergence |

### Répartition des statuts

| Statut | ANSM | BDPM |
| --- | --- | --- |
| Arrêt de commercialisation | 15 | 15 |
| Remise à disposition | 90 | 116 |
| REmise à disposition | 0 | 3 |
| Rupture de stock | 47 | 64 |
| Tension d'approvisionnement | 124 | 427 |

## Schémas et complétude

| Champ utile au MVP | Export ANSM | BDPM disponibilités | Conclusion |
| --- | --- | --- | --- |
| Statut | Oui | Oui (`code_statut` + `libelle_statut`) | Comparable |
| Mise à jour | Oui (YYYY-MM-DD dans l’export) | Oui (JJ/MM/AAAA) | Formats hétérogènes entre sources |
| Titre / spécialité affichée | Oui (`Titre`) | Indirect via CIS → fichier spécialités | Pas le même grain / libellé |
| Date de création | Oui | Non | Exclusif ANSM export |
| Date de début de situation | Oui | Oui (`date_debut`, sémantique BDPM impure pré-06/10/2023) | Comparable avec prudence |
| Remise à disposition | Oui | Oui (`date_remise_dispo`) | ANSM export en YYYY-MM-DD ; BDPM en DD/MM/YYYY |
| Domaines médicaux | Oui | Non | Champ exclusif ANSM |
| URL de la page | Oui (colonne dédiée) | Oui (`lien_ansm`) | Clé de jointure prioritaire |
| CIS | Non | Oui | Champ exclusif BDPM |
| CIP13 | Non | Oui, optionnel | Champ exclusif BDPM |

## Qualité et jointure

| Mesure | Valeur |
| --- | --- |
| URLs ANSM sans équivalent BDPM | 15 |
| Lignes BDPM sans URL ANSM équivalente | 9 |
| Correspondances exactes de dénomination normalisée (fallback) | 174 |
| Cardinalité URL BDPM min / médiane / max | 1 / 1 / 45 |
| Lignes BDPM au nombre de colonnes inattendu | 0 |
| Codes statut BDPM hors 1–4 | 0 |

## Go / no-go Temps 2 (disponibilité)

| Décision | Statut | Justification |
| --- | --- | --- |
| Source primaire MVP `get_ansm_medication_alerts` | **GO — export ANSM** | Domaines médicaux présents (276/276), export téléchargeable |
| Implémenter les tools MVP dans ce dépôt API | **NO-GO** | Hors périmètre : cache journalier + collecte ANSM = service consommateur |
| Rôle BDPM `/disponibilite` | **GO — enrichissement** | CIS/CIP13/lien ; filtres exacts utiles pour poller / jointure |
| Réactivation infos importantes BDPM | **NO-GO MVP** | Hors contrat disponibilité ; évolution séparée |
| Fusion silencieuse ANSM ⊕ BDPM | **NO-GO** | 1 URL BDPM → jusqu’à 45 CIS ; grains incompatibles |

## Décision recommandée pour le MVP disponibilité

**L’export ANSM est la source primaire du MVP disponibilité.** Le fichier BDPM est complémentaire (CIS, CIP13, lien structuré). Ne pas fusionner silencieusement : une même URL peut concerner plusieurs CIS.

## Limites de cet audit

- Un export est une photo à un instant donné ; il ne mesure pas le délai de publication sans série temporelle.
- L’appariement de secours par dénomination est volontairement strict ; les appellations ANSM de familles peuvent couvrir plusieurs spécialités BDPM.
- Les détails cliniques (contingentement, alternatives, recommandations) ne sont pas évalués ici : ils nécessitent un audit distinct des fiches ANSM.
