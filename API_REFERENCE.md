# API Base de Données Publique des Médicaments - Référence

Cette API permet d'accéder aux données officielles des médicaments en France (BDPM).

**Base URL**: `http://localhost:3000/api`

## Endpoints

### Médicaments (Spécialités)

#### `GET /medicaments/specialites`
Liste les spécialités pharmaceutiques.
- **Paramètres**:
  - `q` (string): Terme de recherche (supporte `*` et `?`). Ex: `doliprane*`
  - `page` (int): Numéro de page (défaut: 1)
  - `limit` (int): Nombre d'éléments par page (défaut: 100)
- **Réponse**: Liste d'objets `Medicament`.

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

#### `GET /medicaments/infos-importantes`
Informations de sécurité importantes (alertes, messages ANSM).
- **Paramètres**:
  - `q` (string): Recherche dans le texte de l'alerte.
- **Réponse**: Liste d'objets `InfoImportante`.

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
- **AvisSMR**: `valeur_smr`, `libelle_smr`, `motif_evaluation`, `date_avis`.
- **AvisASMR**: `valeur_asmr`, `libelle_asmr`, `motif_evaluation`, `date_avis`.
- **Disponibilite**: `libelle_statut` (ex: Rupture de stock), `date_debut`, `date_remise_dispo`, `lien_ansm`.
- **MITM**: `code_atc`, `denomination`, `lien_fi` (Lien Fiche Info).

#### `GET /medicaments/search`
Recherche globale multi-critères.
- **Paramètres**:
  - `q` (string, requis): Terme de recherche.
- **Réponse**: Liste mixte d'objets typés (`specialite`, `presentation`, `composition`).

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
