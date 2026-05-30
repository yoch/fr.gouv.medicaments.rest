# Classes corpus — propriétés

Référence pour revue : quoi est stocké en RAM, ce qui sort dans l’API (`toJSON()`), et ce qui est indexé pour la recherche.

**Source de vérité des champs** : [`src/utils/corpusSchemas.js`](../src/utils/corpusSchemas.js) (`BDPM_SCHEMAS`, `VET_SCHEMAS`). Les classes sont générées via [`defineCorpusRecord`](../src/models/defineCorpusRecord.js) — pas de liste de propriétés dupliquée dans le code.

**Recherche** : le classement lit `instance[champ]` (propriétés **stockées**). Les getters (`url_bdpm`, `lien_rcp`) ne servent qu’à `toJSON()` / API.

Légende :

- **stocké** : propriété `this.*` sur l’instance (toujours présente, `''` si vide sauf nombres/tableaux)
- **getter** : calculé à la sérialisation, pas en RAM
- **index** : champ utilisé par MiniSearch (supprimer = casser la recherche sur ce critère)
- **clé** : utilisé pour lier les enregistrements (`cis`, `num`, `id_groupe`, etc.)

Les champs viennent des fichiers BDPM (CSV) ou XML vet ; les retirer du corpus = les retirer aussi de l’API sauf refactor explicite.

---

## BDPM — `src/models/bdpm/records.js`

Corpus : `dataLoader.js` → `corpus.<type>[]`

### `Specialite` — `corpus.specialites`

| Propriété | Type | Notes |
|-----------|------|--------|
| `cis` | string | **clé**, **index** |
| `denomination` | string | **index** |
| `forme_pharma` | string | **index** |
| `voies_admin` | string | |
| `statut_amm` | string | |
| `type_amm` | string | |
| `commercialisation` | string | |
| `date_amm` | string | |
| `statut_bdm` | string | |
| `num_autorisation_euro` | string | |
| `titulaire` | string | **index** |
| `surveillance_renforcee` | string | |
| `url_bdpm` | getter | si `cis` non vide |

`fromCsv` : oui — fichier `CIS_bdpm.txt`

---

### `Presentation` — `corpus.presentations`

| Propriété | Type | Notes |
|-----------|------|--------|
| `cis` | string | **clé**, **index** |
| `cip7` | string | **index** |
| `libelle` | string | **index** |
| `statut_admin` | string | |
| `etat_commercialisation` | string | |
| `date_declaration` | string | |
| `cip13` | string | **index** |
| `agrement_collectivite` | string | |
| `taux_remboursement` | string | |
| `prix_medicament` | string | |
| `prix_public` | string | |
| `honoraires` | string | |
| `indications` | string | **index** |

`fromCsv` : oui — `CIS_CIP_bdpm.txt`

---

### `Composition` — `corpus.compositions`

| Propriété | Type | Notes |
|-----------|------|--------|
| `cis` | string | **clé**, **index** |
| `designation_element` | string | |
| `code_substance` | string | alimente `Substance` |
| `denomination_substance` | string | **index** |
| `dosage` | string | **index** |
| `reference_dosage` | string | |
| `nature_composant` | string | |
| `numero_ordre` | string | |

`fromCsv` : oui — `CIS_COMPO_bdpm.txt`

---

### `AvisSmr` — `corpus.avis_smr`

| Propriété | Type | Notes |
|-----------|------|--------|
| `cis` | string | **clé** |
| `has_dossier` | string | |
| `motif_evaluation` | string | |
| `date_avis` | string | |
| `valeur_smr` | string | **index** |
| `libelle_smr` | string | **index** |

`fromCsv` : oui — `CIS_HAS_SMR_bdpm.txt` (si `LOAD_HAS_AVIS`)

---

### `AvisAsmr` — `corpus.avis_asmr`

| Propriété | Type | Notes |
|-----------|------|--------|
| `cis` | string | **clé** |
| `has_dossier` | string | |
| `motif_evaluation` | string | |
| `date_avis` | string | |
| `valeur_asmr` | string | **index** |
| `libelle_asmr` | string | **index** |

`fromCsv` : oui — `CIS_HAS_ASMR_bdpm.txt` (si `LOAD_HAS_AVIS`)

---

### `Generique` — `corpus.generiques`

| Propriété | Type | Notes |
|-----------|------|--------|
| `id_groupe` | string | **clé** (groupe) |
| `libelle_groupe` | string | **index** |
| `cis` | string | **clé** |
| `type_generique` | string | |
| `numero_ordre` | string | |

