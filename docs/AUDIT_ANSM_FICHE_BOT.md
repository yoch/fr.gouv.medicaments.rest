# Audit — robot vs fiches détail ANSM

Rapport généré le 2026-07-16T18:29:20.052Z. Artefacts sous `tmp/audit/ansm-fiches/` (gitignored). Stats JSON : `tmp/audit/ansm-fiches/stats.json`.

## Objectif

Vérifier si un robot HTTP peut **récupérer** et **extraire** le narratif utile (statut, observations, reco / contingentement / alternatives) des fiches ANSM pointées par `lien_ansm` BDPM — sans mesurer le rate-limit.

## Méthode

| Élément | Valeur |
| --- | --- |
| Source URLs | `CIS_CIP_Dispo_Spec` → `lien_ansm` normalisé |
| URLs uniques dans le corpus | 262 |
| Échantillon sondé | 40 |
| User-Agent | `fr.gouv.medicaments.rest-audit/1.5 (+fiche-bot-probe)` |
| Runtime | `fetch` Node one-shot (pas de headless) |
| Parseur | heuristiques HTML (regex) — pas de Playwright |

### Répartition de l’échantillon (code_statut primaire)

| Code | Libellé typique | URLs sondées |
| --- | --- | ---: |
| 1 | Rupture | 10 |
| 2 | Tension | 14 |
| 3 | Arrêt | 8 |
| 4 | Remise | 8 |

## Résultat synthétique

| Mesure | Valeur |
| --- | --- |
| HTTP OK | 39/40 (97.5 %) |
| Challenge / captcha | 0 |
| SPA root vide | 0 |
| Marqueurs SSR (`page-header-title` + `products-block`) | 39/40 |
| Extractibilité good / partial / poor / none | 39 / 0 / 0 / 1 |
| Fiches avec narratif métier utile | 39/40 |
| Taille HTML moyenne | 107571 octets |
| Latence moyenne | 135 ms |
| **Verdict scrape fiche** | **GO** — HTML SSR accessible sans challenge ; titre/statut/panels extractibles de façon stable ; narratif métier présent (1 URL BDPM sans fiche HTTP OK — lien potentiellement périmé) |

## Complétude des champs extraits (échantillon HTTP OK)

| Champ | Trouvé | Absent |
| --- | ---: | ---: |
| `title` | 39 | 0 |
| `status` | 39 | 0 |
| `published` | 39 | 0 |
| `since` | 39 | 0 |
| `observations` | 39 | 0 |
| `dci` | 39 | 0 |
| `indications` | 39 | 0 |
| `laboratoire` | 39 | 0 |
| `narrative_panels` | 39 | 0 |

## Signaux techniques observés

- Pas de dépendance à un navigateur headless si les marqueurs SSR sont présents.
- `Server` : `Unknown`×40
- `Via` : `1.1 varnish (Varnish/6.4)`×40
- Structure récurrente : `h1.page-header-title`, `div.tags span.label`, panels `panel-heading` / `panel-body` / `products-block wysiwyg-content`.

## Détail par URL (échantillon)

