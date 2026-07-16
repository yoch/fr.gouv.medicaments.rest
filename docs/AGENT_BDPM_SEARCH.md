# Outil bdpm_search — guide d'utilisation

Tu disposes d'un accès à la Base de Données Publique des Médicaments (BDPM)
et, en fallback, à l'ANMV (médicaments vétérinaires).

## Quand appeler l'outil

- Identifier un médicament par nom commercial, DCI, CIS ou CIP13
- Vérifier l'existence d'une spécialité en France
- Obtenir forme, voie, titulaire, présentations, substances, lien RCP
- Distinguer des variantes (dosage, forme galénique) **dans** un même nom

## Quand NE PAS appeler

- Parapharmacie, compléments alimentaires, dispositifs médicaux (pansements, aiguilles)
- Recherche par indication (« crème démangeaison », « pilule du lendemain »)
- Préparations magistrales nommées par recette (« préparation glycérole »)

→ Interpréter 0 résultat comme « hors périmètre BDPM », pas comme absence du produit.

---

## Comment formuler `q`

**RÈGLE D'OR** : un médicament par appel, **dénomination seule** dans `q`.

✅ Correct :

- `Doliprane`
- `Esomeprazole`
- `Ozempic`
- `60234100` (CIS, 8 chiffres)
- `3400935955838` (CIP13, 13 chiffres)

❌ Incorrect dans `q` (échoue souvent à cause de la logique AND du moteur) :

- `Doliprane 1 gramme`
- `Esomeprazole 40mg`
- `Hexamidine collyre`
- `méthotrexate per os`
- `Cerulyse spray`

Ne mets **jamais** dans `q` : dosage, forme galénique, voie d'administration, qualificatif (« enfant », « spray »…).

---

## Paramètres structurés optionnels (`dosage`, `forme`, `voie`)

Depuis la v1.4.0, ces champs complètent `q` — ils ne le remplacent pas.

| Paramètre | Exemples | Comparé à |
|-----------|----------|-----------|
| `dosage` | `1 g`, `500 mg`, `40 mg/ml`, `1 gramme` | dosage dans la **dénomination** (`1 gramme` ↔ `1000 mg`) |
| `forme` | `comprimé`, `suppositoire`, `solution injectable` | `forme_pharma` |
| `voie` | `orale`, `cutanée`, `inhalée` | `voies_admin` |

**Comportement important** :

- **Non destructifs** : ils ne filtrent jamais. Le `total` reste identique ; ils ne font que **réordonner**.
- **Anti-bruit** : un match faible (`fuzzy`) ne remonte jamais au-dessus d'un match fort (`prefix` / `exact`), même si le critère matche parfaitement.
- Si aucun résultat ne satisfait un critère, la liste complète est quand même renvoyée.

✅ Bon usage :

```
q=Doliprane&dosage=1 g&forme=comprimé
q=paracetamol&forme=suppositoire
q=ventoline&voie=inhalée
q=amoxicilline&dosage=500 mg&forme=comprimé
```

❌ À éviter :

- `q=Doliprane 1000 mg comprimé` → séparer en `q` + critères
- s'attendre à 0 résultat si la combinaison exacte n'existe pas (ex. amoxicilline 500 mg comprimé inexistante : des gélules 500 mg et des comprimés 1 g peuvent remonter, mal classés)

Chaque fiche peut renvoyer `criteria_match` : `{ dosage: bool, forme: bool, voie: bool }`.
Utilise-le pour choisir la bonne variante sans relancer une recherche.

---

## Paramètres recommandés

```
source=auto
format=markdown
detail=summary
limit=10
```

Exemple complet :

```
GET /api/medicaments/search?q=Doliprane&dosage=1%20g&forme=comprim%C3%A9&limit=10&format=markdown&detail=summary&source=auto
```

### `source`

| Valeur | Usage |
|--------|-------|
| `auto` (défaut) | BDPM humain d'abord ; fallback ANMV si BDPM sans match fort |
| `human` | BDPM uniquement |
| `veterinary` | ANMV uniquement |
| `mixed` | fusion des deux référentiels |

Comportement `auto` (à connaître) :

1. Interroge la BDPM.
2. Si match **fort** BDPM (`exact` ou `prefix`) → retourne la BDPM, sans interroger l'ANMV.
3. Sinon interroge l'ANMV.
4. Si l'ANMV a des résultats → retourne l'ANMV.
5. Si l'ANMV est vide → **conserve** les résultats BDPM, y compris `fuzzy` (ex. typo `dolipranr`).

---

## Stratégie en cas de 0 résultat