`fromCsv` : oui — `CIS_GENER_bdpm.txt`

---

### `Condition` — `corpus.conditions`

| Propriété | Type | Notes |
|-----------|------|--------|
| `cis` | string | **clé** |
| `condition` | string | **index** |

`fromCsv` : oui — `CIS_CPD_bdpm.txt`

---

### `Rupture` — `corpus.ruptures`

| Propriété | Type | Notes |
|-----------|------|--------|
| `cis` | string | **clé** |
| `cip13` | string | |
| `code_statut` | string | |
| `libelle_statut` | string | **index** |
| `date_debut` | string | |
| `date_mise_a_jour` | string | |
| `date_remise_dispo` | string | |
| `lien_ansm` | string | |

`fromCsv` : oui — `CIS_CIP_Dispo_Spec.txt`

---

### `Mitm` — `corpus.mitm`

| Propriété | Type | Notes |
|-----------|------|--------|
| `cis` | string | **clé**, **index** |
| `code_atc` | string | **index** |
| `denomination` | string | **index** |
| `lien_fi` | string | |

`fromCsv` : oui — `CIS_MITM.txt`

---

### `Substance` — `corpus.substances`

| Propriété | Type | Notes |
|-----------|------|--------|
| `code` | string | |
| `denomination` | string | **index** |
| `medicaments_count` | number | dérivé des compositions, pas CSV direct |

Construit dans `loadData()` à partir des compositions ; `fromCsv` existe mais n’est pas utilisé au chargement.

---

## Vétérinaire — `src/models/vet/records.js`

Corpus : `vetDataLoader.js` → `corpus.medicaments | compositions | presentations`

### `MedicamentVet` — `corpus.medicaments`

| Propriété | Type | Notes |
|-----------|------|--------|
| `num` | string | **clé**, **index** |
| `nom` | string | **index** |
| `num_amm` | string | |
| `date_amm` | string | |
| `titulaire` | string | |
| `forme_pharmaceutique` | string | |
| `statut_amm` | string | |
| `codes_atcvet` | string[] | toujours `[]` si vide |
| `especes` | string[] | toujours `[]` si vide |
| `maj_rcp` | string | |
| `lien_rcp` | getter | si `maj_rcp` non vide |

Construit au parse XML (pas `fromCsv`).

---

### `CompositionVet` — `corpus.compositions`

| Propriété | Type | Notes |
|-----------|------|--------|
| `num` | string | **clé**, **index** |
| `substance` | string | **index** |
| `quantite` | string | |
| `unite` | string | |

---

### `PresentationVet` — `corpus.presentations`

| Propriété | Type | Notes |
|-----------|------|--------|
| `num` | string | **clé** |
| `libelle` | string | filtre liste `/presentations` (pas index MiniSearch dédié) |
| `gtin` | string | filtre liste |
| `conditions_delivrance` | string[] | toujours `[]` si vide |

Pas d’index frozen sur les présentations vet.

---

## Temps d’attente — `src/models/tempsAttente.js`

### `TempsAttenteEntry` — pas dans un tableau corpus

Stocké dans `Map<num, TempsAttenteEntry[]>` (`tempsAttente`).

| Propriété | Type | Notes |
|-----------|------|--------|
| `voie` | string | |
| `espece` | string | |
| `denree` | string | |
| `quantite` | string | |
| `unite` | string | |

Exposé via `getRelatedByNum('temps_attente', num)`.

---

## Hors corpus (pour la revue)

| Élément | Rôle |
|---------|------|
| `match_quality` | ajouté sur les réponses **recherche** seulement (objet plain) |
| Documents MiniSearch `{ id, …champs index… }` | éphémères, pas des classes |
| `metadata` | singleton date / source |

---

## Pistes si tu veux supprimer des propriétés

1. **Colonne BDPM inutilisée côté clients** : retirer du constructeur + `toJSON` + `BDPM_SCHEMAS` + colonnes `csv-parse` — sinon la donnée est encore lue du disque.
2. **Champ jamais indexé ni renvoyé** : candidat à la suppression (vérifier routes, tests API, agents LLM).
3. **Getter seulement** (`url_bdpm`, `lien_rcp`) : rien à gagner en RAM en les « supprimant » — ils ne sont pas stockés.
4. **Fusionner des classes** (ex. `AvisSmr` / `AvisAsmr`) : possible en code, peu d’intérêt mémoire (mêmes chaînes).
5. **Tout un type** (`mitm`, `ruptures`, avis HAS) : possible si l’endpoint et le chargement sont retirés ensemble.