| # | CIS ex. | Statut BDPM | HTTP | Extract. | Narratif | Titre extrait |
| ---: | --- | --- | ---: | --- | --- | --- |
| 1 | 64805678 | Rupture de stock | 200 | good | oui | Nexviadyme 100 mg, poudre pour solution à diluer pour perfusion – [avalglucosida |
| 2 | 61722572 | Rupture de stock | 200 | good | oui | Linézolide Arrow 600 mg, comprimé pelliculé – [linezolide] |
| 3 | 63918096 | Rupture de stock | 200 | good | oui | Azactam 1 g, poudre et solution pour usage parentéral – [aztréonam] |
| 4 | 62416105 | Rupture de stock | 200 | good | oui | Tranxène 20 mg/2 ml, lyophilisat et solution pour usage parentéral – [clorazépat |
| 5 | 62148415 | Rupture de stock | 200 | good | oui | Ritonavir Arrow 100 mg, comprimé pelliculé – [ritonavir] |
| 6 | 68574699 | Rupture de stock | 200 | good | oui | Tofranil 10 mg, comprimé enrobé – [imipramine] |
| 7 | 61578339 | Rupture de stock | 200 | good | oui | Ritonavir Viatris 100 mg, comprimé pelliculé – [ritonavir] |
| 8 | 68878549 | Rupture de stock | 200 | good | oui | Rispéridone L.P. 25 mg/2 ml, 37,5 mg/2 ml et 50 mg/2 ml, poudre et solvant pour  |
| 9 | 61146475 | Rupture de stock | 200 | good | oui | Fluorouracile Teva 5000 mg/100 mL, solution à diluer pour perfusion, flacon de 1 |
| 10 | 64590923 | Rupture de stock | 200 | good | oui | Fluorouracile Pfizer 50 mg/ml, solution à diluer pour perfusion - flacon de 100  |
| 11 | 64930518 | Tension d'approvisionnement | 200 | good | oui | Métoprolol Sandoz 50 mg, comprimé – [métoprolol (tartrate de)] |
| 12 | 65991171 | Tension d'approvisionnement | 200 | good | oui | Zophren 2 mg/ml, solution injectable en ampoule (IV) – [ondansétron] |
| 13 | 63898512 | Tension d'approvisionnement | 200 | good | oui | Rifinah 300 mg/150 mg, comprimé enrobé – [isoniazide, rifampicine] |
| 14 | 66421434 | Tension d'approvisionnement | 200 | good | oui | Verkazia 1 mg/mL, collyre en émulsion – [ciclosporine] |
| 15 | 60016589 | Tension d'approvisionnement | 200 | good | oui | Levocarnil 1 g/5 ml, solution injectable en ampoule – [lévocarnitine] |
| 16 | 64386835 | Tension d'approvisionnement | 200 | good | oui | Cimzia 200 mg, solution injectable en stylo prérempli – [certolizumab pégol] |
| 17 | 62582326 | Tension d'approvisionnement | 200 | good | oui | Depo Prodasone 500 mg, suspension injectable – [médroxyprogestérone] |
| 18 | 67563415 | Tension d'approvisionnement | 200 | good | oui | Burinex 1 mg et 5 mg, comprimé – [bumétanide] |
| 19 | 69586327 | Tension d'approvisionnement | 200 | good | oui | Endoxan 500 et 1000 mg, poudre pour solution injectable – [cyclophosphamide] |
| 20 | 62628873 | Tension d'approvisionnement | 200 | good | oui | Méthylprednisolone Viatris 500 mg, poudre pour solution injectable (IM-IV) – [mé |
| 21 | 65172663 | Tension d'approvisionnement | 200 | good | oui | Recarbrio 500 mg/500 mg/250 mg, poudre pour solution pour perfusion – [cilastati |
| 22 | 62190115 | Tension d'approvisionnement | 200 | good | oui | Méthylprednisolone Hikma 500 mg, poudre pour solution injectable – [méthylpredni |
| 23 | 60490893 | Tension d'approvisionnement | 200 | good | oui | Quetiapine LP (Xeroquel LP) 50 mg, 300 mg et 400 mg comprimé à libération prolon |
| 24 | 61731639 | Tension d'approvisionnement | 200 | good | oui | Lutrelef 3,2 mg, poudre et solvant pour solution injectable – [gonadoréline (acé |
| 25 | 67353712 | Arrêt de commercialisation | 200 | good | oui | Cynomel 0,025 mg, comprimé sécable – [liothyronine sodique] |
| 26 | 65381773 | Arrêt de commercialisation | 200 | good | oui | Cardiorythmine 50 mg/10 ml, solution injectable – [ajmaline] |
| 27 | 61779947 | Arrêt de commercialisation | 200 | good | oui | Digidot 80mg, poudre pour solution pour perfusion (Digifab importation) – [Fragm |
| 28 | 66661251 | Arrêt de commercialisation | 200 | good | oui | Imogam Rage 150 UI/mL, solution injectable – [Immunoglobuline humaine rabique] |
| 29 | 69637743 | Arrêt de commercialisation | 200 | good | oui | Soludactone 100 mg et 200 mg, lyophilisat et solution pour usage parentéral – [c |
| 30 | 68973004 | Arrêt de commercialisation | 200 | good | oui | Vitamine A Dulcis 25 000 U.I. pour 100 g, pommade ophtalmique - (importation de  |
| 31 | 62533756 | Arrêt de commercialisation | 200 | good | oui | Atropine 0,3%, collyre – [atropine (sulfate)] |
| 32 | 60998977 | Arrêt de commercialisation | 200 | good | oui | Tildiem 100 mg, poudre pour solution injectable (IV) – [diltiazem (chlorhydrate  |
| 33 | 67448384 | Remise à disposition | 200 | good | oui | Megace 160 mg, comprimé – [mégestrol (acétate de)] |
| 34 | 69201849 | Remise à disposition | 200 | good | oui | Varivax, poudre et solvant pour suspension injectable en seringue préremplie. Va |
| 35 | 64582182 | Remise à disposition | 200 | good | oui | Levmentin 1 g/200 mg, poudre pour solution injectable/pour perfusion (IV) – [amo |
| 36 | 60756917 | Remise à disposition | 200 | good | oui | Concerta LP 18 mg, comprimé à libération prolongée – [méthylphénidate (chlorhydr |
| 37 | 67401121 | Remise à disposition | 200 | good | oui | Imukin 2 X 10⁶ UI (0,1 mg), solution injectable – [interféron gamma-1b] |
| 38 | 68731823 | Remise à disposition | 200 | good | oui | Scopoderm TTS 1 mg/72 heures, dispositif transdermique – [scopolamine] |
| 39 | 68578562 | Remise à disposition | 200 | good | oui | Un-Alfa 1 microgramme/0,5 ml, solution injectable IV en ampoule – [alfacalcidol] |
| 40 | 62404793 | Remise à disposition | 404 | — | non |  |

## Implications produit

- Le MVP BDPM actuel (`/disponibilite`) reste la source structurée (CIS, CIP, dates, `detail_url`).
- Un scrape fiche ANSM est **techniquement envisageable** seulement si le verdict est GO ou PARTIEL ; le narratif (hôpital / ville / contingentement / lettres labo) n’est **pas** dans BDPM.
- Une même URL ANSM peut couvrir plusieurs CIS BDPM : toute ingestion future doit rester jointe par URL, pas fusionnée silencieusement.
- Cet audit ne mesure pas robots.txt politique d’usage ni charge ; one-shot uniquement.

## Limites

- Heuristiques regex : un redesign ANSM peut casser les sélecteurs sans casser le HTTP 200.
- Échantillon ~40 URLs, pas exhaustif.
- Pas de rendu JS : si demain le site devient SPA pure, le verdict basculera.

