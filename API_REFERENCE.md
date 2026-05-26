# API Base de Données Publique des Médicaments - Référence

Cette API permet d'accéder aux données officielles des médicaments en France (BDPM).


## Endpoints

### Médicaments (Spécialités)

#### `GET /medicaments/specialites`
Liste les spécialités pharmaceutiques.
- **Paramètres**:
  - `q` (string): Terme de recherche (préfixe + fuzzy sur le texte). Ex: `doliprane`
  - `page` (int): Numéro de page (défaut: 1)
  - `limit` (int): Nombre d'éléments par page (défaut: 100)
- **Réponse**: Liste d'objets `Medicament` (avec `match_quality` si `q` est fourni, et `url_bdpm` vers la fiche officielle).

#### `GET /medicaments/specialites/:cis`
Détail complet d'une spécialité.
- **Paramètres**:
  - `cis` (string): Code Identifiant de Spécialité (ex: `60234100`)
- **Réponse**: Objet `Medicament` enrichi avec `presentations`, `compositions`, `avis_smr`, etc.

### Informations Pharmaceutiques

#### `GET /medicaments/substances`
Liste les substances actives indexées. utile pour la recherche par molécule.
- **Paramètres**:
  - `q` (string): Recherche par nom de substance. Ex: `paracetamol`
- **Réponse**: Liste d'objets `Substance`.

<!--
#### `GET /medicaments/infos-importantes` (désactivé dans le code)
Informations de sécurité importantes (alertes, messages ANSM).
- **Paramètres**:
  - `q` (string): Recherche dans le texte de l'alerte.
- **Réponse**: Liste d'objets `InfoImportante`.
-->

### Autres Endpoints

- `GET /medicaments/presentations`: Liste des conditionnements.
- `GET /medicaments/compositions`: Liste des compositions (substances).
- `GET /medicaments/avis-smr`: Avis du Service Médical Rendu.
- `GET /medicaments/avis-asmr`: Avis d'Amélioration du SMR.
- `GET /medicaments/groupes-generiques`: Groupes génériques.
- `GET /medicaments/conditions`: Conditions de prescription/délivrance.
- `GET /medicaments/disponibilite`: Ruptures de stock et disponibilités.
- `GET /medicaments/interet-therapeutique-majeur`: Liste des MITM.

#### Paramètres Communs aux "Autres Endpoints"
Tous ces endpoints acceptent les paramètres standards :
- `q`: Recherche texte (filtre)
- `page` & `limit`: Pagination
- `pretty`: Formatage JSON

#### Structure des objets (Schémas)
- **Medicament**: inclut `url_bdpm` — lien vers `https://base-donnees-publique.medicaments.gouv.fr/medicament/{cis}/extrait` (RCP, notice, fiche info).
- **AvisSMR**: `valeur_smr`, `libelle_smr`, `motif_evaluation`, `date_avis`.
- **AvisASMR**: `valeur_asmr`, `libelle_asmr`, `motif_evaluation`, `date_avis`.
- **Disponibilite**: `libelle_statut` (ex: Rupture de stock), `date_debut`, `date_remise_dispo`, `lien_ansm`.
- **MITM**: `code_atc`, `denomination`, `lien_fi` (Lien Fiche Info).

#### `GET /medicaments/search`
Recherche globale multi-critères (spécialités, présentations, compositions agrégées par CIS). Peut interroger la BDPM seule, l'ANMV seule, ou les deux selon `source`.
- **Paramètres**:
  - `q` (string, requis): Terme de recherche.
  - `page`, `limit` (défaut `limit=50`).
  - `source` (string, optionnel): `auto` (défaut), `human`, `veterinary`, `mixed`.
    - `auto` : BDPM d'abord ; si aucun résultat, fallback ANMV.
    - `human` : BDPM uniquement (comportement historique).
    - `veterinary` : médicaments vétérinaires ANMV uniquement.
    - `mixed` : fusion des deux référentiels.
  - `format` (optionnel): `json` (défaut) ou `markdown`. En `markdown`, le corps est du texte `text/markdown` (pas de JSON) ; la pagination n’apparaît que dans l’en-tête du document.
  - `detail` (optionnel): `full` (défaut) ou `summary`. Voir ci-dessous.
- **Réponse BDPM** (`detail=full`): Objets `medicament` agrégés par `cis`, avec `presentations` et `compositions` (jusqu’à `SEARCH_HYDRATE_RELATED_LIMIT` entrées par tableau, défaut 50).
- **Réponse ANMV**: Objets `medicament_veterinaire` agrégés par `num`, avec `presentations` et `compositions`.
- **Métadonnées** (`search` à la racine, JSON uniquement) : `query`. Si `source` est fourni ou si le fallback ANMV est utilisé : `source` et `referentiels` (`queried`, `with_results`).

##### `detail=summary` (réponse allégée)
Remplace `compositions[]` par `substances[]` (dénomination, dosage, nature). Chaque présentation ne conserve que `libelle`, `cip13`, `taux_remboursement`, `etat_commercialisation`, `prix_public` (champs non vides). Maximum **3** présentations par fiche + `presentations_count` si troncature. Champs spécialité retirés : `statut_amm`, `type_amm`, `date_amm`, `statut_bdm`, `num_autorisation_euro`.

Chaque fiche inclut `match_via` (`denomination`, `presentation`, `composition`, `cis` / `num`) pour indiquer l'origine du match.

En `format=markdown`, les substances sont listées séparées par des virgules ; les présentations sont des sous-puces indentées.

##### Usage agent LLM (recommandé)
```
GET /api/medicaments/search?q={query}&limit=10&format=markdown&detail=summary&source=auto
```
Pour prescription, avis HAS, ruptures ou génériques : noter le `cis` / `num` et appeler `GET /medicaments/specialites/:cis` ou `GET /veterinaires/medicaments/:num`.

### Médicaments vétérinaires (ANMV)

Namespace dédié : **`/api/veterinaires`**

- `GET /veterinaires/medicaments` — liste / recherche par nom (`q`)
- `GET /veterinaires/medicaments/:num` — détail (compositions, présentations, temps d'attente)
- `GET /veterinaires/compositions` — recherche par substance active (`q`)
- `GET /veterinaires/presentations` — liste filtrable (libellé, GTIN)

Clé primaire : `num` (7 chiffres). Source : [base ANMV sur data.gouv.fr](https://www.data.gouv.fr/datasets/base-de-donnees-publique-des-medicaments-veterinaires-autorises-en-france-1).

#### Qualité de correspondance (`match_quality`)
Présent sur toute réponse filtrée par `q` :
- `exact` : le libellé principal correspond exactement à la requête (après normalisation des accents).
- `prefix` : le libellé principal commence par la requête.
- `fuzzy` : correspondance approximative (tolérance ~20 % via MiniSearch).

**Limites connues** : le fuzzy est désactivé uniquement pour les termes de requête purement numériques. Les codes alphanumériques (ex. `code_atc` type `N02BE01`) peuvent encore produire des correspondances fuzzy. La qualité indiquée (`match_quality`) reflète le libellé principal du type de données, pas le champ exact qui a déclenché le match.

## Format de Réponse

```json
{
  "data": [ ... ],
  "pagination": {
    "total": 100,
    "page": 1,
    "limit": 100,
    "pages": 1
  },
  "metadata": {
    "last_updated": "2024-01-01T00:00:00.000Z",
    "source": "base de données publique des médicaments - gouv.fr"
  }
}
```
