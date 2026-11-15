# Suite curée (vérité connue par construction)

Complément du banc sur trafic réel (`../production-replay/`). Ici, les requêtes sont rédigées ou dérivées du corpus, et chaque cas porte sa réponse attendue : la notation est **déterministe**, sans LLM ni réseau.

| | Trafic réel (`production-replay`) | Suite curée (ce dossier) |
|---|---|---|
| Mesure | Qualité sur la distribution réelle des appels | Chaque mécanisme isolé (codes, fautes, critères, associations, source, impossibles) |
| Vérité | Juge LLM, provisoire | Identifiants attendus, fixés à la construction |
| Données | Privées, hors dépôt | Publiques (corpus BDPM/ANMV ouvert) |

## Contenu

- `eval_suite_v3.json` : 108 cas (46 `dev`, 62 `heldout` ; 58 `curated`, 50 `corpus_generated`), repris **sans modification** de `scripts/benchmark/semantic-light/mission/` (branche `experiment/semantic-light-search`, commit `231fb47`). SHA-256 : `ed66b42fe5a967a4…`. Chaque cas distingue la bonne variante (`expectedVariantIds`), la bonne identité (`expectedIdentityIds`) et les pièges à éviter (`trapIds`), plus des cas impossibles et hors périmètre.
- `scoring.js` : métriques de l'harnais d'origine (`eval_harness.js`), sans la partie HTTP.
- `run.cjs` : rejoue B0 / B1 / B2 sur un checkout propre au SHA exact, avec le corpus local.

## Usage

```bash
node run.cjs --repo /chemin/checkout --expected-sha <SHA complet> \
  --data-dir /chemin/data --out /hors-depot/curated_<sha>.json
node run.cjs --compare /hors-depot/curated_avant.json /hors-depot/curated_apres.json
```

Le corpus BDPM/ANMV n'étant pas versionné, la suite ne tourne pas dans la CI standard.

## Contrôles intégrés

Chaque passage échoue (code 3) si :
- un identifiant attendu n'existe plus dans le corpus chargé (cas périmé) ;
- le système **ORACLE** (renvoie les variantes attendues) n'obtient pas `variantTop1 = 1` ;
- le système **NULL** (ne renvoie rien) obtient une réussite.

L'oracle n'atteint pas `ndcg10 = 1` : l'idéal inclut les fiches de bonne identité mais d'autre variante, que l'oracle ne renvoie pas.

## Calibrer un juge LLM sans relecture humaine

`judge_calibration.py` réutilise la suite comme étalon : `prepare` la convertit au format du banc (`../production-replay/`), puis, après rejeu, packets et jugement, `score` compare chaque note à la réponse attendue (bonne variante : note ≥ 2 ; piège : note ≤ 1), compare deux juges et simule une stratégie hybride guidée par la confiance archivée d'un juge. Voir l'aide du script (`python judge_calibration.py -h`) et ses tests (`python -m unittest test_judge_calibration`).

`eval_suite_v3.suspects.json` liste les cas dont la réponse attendue paraît fausse (relevés lors de la calibration du 2026-11-15) ; `--exclude-suspects` permet l'analyse de sensibilité sans modifier la suite.

## Limites

- **Pas un test indépendant.** B1/B2 ont été mis au point sur `dev`, et `heldout` a déjà été consulté lors de la validation finale d'origine. B2 y est proche du plafond (≈ 0,99 en `variantTop1`) : la suite sert de **non-régression** et d'explication par famille, pas de mesure de progrès.
- Les cas sont rédigés : ils ne reflètent pas la distribution du trafic réel.
- Ne jamais modifier un cas pour faire passer un nouveau code. Les cas ajoutés plus tard vont dans un fichier séparé, noté à part.
