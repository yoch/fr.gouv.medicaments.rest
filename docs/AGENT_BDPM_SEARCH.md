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

Le dosage compare les quantités écrites, sans calcul de concentration. Plus il y a de
quantités demandées retrouvées dans la dénomination, plus le produit remonte ; à égalité,
celui qui n'a pas d'autre quantité passe devant. `criteria_match.dosage` vaut `true`
seulement si toutes les quantités demandées sont retrouvées.

- Recopie le dosage tel qu'il est écrit : `250 mg/5 ml`, `500 mg/62,5 mg`, `100 000 UI`.
- Une quantité seule trouve aussi les formes qui la contiennent : `250 mg` remonte
  la suspension `250 mg/5 ml`.
- `40 mg/ml` est une concentration : elle ne correspond ni à `40 mg`, ni à `40 mg/5 ml`,
  et `200 mg/5 ml` n'est pas converti en `40 mg/ml`.
- Les unités sont converties (`1 g` = `1000 mg`, `25 µg` = `25 microgrammes`) ;
  `UI`, `unités`, `%` et `POUR CENT` sont reconnus.

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

## Modes d'exécution (`mode=legacy|structured|concepts`)

Le moteur lexical de production repose dans tous les modes sur `@yoch/frozenminisearch` (`specialites`, `presentations`, `compositions` côté BDPM et index `medicaments`, `compositions` côté ANMV ; les index `generiques` et `mitm` servent leurs routes dédiées). Aucun index vectoriel (`FXV1`) ni modèle externe n'est activé.

| Mode | Rôle | Comportement |
|------|------|--------------|
| `legacy` (défaut) | `B0` historique | Recherche lexicale directe sur `q`, scoring optionnel non destructif via `dosage`, `forme`, `voie`. |
| `structured` (opt-in) | `B1` structuré | Détache automatiquement dosage/forme/voie présents dans `q`, applique la précédence stricte des paramètres explicites (`search.parsed.conflicts`), renseigne `criteria_status` et active les garde-fous d'abstention (`search.abstained`). |
| `concepts` (opt-in) | `B2` concepts | Ajoute à `structured` la résolution par concepts : substances actives (`SA`/`FT`), groupes génériques, synonymes galéniques/voies (`per os` → `orale`, `collyre` → `ophtalmique`), routage d'espèces vétérinaires (`chien`, `chat`…) et conversions dimensionnelles vérifiées. |

> **Note sur `SEARCH_WARMUP_MODE`** : la variable d'environnement `SEARCH_WARMUP_MODE=legacy|structured|concepts` (défaut `legacy`) règle uniquement le **préchauffage** des structures en mémoire au démarrage et lors des rechargements du corpus (`loadData()` / `loadVetData()`). Ce n'est **pas** un coupe-circuit fonctionnel B2 : `mode=legacy|structured|concepts` reste sélectionnable par requête HTTP (`?mode=...`, défaut `legacy`) et, si un mode non préchauffé est appelé, ses structures (`TaxonomyVocab` / `ConceptStore`) sont initialisées à la demande et conservées en mémoire.

### Déploiement pilote, rollback et observabilité

- **Activation pilote isolée** : déployer le candidat sur une instance/préproduction dédiée sans modifier le défaut serveur (`mode=legacy`), puis activer le mode cible uniquement côté client pilote via une configuration opérateur invisible au LLM (par exemple `BDPM_API_BASEURL`, `BDPM_SEARCH_MODE=concepts` et liste blanche `BDPM_PILOT_CHATBOT_IDS`).
- **Rollback fonctionnel (immédiat)** : repasser le client pilote sur `mode=legacy` (ou retirer son identifiant de la liste blanche). Les requêtes suivantes reviennent immédiatement à `B0` sans redémarrage, mais `ConceptStore` et `TaxonomyVocab` déjà matérialisés restent en RAM.
- **Rollback de ressources (mémoire)** :
  - si `SEARCH_WARMUP_MODE=legacy` (défaut) : un rechargement du corpus (`onCorpusCleared()` + `loadData()` / `loadVetData()`), `resetConceptStoreCache()` ou un redémarrage du processus libère `ConceptStore` et `TaxonomyVocab` (`hasConceptStoreCached() === false`) ;
  - si `SEARCH_WARMUP_MODE=concepts` a été activé au démarrage : `onCorpusLoaded` reconstruit automatiquement `ConceptStore` à chaque rechargement ; il faut alors repasser `SEARCH_WARMUP_MODE=legacy` et redémarrer le processus (ou appeler `resetConceptStoreCache()` après réinitialisation de la configuration de warmup).
- **Observabilité légère recommandée** : journaliser/agréger par mode (`legacy`, `structured`, `concepts`) le volume d'appels, la latence p50/p95, le taux d'erreur/timeout HTTP, la part de `abstained=true` (ventilée par `abstain_reason`), de résultats vides ordinaires, de `search.parsed.conflicts`, de contradictions (`contradicted`), d'états `unknown`/`unsupported`, et la mémoire RSS / `hasConceptStoreCached()`.
- **Holdout prospectif post-pilote** : prélever un échantillon horodaté de nouvelles requêtes réelles postérieures à l'activation du pilote (jamais vues pendant le développement, la calibration ou le test verrouillé) pour vérifier l'absence de dérive hors échantillon.

### Précédence et conflits (`search.parsed.conflicts`)

En modes `structured` et `concepts`, si `q` contient un critère contradictoire avec un paramètre explicite (ex. `q=amoxicilline sirop&forme=comprimé`), le paramètre explicite (`forme=comprimé`) l'emporte systématiquement et le conflit est tracé dans `search.parsed.conflicts` (`[{ field: "forme", explicit: "comprimé", parsed: "sirop" }]`) ainsi que dans l'en-tête Markdown (`format=markdown`).

