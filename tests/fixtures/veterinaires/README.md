# Fixtures vétérinaires ANMV

## Fichiers

| Fichier | Rôle |
|---------|------|
| `amm-vet-fixture.xml` | Petit échantillon pour les tests API (2 médicaments). |
| `amm-vet-d-fixture.xml` | Dictionnaire associé. |
| `amm-vet-fr-v2-v.xml` | *(optionnel)* Copie du fichier produits complet pour les tests d’équivalence des liens RCP. |

## Rafraîchir le corpus complet (liens RCP)

Après téléchargement des données ANMV :

```bash
cp ../../data/veterinaires/amm-vet-fr-v2-v.xml tests/fixtures/veterinaires/amm-vet-fr-v2-v.xml
```

Ou pointer un autre fichier :

```bash
VET_RCP_EQUIVALENCE_XML=/chemin/vers/amm-vet-fr-v2-v.xml npm test -- tests/vet-rcp-link-equivalence.test.js
```

Sans copie ni variable, le test complet utilise `data/veterinaires/amm-vet-fr-v2-v.xml` s’il existe, sinon il est ignoré (`describe.skip`).

## Mettre à jour la petite fixture

Lors d’un changement de format ANMV, aligner `amm-vet-fixture.xml` sur un médicament réel (ex. SULTRIAN 100) : balises `<maj-rcp>` et `<lien-rcp>` au **niveau produit**, comme dans le fichier officiel.
