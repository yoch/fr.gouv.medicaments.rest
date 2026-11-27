# Exécutable compilé avec Bun `--compile --aot`

Ce document décrit comment construire, vérifier et déployer le serveur sous forme d'exécutable autonome. Les mesures de débit et de mémoire sont dans [BUN_AOT_EVALUATION.md](BUN_AOT_EVALUATION.md), relevées sur Bun 1.4.4-canary. L'état ci-dessous a été vérifié sur `1.4.6-canary.1+736fe1187` (27/11/2026), sans nouvelle mesure de temps.

Le chemin Node ne change pas : `npm start`, `ecosystem.config.js` et les tests Jest restent la référence. L'exécutable s'y ajoute sans rien remplacer.

## Construire

```bash
npm ci
npm run build:aot                  # dist/medicaments-api + dist/7za
npm run build:aot -- --require-aot # échoue si FrozenMiniSearch n'est pas compilé avec ses types
```

`scripts/aot/build.js` lance `bun build --compile --aot --trim --trim-locales=fr`, avec deux constantes de build :

| Constante | Effet |
|-----------|-------|
| `process.env.MEDICAMENTS_STANDALONE="1"` | `src/config.js` exige `DATA_DIR` et cherche `7za` à côté de l'exécutable. |
| `process.env.NODE_ENV="production"` | Bun remplace `process.env.NODE_ENV` par une constante au build. Sans cette option, la constante vaut `development`, bien que l'aide dise que `--compile` implique `--production`. Express et `src/config.js` lisent cette constante : le `NODE_ENV` de l'environnement d'exécution est ignoré. |