1. **Simplifier `q`** : retirer tout ce qui n'est pas le nom (`Ozempic 0,25mg` → `Ozempic`).
2. **Déplacer dosage/forme/voie** vers les paramètres structurés, pas dans `q`.
3. **Corriger l'orthographe** (`kaydeco` → `kalydeco`, `jectofer` → `jextofer`).
4. **Essayer la DCI** si la marque échoue (`Doliprane` → `paracetamol`).
5. **Séparer les mots collés** (`antibiosynalar` → `Antibio Synalar`).
6. Si toujours 0 : conclure hors périmètre ou absence en France — ne pas insister.

---

## Multi-médicaments

Si la question porte sur A + B, faire **deux appels séparés**.
Ne pas chercher le médicament B quand tu analyses A.

---

## Interpréter les résultats

### `match_quality` (pertinence de `q`)

| Valeur | Fiabilité |
|--------|-----------|
| `exact` | très fiable (nom, CIS, CIP13 exact) |
| `prefix` | fiable (début de dénomination) |
| `fuzzy` | à vérifier (typo, approximation) |

Les critères structurés ne changent **pas** ce niveau ; ils réordonnent seulement à l'intérieur du même palier.

### `match_via` (origine du match)

| Valeur | Signification |
|--------|---------------|
| `denomination` | trouvé par nom de spécialité |
| `presentation` | trouvé par libellé ou code CIP/CIS de présentation |
| `composition` | trouvé par substance active (DCI), pas par marque |
| `cis` / `num` | trouvé par identifiant numérique exact |

### `criteria_match` (si critères passés)

- `dosage: true` → le dosage demandé est présent dans la dénomination.
- `forme: true` → la forme demandée correspond à `forme_pharma`.
- `voie: true` → la voie demandée correspond à `voies_admin`.

En `format=markdown`, les critères satisfaits apparaissent sous la forme `- Critères: dosage, forme ✓`.

### Autres points

- Présentations tronquées (3 max en `summary`) : noter `presentations_count`.
- `search.criteria` (JSON) reprend les critères actifs de l'appel.

---

## Codes

| Code | Rôle |
|------|------|
| **CIS** (8 chiffres) | identifiant de spécialité |
| **CIP13** (13 chiffres, souvent `34009…`) | identifiant de présentation / boîte |
| **EAN** hors médicament (aiguilles, DM) | absent de la BDPM — normal |

Les codes numériques (CIS, CIP13) donnent un `match_quality: exact` — pas de fuzzy ni de prefix partiel.

---

## Après la recherche

Pour posologie, interactions, contre-indications : utiliser le lien fiche (`url_bdpm`)
ou appeler le détail par CIS (`GET /medicaments/specialites/:cis`) — ne pas inventer à partir du seul résumé.

Pour un médicament vétérinaire identifié : `GET /veterinaires/medicaments/:num`.

---

## Disponibilités / ruptures (MVP BDPM)

Source : fichier BDPM `CIS_CIP_Dispo_Spec`, **pas** l’export ANSM. Pas de domaines médicaux.

| Besoin | Appel |
|--------|-------|
| Liste d’alertes récentes | `GET /medicaments/disponibilite/alerts?limit=30` |
| Filtrer par statut | `code_statut=1` (rupture), `2` (tension), `3` (arrêt), `4` (remise) |
| Jointure URL fiche ANSM | `lien_ansm=` (URL normalisée) sur `/disponibilite` ou `/disponibilite/alerts` |
| Détail d’une alerte | `GET /medicaments/disponibilite/alerts/{id}` (id renvoyé par la liste) |
| Ruptures d’un CIS | champ `ruptures` sur `GET /medicaments/specialites/:cis` |

Dates brutes BDPM : `JJ/MM/AAAA`. Sur `/disponibilite/alerts`, `updated_at` / `expected_return` sont en `YYYY-MM-DD` si parseables.

Ne pas inventer de recommandations pharmacien / ville / hôpital : hors corpus. Tu peux citer `detail_url` (lien ANSM) sans scraper.

---

## Anti-patterns récapitulatifs

| ❌ Ne fais pas | ✅ Fais plutôt |
|---------------|----------------|
| `q=Doliprane 1000 mg` | `q=Doliprane&dosage=1 g` |
| `q=Esomeprazole comprimé` | `q=Esomeprazole&forme=comprimé` |
| Conclure « absent » sur 0 résultat sans simplifier `q` | Simplifier, corriger typo, essayer DCI |
| Ignorer `match_quality: fuzzy` | Vérifier la dénomination avant de conclure |
| Inventer posologie / CI depuis le summary | Lire la fiche détaillée ou le RCP |
| Un seul appel pour A + B | Deux appels séparés |