### Statuts de satisfaction (`criteria_status`) et rendu Markdown (`format=markdown`)

En modes `structured` et `concepts`, chaque fiche expose `criteria_status` (`{ dosage, forme, voie }`) en complément de `criteria_match`. En `format=markdown` (`detail=full` ou `detail=summary`), ces garanties sont rendues explicitement sur chaque fiche et dans l'en-tête :
- les contradictions (`contradicted`) affichent `- Critères (⚠️ contradiction — demande partiellement insatisfaite): <critère> ✗ (contradicted)` afin qu'un résultat approché à dose, forme ou voie incompatible (ex. `VITAMINE B1 250 mg` pour `500 mg`, ou `VITAMINE B6 250 mg` pour `10 mg`) ne soit jamais présenté comme entièrement satisfaisant ;
- les états `expanded` (`≈ (expanded)`), `unknown` (`? (unknown — non vérifiable)`) et `unsupported` (`! (unsupported — non pris en charge)`) sont distingués sans assimiler l'information inconnue à une contradiction prouvée ;
- les critères `not_requested` sont omis ;
- une abstention (`search.abstained: true`) affiche un bandeau explicite avec `abstain_reason`, distinct d'une recherche vide ordinaire (`_Aucun résultat._`).

| Statut | `criteria_match` | Signification |
|--------|------------------|---------------|
| `matched` | `true` | Correspondance stricte du critère demandé (ou forme complétée par la voie canonique exacte et compatible de la même spécialité, ex. `forme=émulsion cutanée` sur `forme_pharma="émulsion pour application"` + `voies_admin="cutanée"`). |
| `expanded` | `false` | Équivalence ou expansion vérifiée : synonyme galénique de rappel (`spray` ↔ `solution pour pulvérisation`), ou conversion de concentration dimensionnellement établie en `mode=concepts` (`1,5 g/10 ml` ↔ `150 mg/ml`, ou `%` ↔ `mg/ml` **uniquement** lorsque la base masse/volume `m/v` est prouvée par le texte ou par `CIS_COMPO` mono-substance non reconstituée). |
| `contradicted` | `false` | Le candidat possède une valeur incompatible avec le critère demandé. **Important** : un résultat proche mais au dosage incompatible (ex. `VITAMINE B1 250 mg` pour une demande `500 mg`, ou un volume de présentation différent `50 mg/5 ml` pour `100 mg/10 ml`) reste explicitement `contradicted` (`criteria_match.dosage: false`). |
| `unknown` | `false` | Donnée source insuffisante ou base physique non comparable sans hypothèse externe (ex. `%` dans une solution sans preuve masse/volume `m/v`, `% v/v`, `% m/m`, `mg/g`, `UI/mg`, `mg/kg`, débit `/24h`, concentration après reconstitution, ou spécialité sans dosage structuré). Aucun bonus d'équivalence n'est accordé. |
| `unsupported` | `false` | Contrainte négative non supportée (ex. `voie=non orale`, `forme=sans comprimé`). |
| `not_requested` | `false` | Critère non demandé. |

### Garde-fous d'abstention (`search.abstained`) et limites du périmètre

En modes `structured` et `concepts`, l'API s'abstient (`total: 0`, `data: []`, `search.abstained: true`, `search.abstain_reason`, `search.safety`) lorsque la requête exprime :
- une exclusion de substance ou d'excipient non vérifiable dans le libellé (`sans paracétamol`, `sans alcool`, `sans paraben` — seuls les qualifiants commerciaux littéraux présents dans les dénominations BDPM comme `sans sucre`, `sans conservateur`, `sans arôme`, `sans anis` sont recherchés en littéral contigu) ;
- une contrainte négative sur `forme` ou `voie` (`voie=non orale`) ;
- une propriété clinique ou réglementaire relevant du RCP complet (grossesse, allaitement, insuffisance rénale/hépatique, contre-indications, effets indésirables, surdosage).

> **Attention** : un refus (`abstained: true`) signale que le corpus indexé ne permet pas de résoudre la contrainte en sécurité ; ce n'est **pas** la preuve que l'application sait vérifier cette contrainte sur les requêtes non bloquées. L'absence de mention d'un excipient ou d'une contre-indication dans les champs BDPM ne signifie jamais absence d'excipient ni innocuité : toujours vérifier le RCP officiel (`url_bdpm`).

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
| Par nom / DCI / CIS / CIP13 | `GET /medicaments/disponibilite/alerts?q=amoxicilline` (1 appel ; liste vide = pas d’alerte BDPM) |
| Filtrer par statut | `code_statut=1` (rupture), `2` (tension), `3` (arrêt), `4` (remise) |
| Jointure URL fiche ANSM | `lien_ansm=` (URL normalisée) sur `/disponibilite` ou `/disponibilite/alerts` |
| Détail d’une alerte | `GET /medicaments/disponibilite/alerts/{id}` (id renvoyé par la liste) |
| Ruptures d’un CIS | champ `ruptures` sur `GET /medicaments/specialites/:cis` |

Dates brutes BDPM : `JJ/MM/AAAA`. Sur `/disponibilite/alerts`, `updated_at` / `expected_return` sont en `YYYY-MM-DD` si parseables.

**Attention** : `GET /disponibilite?q=` cherche dans le **libellé de statut**, pas le nom du médicament. Pour une recherche par nom, utiliser **`/disponibilite/alerts?q=`**. Ne pas mettre `q=rupture` : préférer `code_statut`.

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