Le script vérifie dans le metafile que `@yoch/frozenminisearch` est compilé depuis `dist/aot/index.aot.ts`. Cette source typée est publiée derrière la condition d'export `"aot"`, que `bun build --compile --aot` choisit seul, aussi pour `require` : `--conditions=aot` n'est plus nécessaire. Avec une version du paquet sans cette condition, le build passe mais compile le JavaScript non typé de la bibliothèque, ce qui rend la recherche plus lente (−45 à −55 % mesurés dans l'évaluation). Le script affiche alors un avertissement, et `--require-aot` en fait une erreur.

`7za` (de `7zip-bin`) est copié à côté de l'exécutable. Un binaire embarqué ne peut pas être lancé avec `execFile`.

## Vérifier

```bash
DATA_DIR=/chemin/data VET_DATA_DIR=/chemin/data/veterinaires npm run smoke:aot
```

`scripts/aot/smoke.js` démarre l'exécutable et `node src/server.js` sur deux ports libres, avec les mêmes données. Il compare ensuite statut et corps sur 15 chemins : `/`, Swagger, `/health`, `/config`, recherches exacte, floue, accentuée et par CIP, disponibilités, vétérinaire, erreurs 400 et 404. Les horodatages, la mémoire et l'uptime sont ignorés. Utilise une copie récente des données : les deux serveurs partagent `DATA_DIR`, et l'intervalle maximal (596 h) n'évite un téléchargement que si les données ont moins de 25 jours.

Résultat sur `736fe1187` avec les données du 15/11/2026 : **15 chemins identiques à Node**, et la lib est bien compilée depuis la source typée.

- Le binaire est prêt en ~19 s, chargement BDPM compris.
- Il s'arrête sur SIGTERM.
- Sa RSS au repos après chargement est de 215 Mo, contre 255 Mo pour Node. C'est une lecture ponctuelle, pas une mesure.

## Ce que l'exécutable demande à l'hôte

- **Données** : `DATA_DIR` et `VET_DATA_DIR` sont des chemins absolus, accessibles en écriture (téléchargements, `meta.json`). Dans un exécutable `--aot`, `__dirname` reste le dossier source de la machine de build. Le défaut `<dépôt>/data` pointerait donc en silence vers ce checkout : l'exécutable refuse de démarrer sans `DATA_DIR`.
- **7za** : à côté de l'exécutable (`dist/7za`), ou indiqué par `SEVEN_ZIP_PATH`. Il n'est utilisé que pour extraire l'archive vétérinaire après un téléchargement.
- **`file` et `iconv`** : sur le `PATH`, comme sous Node (`src/services/dataDownloader.js`).
- **Configuration** : variables d'environnement, ou `.env` du répertoire courant. L'exécutable charge ce `.env` sans écraser les variables déjà définies. `--env-file` n'existe pas pour l'exécutable.
- **Mémoire virtuelle** : ~38 Go d'adresses réservées. Ne pas poser `ulimit -v` ni `LimitAS`.

Ni Node ni Bun ne sont nécessaires à l'exécution.

## Déploiement

**Recommandation : systemd** ([deploy/medicaments-api.service](../deploy/medicaments-api.service)), avec [deploy/medicaments-api.env.example](../deploy/medicaments-api.env.example) pour l'environnement. [ecosystem.aot.config.js](../ecosystem.aot.config.js) sert pour la transition sous PM2.

| Critère | systemd | PM2 (`ecosystem.aot.config.js`) |
|---------|---------|---------------------------------|
| Dépendances de l'hôte | aucune | Node, pour le démon PM2 |
| `RELOAD_STRATEGY=restart` (sortie code 0) | `Restart=always` | `autorestart: true` |
| Logs | journald, rotation incluse | fichiers PM2, rotation à configurer (`pm2-logrotate`) |
| Limite mémoire | `MemoryHigh` / `MemoryMax` (cgroup, immédiat) | `max_memory_restart` (sondage toutes les 30 s) |
| Durcissement | `ProtectSystem=strict`, `ReadWritePaths` sur les données, `PrivateTmp` | aucun |
| Retour arrière vers Node | `systemctl disable --now`, puis `pm2 start ecosystem.config.js` | `pm2 delete`, puis `pm2 start ecosystem.config.js` |

Le binaire supprime le besoin de Node à l'exécution, mais PM2 le réintroduit. systemd apporte aussi ce que PM2 n'offre pas ici : limite mémoire immédiate, durcissement, journal. PM2 reste utile pendant la transition, tant que Node est installé pour le retour arrière et que l'exploitation garde ses habitudes. Avis concordant demandé à Codex.

Points communs aux deux :

- **Un seul superviseur** doit tenir le port 3100 : retirer l'API de la liste PM2 (`pm2 delete medicaments-api && pm2 save`) avant d'activer l'unité.
- **Pas d'arrêt gracieux** : le serveur n'intercepte ni SIGTERM ni SIGINT, comme sous Node. Les requêtes en cours sont coupées, et Apache répond en erreur pendant chaque redémarrage (chargement BDPM avant l'écoute), comme aujourd'hui.
- **Mémoire** : dimensionner sur le pic sous charge (~400 Mo dans l'évaluation), pas sur le plateau. L'unité pose `MemoryHigh=600M` et `MemoryMax=900M`, à ajuster sur la machine cible.

### Bascule systemd

```bash
npm ci && npm run build:aot -- --require-aot
DATA_DIR=/srv/medicaments/data npm run smoke:aot   # sur une copie des données
# voir l'en-tête de deploy/medicaments-api.service pour l'installation
pm2 delete medicaments-api && pm2 save
sudo systemctl enable --now medicaments-api
curl -sS http://127.0.0.1:3100/health
```

Retour arrière : `sudo systemctl disable --now medicaments-api`, puis `pm2 start ecosystem.config.js && pm2 save`.

## Passe `--explain` (`736fe1187`)

- **Causes :** 5 295, contre 4 859 dans l'évaluation. 3 705 sont dans les dépendances npm, 989 dans `src/` et 601 dans FrozenMiniSearch.
- **Rang de FrozenMiniSearch :** sa première cause n'arrive qu'au rang 840. Compilée depuis sa source typée, la bibliothèque n'est plus un poste du rapport.
- **Accès typés :** 20,6 % des accès aux propriétés du serveur sont une simple lecture, contre 30,8 % dans l'évaluation. Côté dépendances : 2 726 libres, 3 005 testés, 7 462 par nom.
- **Code du serveur :** les premières causes viennent de `src/` et sont des `exposed-variable` au niveau module, c'est-à-dire des exports CommonJS, sans type. Les traiter demande de migrer en modules ES typés (essai sur `experiment/bun-aot`). C'est hors du périmètre de ce déploiement, et sans gain mesuré sur le chemin d'une requête dans l'évaluation.
- **`--trim` :** il ne retire que ~14 Mo (86,3 → 72,3 Mo ; 160,5 Mo en `--no-aot`). `graceful-fs`, chargé par `fs-extra`, lit `global[gracefulQueue]` (une clé symbole calculée) et appelle `eval`. Le compilateur garde donc l'interpréteur, l'inspecteur, les profileurs, `Bun.build`, `Bun.$`, etc. Piste de suivi : remplacer `fs-extra` par `node:fs` dans les trois modules qui l'importent. Le gain ne porterait que sur la taille du fichier. Sur un build antérieur, `--trim` avait donné 54,5 Mo.
- **`Intl` :** `--explain=trim` ne l'attribue plus à FrozenMiniSearch. `--trim-locales=fr` reste nécessaire pour `localeCompare(…, 'fr')`.

## Bugs Bun connus et mitigations

Les issues ci-dessous ont été rapportées depuis `@yoch/frozenminisearch` ; le détail de leur état est dans son `dev/docs/BUN_AOT.md`.

| Problème | État sur `736fe1187` | Effet ici | Mitigation |
|----------|----------------------|-----------|------------|
| `NODE_ENV` figé à `development` malgré « `--compile` implies `--production` » | Reproduit (non encore rapporté) | `node_env: development` dans `/config`, Express en mode développement | `--define process.env.NODE_ENV="production"` dans `build:aot` ; le smoke test compare `/config`. |
| oven-sh/bun#47920 : `node:zlib` alourdit `--trim` | Reproduit (+14 Mio) | Taille seulement | Accepté (le serveur utilise zlib). |
| oven-sh/bun#48145 : `crc32` de `node:zlib` en appel indirect | Reproduit | E/S binaires seulement, non utilisées par le serveur | Aucune. |
| oven-sh/bun#48283 : `Map` / tri plus lents depuis la réécriture du compilateur | Retrouvé en microbenchmark (`ed4363334`), non re-mesuré | Chemin de recherche | `matchInfo: false` déjà passé (`src/utils/corpusSearch.js`). En dernier recours : `bun build --compile --no-aot`. |
| oven-sh/bun#47919 : noms de `--trim-without` | Partiellement corrigé | Aucun | `--trim --trim-locales=fr`, sans `--trim-without`. |

Échappatoire générale : si une version de Bun compile mal la bibliothèque ou le serveur, `bun build --compile --no-aot` produit un exécutable JIT avec les mêmes constantes. `--conditions` ne peut pas retirer la condition `"aot"`.

## Avant la mise en production

- Monter `@yoch/frozenminisearch` vers la version qui publie la condition `"aot"`, puis utiliser `--require-aot`.
- Rejouer `npm run test:integration` et les mesures de l'évaluation sur la machine cible.
- Exercer une vraie mise à jour des données vétérinaires (téléchargement, puis extraction par `7za`) avec l'exécutable.
