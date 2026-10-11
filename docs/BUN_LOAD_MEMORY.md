# Pic mémoire au chargement sous Bun

Le commit de référence est `212fd14` (1.5.3). Son option PM2
`--max-semi-space-size=8` règle la jeune génération de V8. Elle ne configure
pas JavaScriptCore, le moteur de Bun.

Le pic est reproduit sous **Bun 1.4.3** avec les corpus locaux complets,
`NODE_ENV=production` et `CORPUS_LIGHT_PROFILE=true`. Les avis HAS et MITM
restent activés. Les données d'entrée, les mesures individuelles et leurs
empreintes SHA-256 sont dans [BUN_LOAD_MEMORY_RESULTS.json](BUN_LOAD_MEMORY_RESULTS.json).

## Résultats

Trois processus neufs par variante, exécutions séquentielles alternant avant
et après, sans téléchargement ni GC forcé. Le maximum RSS provient du noyau
via GNU `time -v`, et couvre les pics entre les échantillons de 50 ms.
Mesures en **Mio**, durée des loaders BDPM puis ANMV. Machine Linux x86_64,
quota de 4 CPU et limite mémoire de 16 Gio.

| Runtime | Pic RSS médian avant | Après | Durée médiane avant | Après |
|---|---:|---:|---:|---:|
| Bun 1.4.3 | 466,4 | 337,6 | 5,63 s | 4,28 s |
| Bun 1.4.3 `--smol` | 451,0 | 365,0 | 5,60 s | 4,40 s |
| Node 24.19.0 `--max-semi-space-size=8` | 229,0 | 227,1 | 5,20 s | 4,11 s |

Le correctif réduit le pic médian de Bun d'environ **28 %** et la durée de
chargement d'environ **24 %**. Les pics Bun passent de 441,9–514,2 Mio à
319,8–339,2 Mio. `--smol` n'apporte pas de gain reproductible sur ce workload ;
la configuration PM2 Bun reste donc inchangée.

Ces valeurs ne constituent pas une borne mémoire garantie. Bun garde un pic
supérieur à Node avec le réglage V8 de 1.5.3. La matrice ne comprend ni le délai
vétérinaire de 5 secondes de PM2, ni du trafic HTTP. Le RSS en fin de chargement
n'est pas une mesure du résident après stabilisation.

## Correctif

`streamMedicinalProductsXml.js` ne cherche plus `</medicinal-product>` dans
tout le buffer accumulé après chaque ligne. Il cherche dans le fragment ajouté
puis calcule la position dans le produit. Les scans répétés avaient un coût
quadratique et obligeaient JavaScriptCore à aplatir/copier les concaténations.

Le lecteur traite les lignes synchroniquement dans chaque chunk du ReadStream,
avec une attente seulement pour les chunks et les callbacks produits. Il évite
ainsi l'itérateur async de `readline` sur les 784 855 lignes du XML ANMV.
La lecture conserve la backpressure, le décodage UTF-8, LF/CRLF/CR et la
suppression des sous-arbres RCP. Les données temporaires restent limitées au
chunk, à la ligne incomplète et au produit en cours.

Les 3 221 produits extraits sont identiques octet pour octet à ceux du lecteur
initial, avec les options par défaut, avec `lien-rcp` conservé et sans suppression
de balises. Les trois empreintes de sortie sont consignées dans le JSON.

## Reproduction

Installer Bun et les dépendances du lockfile, puis utiliser les mêmes fichiers
`data/*.txt` et `data/veterinaires/*.xml` pour les deux révisions. Aucun accès à
une API de production n'est nécessaire.

```sh
mkdir -p tmp/bun-memory
NODE_ENV=production CORPUS_LIGHT_PROFILE=true PROFILE_SAMPLE_MS=50 \
  PROFILE_OUT=tmp/bun-memory/load.json \
  /usr/bin/time -v bun scripts/memory/profile-load-memory-highfreq.js
```

Répéter trois fois dans chaque révision. Tester aussi `bun --smol` et
`node --max-semi-space-size=8`. Le profiler expose désormais le runtime réel
(Bun ne doit pas être identifié via son `process.version` de compatibilité Node)
et `summary.max_rss_mb`, le maximum RSS du noyau.

```sh
npm run test:all
bun node_modules/jest/bin/jest.js --runInBand \
  tests/streamMedicinalProductsXml.test.js tests/vetLoadPipeline.test.js
NODE_BIN=node BUN_BIN=bun node scripts/benchmark/verify-runtime-parity.js
```

La comparaison HTTP lance deux serveurs locaux sur ports aléatoires, charge
les corpus sans téléchargement et vérifie 28 réponses : listes, pagination,
fuzzy, détails, recherche hybride, markdown et erreurs publiques. Elle vérifie
le format de `generated_at` puis l'écarte de la comparaison, car il est généré
à chaque requête.

Le lancement de la suite Jest complète avec Bun sur la révision de référence
échoue dans les suites Express (`depd`, `callSite.getFileName` indisponible dans
le contexte Jest/Bun). Les contrats HTTP Bun sont donc vérifiés dans de vrais
processus Bun par le script de comparaison, et les tests XML tournent aussi
sous Bun.

## Validation finale

- 20 suites / **208 tests** réussis sous Node, avec les corpus complets.
- 2 suites / **9 tests** XML réussis sous Bun : données fixture, UTF-8 coupé,
  CRLF à la frontière de lecture, dernière ligne sans newline, callbacks
  asynchrones séquentiels et propagation des erreurs.
- **28 réponses HTTP** identiques entre processus Node et Bun.
- Charge locale Bun, 10 clients : **10 350 requêtes** pendant le démarrage
  avec ANMV différé de 5 s, puis **38 928 requêtes** après chargement,
  sans erreur HTTP ou réseau. RSS échantillonné : 516,8 Mio pendant le
  démarrage sous trafic, puis 561,6 Mio pendant la charge ; 346,7 Mio à la fin.
  Ce test est un contrôle de fonctionnement, pas un comparatif de débit : la
  suite Node tournait en parallèle. Il ne prouve pas l'absence de fuite à long
  terme. Le correctif ne plafonne pas les allocations dues aux requêtes.

La suite Knip produit les mêmes diagnostics que sur le commit de référence
(les outils Jest sont installés hors dépôt dans cet environnement).
