# Étude — paramètres `dosage` et `forme` pour `/search`

Généré le 2026-07-05T20:34:22.927Z

## 1. Profil des champs BDPM

### Spécialités

- Total : 15848
- `forme_pharma` distinctes : 367
- `forme_pharma` vide : 0%
- `voies_admin` distinctes : 156
- `voies_admin` vide : 0%

Top `forme_pharma` :

- comprimé pelliculé (2887)
- solution injectable (1300)
- comprimé (1289)
- gélule (1109)
- comprimé et solution(s) et granules et poudre et pommade (1059)
- comprimé pelliculé sécable (679)
- comprimé sécable (672)
- solution buvable (274)
- solution à diluer pour perfusion (272)
- solution pour perfusion (270)

### Compositions

- Total : 32396
- `dosage` vide : 8.7%
- `dosage` distincts : 3940
- Dosages parseables (mg/g/ug/ml/ui/%) : 77.9%
- CIS avec plusieurs dosages : 33.8%

## 2. Comparaison rappel actuel vs cible

| Exemple | composite (AND) | q seul | rappel actuel | rappel cible | delta |
|---------|------------------:|-------:|--------------:|-------------:|------:|
| doliprane_1g | 0 | 31 | 31 | 31 | 0 |
| esomeprazole_40 | 25 | 97 | 97 | 97 | 0 |
| ozempic_025 | 1 | 3 | 3 | 3 | 0 |
| prednisolone_oro_20 | 10 | 43 | 43 | 40 | -3 |
| progesterone_ovule | 0 | 21 | 21 | 21 | 0 |
| cerulyse_spray | 1 | 1 | 1 | 1 | 0 |
| nexium_40 | 2 | 8 | 8 | 8 | 0 |
| paracetamol_1g | 0 | 229 | 229 | 229 | 0 |
| sertraline_25 | 11 | 27 | 27 | 27 | 0 |
| methotrexate_per_os | 0 | 88 | 88 | 70 | -18 |

## 3. Scoring structuré (boost non destructif)

| Exemple | verdict | top après boost | match dosage | match forme | match voie |
|---------|---------|-------------------|:------------:|:-----------:|:----------:|
| doliprane_1g | structured_fixes_composite_failure | DOLIPRANE 1000 mg, comprimé | oui | oui | non |
| esomeprazole_40 | structured_improves_ranking | ESOMEPRAZOLE ALMUS 40 mg, gélule gastro-résistante | oui | non | non |
| ozempic_025 | structured_improves_ranking | OZEMPIC 0,25 mg, solution injectable en stylo prérempli | oui | non | non |
| prednisolone_oro_20 | structured_improves_ranking | PREDNISOLONE ARROW 20 mg, comprimé orodispersible | oui | oui | non |
| progesterone_ovule | structured_fixes_composite_failure | AMELGEN 400 mg, ovule | non | oui | oui |
| cerulyse_spray | structured_improves_ranking | CERULYSE 5 g/100 g, solution pour instillation auriculaire | non | oui | oui |
| nexium_40 | structured_improves_ranking | INEXIUM 40 mg, comprimé gastro-résistant | oui | non | non |
| paracetamol_1g | structured_fixes_composite_failure | DAFALGAN 1000 mg, comprimé effervescent | oui | oui | non |
| sertraline_25 | structured_improves_ranking | SERTRALINE ARROW LAB 25 mg, gélule | oui | oui | non |
| methotrexate_per_os | structured_partial_fix | IMENOR 10 mg, comprimé sécable | non | oui | oui |

## 4. Recommandation interface

- Ajouter `dosage` et `forme` comme paramètres optionnels de `/search`.
- Scoring : **boost non destructif** (jamais filtre strict par défaut).
- Retirer du rappel texte : `compositions.dosage`, `presentations.libelle`.
- Conserver lookup exact : `cis`, `cip7`, `cip13`.
- Étude : 3 cas composite→0 corrigés par structuré ; 6 améliorations de ranking ; 1 partiels ; 0 sans gain.

### Lecture des deltas de rappel cible

- Un delta négatif signifie que le rappel actuel bénéficiait de bruit (`dosage` ou `libelle` présentation indexés).
- Ex. `methotrexate_per_os` : rappel actuel 88 vs cible 70 — le bruit composition disparaît, mais `q=méthotrexate` seul ramène déjà 88 candidats ; le structuré sert à **réordonner**, pas à rappeler.
- Ex. `prednisolone_oro_20` : delta -3 — impact faible, le scoring structuré remonte le bon comprimé orodispersible 20 mg.

### Normalisation dosage — limites observées

- 77.9% des dosages BDPM sont parseables en mg/g/ug/ml/ui/%.
- Les équivalences `1 gramme` ↔ `1000 mg` fonctionnent sur les cas testés.
- 33.8% des CIS ont plusieurs dosages en composition : le booster ne doit pas exclure les autres présentations.

### Forme vs voie

- `forme_pharma` est relativement normalisé (367 valeurs distinctes, 0% vide).
- `voie` mérite un paramètre séparé : `ovule`, `spray`, `collyre` relèvent souvent de `forme_pharma` + `voies_admin` combinés.
- Sur les exemples : `progesterone ovule` et `Cerulyse spray` nécessitent `forme` + `voie` pour un boost fiable.

### Exemples validés pour le prompt agent

- Appel : `q=Doliprane&dosage=1 gramme&forme=comprimé` — éviter `Doliprane 1 gramme comprimé` → DOLIPRANE 1000 mg, comprimé
- Appel : `q=Esomeprazole&dosage=40 mg` — éviter `Esomeprazole 40 mg` → ESOMEPRAZOLE ALMUS 40 mg, gélule gastro-résistante
- Appel : `q=Ozempic&dosage=0,25 mg` — éviter `Ozempic 0,25 mg` → OZEMPIC 0,25 mg, solution injectable en stylo prérempli
- Appel : `q=prednisolone&dosage=20 mg&forme=comprimé orodispersible` — éviter `prednisolone 20 mg comprimé orodispersible` → PREDNISOLONE ARROW 20 mg, comprimé orodispersible
- Appel : `q=progesterone&forme=ovule&voie=vaginale` — éviter `progesterone ovule vaginale` → AMELGEN 400 mg, ovule
- Appel : `q=Cerulyse&forme=solution&voie=auriculaire` — éviter `Cerulyse solution auriculaire` → CERULYSE 5 g/100 g, solution pour instillation auriculaire
