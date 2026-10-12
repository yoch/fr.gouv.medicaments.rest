# Audit mémoire de fr.gouv.medicaments.rest

Audit du 12 octobre 2026 sur la révision `5bc82b2` (version 1.6.0), sous Node.js 24.19.0. La hausse signalée de 149 à 154 Mo de RSS après redémarrage ne démontre pas une fuite. Les essais locaux reproduisent un RSS durablement élevé avec un tas vivant stable. Ils révèlent néanmoins une rétention cumulative dans le pool de chaînes lors des rechargements avec des valeurs nouvelles, ainsi que plusieurs défauts de fermeture et de propagation des erreurs.

Les résultats chiffrés repris ici se régénèrent avec les scripts `scripts/memory/audit-*.js` (sortie JSON dans `tmp/memory-audit/`). Les mesures de référence décrivent le service avant correction. Les correctifs appliqués et leur validation sont décrits dans la section suivante ; les scripts servent uniquement au diagnostic local.

## Correctifs appliqués

Les sept défauts décrits dans l'audit initial sont corrigés. Les générations BDPM et vétérinaire disposent de pools distincts, remplacés à chaque chargement et libérés en cas d'échec. Les appels concurrents d'un même loader ou downloader partagent une seule promesse, y compris pendant le chargement initial différé.

Les téléchargements, le hashing et la lecture CSV utilisent des pipelines qui propagent les erreurs et détruisent les flux. Le dossier de destination est préparé avant la requête ; un délai d'inactivité du socket (30 s pour la BDPM, 120 s pour l'ANMV) et un délai total de 10 minutes bornent le transfert HTTP. Le descripteur du header ANMV est fermé dans un finally. La sonde Range utilise un flux et le détruit dès réception des headers, même si le serveur envoie HTTP 200 et ne termine jamais le corps.

Le planificateur attend la fin d'un cycle avant de programmer le délai suivant. Les durées dépassant les limites des timers Node sont refusées au démarrage. `startServer()` retourne `{ app, server, stop, refreshBdpm, refreshVet }` : `stop()` ferme le serveur, supprime les timers, annule l'attente vétérinaire différée et attend les tâches déjà démarrées. `stop()` ferme aussi le MemoryStore du rate limiter (`app.locals.dispose()`), y compris quand `listen()` échoue au démarrage. Un code qui crée une application sans `startServer()` appelle lui-même `app.locals.dispose()`.

Le CSV est limité via `max_record_size=8*1024*1024`. Les limites XML sont de 1 048 576 unités UTF-16 par ligne, 4 194 304 par bloc produit et 4 194 304 pour un fragment incomplet du dictionnaire. Les cinq premiers exemples d'erreur XML sont conservés avec un compteur global. Le sampler garde au maximum 10 000 points et 1 000 marqueurs, tout en conservant les pics et compteurs globaux.

Les règles de recherche et de pagination restent identiques. Les recherches très larges peuvent encore produire un pic d'allocations et un RSS durablement élevé ; cet effet ne démontre pas une fuite et n'est pas supprimé par les correctifs de rétention et de fermeture.

Après correction, le scénario de données changeantes passe de **2 000 puis 4 000 puis 6 000 entrées** à **2 000 à chaque génération**. Les erreurs source et disque rejettent normalement et ferment les deux côtés du flux, sans erreur non gérée. Une erreur de création du dossier ne démarre plus de requête. L'erreur de header ferme le descripteur, trois demandes de refresh partagent un cycle et la configuration de 597 heures est rejetée.

Sur les mêmes corpus réels, 900 requêtes courantes et trois rechargements donnent un tas de **79,34 Mio initialement**, puis **78,84 Mio après rechargements et GC**, avec les anciens index libérés et les descripteurs revenus au niveau initial. Le RSS passe de 222,30 à 268,81 Mio : les pages conservées par Node restent visibles malgré un tas vivant stable. Ces mesures ne sont pas un comparatif de performances contrôlé.

La première validation des correctifs comprend **27 suites et 245 tests réussis, aucun ignoré**, incluant les erreurs de lecture, d'écriture, d'indexation, le délai global sur un flux continu, les générations changeantes, la concurrence, les durées, l'arrêt et la réutilisation du serveur et les bornes de parsing et de profilage.

## Contre-audit de la PR #5

La relecture de la révision `37c3fef` a révélé **deux défauts supplémentaires de nettoyage** et une validation de durée incomplète. Ils sont corrigés dans la même PR. Les premiers tests couvraient les erreurs des flux et les arrêts normaux, mais pas le rejet HTTP avant affectation de la réponse ni les échecs de `listen()`.

| Priorité | Défaut reproduit | Correction et preuve |
| --- | --- | --- |
| P1 | Axios rejette les réponses 4xx/5xx streaming avant l'affectation de `response`. Le téléchargement et le fallback Range laissaient `error.response.data` ouvert. | Destruction explicite du corps dans les deux `catch`. Huit essais HTTP réels : 404/503, téléchargement/sonde, corps brut/gzip, réponse jamais terminée par le serveur. Tous vérifient la fermeture côté serveur avant le timeout réseau. |
| P2 | Un port occupé n'émet pas nécessairement `close`. Le compteur de serveurs restait incrémenté ; le MemoryStore n'était plus arrêté, même après fermeture d'un nouvel essai réussi. Une exception synchrone de `listen()` laissait aussi le timer actif. D'abord corrigé dans `app.listen`, puis simplifié : `startServer()` appelle `stop()` sur tout échec de démarrage, ce qui ferme le MemoryStore. Test de port occupé via `startServer()`. |
| P2 | Le sampler acceptait un intervalle de 2 147 483 648 ms, que Node transforme en 1 ms. | Validation par la même borne que les autres timers. Concerne les outils de profilage, pas le serveur par défaut. |

Les nouveaux contrôles échouaient avant les modifications : **11 tests en échec**, dont huit pour les réponses HTTP d'erreur. Après correction, la suite complète passe : **28 suites, 255 tests, aucun ignoré**.

Un nouvel essai sur les corpus réels comprend **1 800 requêtes mixtes**, dont les recherches à un caractère et les requêtes uniques, puis **six rechargements**. Le tas après GC passe de **79,34 Mio à 78,81 Mio après trafic**, puis **78,96 Mio après rechargement**. Le pool reste à **25 508 entrées** ; les **72 anciens index** suivis sont collectés. Les descripteurs reviennent de 29 sous trafic à **21**, leur niveau initial. Le RSS atteint **420,05 Mio**, tandis qu'`external` revient à **14,02 Mio** : aucune rétention cumulative supplémentaire n'est mise en évidence dans ce scénario.

Un essai distinct, limité à la BDPM avec rate limiting actif, interrompt **1 000 réponses après leurs premiers octets**. Les descripteurs restent à **20** après chaque lot, et le tas revient d'environ **68,27 Mio à 67,96 Mio**. Après **30 créations/fermetures d'applications**, les 30 applications et les 30 serveurs suivis par références faibles sont collectés ; les descripteurs sont à **19**, comme avant ces cycles.

La relecture couvre aussi les pools AsyncLocalStorage, les remplacements de corpus/index, le cache WeakMap de pagination, les index FrozenMiniSearch, les flux CSV/XML, les descripteurs d'export, les promesses partagées, le planificateur et l'arrêt différé. Aucune autre fuite n'a été confirmée sur ces chemins. Le cache de pagination garde au plus une entrée par index ; les collections du rate limiter expirent ; les corpus et leurs index restent volontairement résidents. Les appels directs à `createApp()` sans serveur nécessitent toujours `app.locals.dispose()` si l'application est abandonnée avec le rate limiting actif.

Ces essais locaux ne prouvent pas l'absence absolue de fuite, notamment dans un processus de production observé plusieurs jours. Ils n'attribuent pas les 149 → 154 Mo signalés à un défaut précis. Les recherches larges restent coûteuses en allocations, et les commandes externes de conversion/extraction ne disposent pas d'un délai global ; un blocage peut retenir leur cycle en cours, mais les appels partagés empêchent leur accumulation par le planificateur.

Reproduction complémentaire :

```sh
npm run test:serial -- tests/httpErrorCleanup.test.js tests/serverLifecycle.test.js tests/memorySampler.test.js
CORPUS_LIGHT_PROFILE=true AUDIT_TRAFFIC_MODE=mixed \
  AUDIT_BATCHES=6 AUDIT_REQUESTS=300 AUDIT_RELOADS=6 AUDIT_IDLE_MS=10000 \
  node --expose-gc --max-semi-space-size=8 scripts/memory/audit-retention.js
CORPUS_LIGHT_PROFILE=true \
  node --expose-gc --max-semi-space-size=8 scripts/memory/audit-http-disconnects.js
```

Les sections suivantes décrivent la révision initiale `5bc82b2`.

## Périmètre et méthode

L'audit couvre le démarrage et le planificateur, les téléchargements BDPM et ANMV, le parsing CSV et XML, les corpus et index secondaires, les modèles et l'interning, FrozenMiniSearch 1.11.0, la recherche paginée et hybride, les réponses Express, le rate limiter, les exports et les outils de profilage. La configuration PM2 par défaut utilise Node, `--max-semi-space-size=8`, le profil léger et `RELOAD_STRATEGY=restart`.

Les dépendances de production ont été réinstallées depuis le lockfile : l'environnement contenait initialement FrozenMiniSearch 1.9.0. Toutes les mesures ci-dessous utilisent 1.11.0. L'installation complète des dépendances de développement rencontre un refus HTTP 403 sur le téléchargement SheetJS ; les outils nécessaires à Jest ont été installés séparément dans `tmp/audit-testdeps`, sans modifier les manifests du dépôt.

Un processus Node sert les vrais corpus sur une adresse loopback et un port aléatoire. Un processus distinct émet les requêtes, consomme entièrement les réponses et conserve les mesures. Les téléchargements et le planificateur de production sont exclus des essais de trafic. Les chemins d'erreur sont examinés séparément, dans des processus isolés avec injections d'erreurs ou serveur HTTP local.

Les quatre essais totalisent **9 800 requêtes HTTP**, avec huit clients, sans réponse inattendue ni erreur réseau, et **18 rechargements complets** des fichiers inchangés. Le corpus contient 180 238 lignes métier, dont 3 221 médicaments vétérinaires. Les injections ajoutent trois rechargements d'un corpus vétérinaire synthétique changeant. La suite existante passe avec **21 suites et 216 tests, sans test ignoré**.

Les mesures après GC utilisent deux collections séparées par des tours de boucle événementielle. Un essai distinct observe uniquement le GC naturel. Les anciens index sont suivis avec des références faibles ; leur disparition est mesurée après retour des handlers de rechargement. Les snapshots avant et après cinq rechargements permettent de comparer les populations d'objets.

Ces essais de quelques minutes caractérisent la rétention dans ce checkout. Ils ne constituent pas une mesure de la pente du processus de production pendant plusieurs jours. Les corpus, flags et charge du serveur signalé peuvent différer. Tous les tableaux utilisent des **Mio** (1 048 576 octets), même si les endpoints nomment leurs champs `*_mb`.

## Résultats sous trafic et au repos

| Essai | Point de mesure | RSS Mio | Tas utilisé Mio | Interprétation |
| --- | --- | ---: | ---: | --- |
| Profil léger, trafic courant, GC diagnostique | Après chargement | 204,31 | 79,18 | Corpus et index présents |
| Même essai, 600 requêtes | Après GC | 207,50 | 80,76 | Échauffement HTTP et caches bornés |
| Même essai, 3 600 requêtes | Après GC | 207,73 | 80,93 | Plateau sous trafic courant |
| Même essai, 10 secondes sans trafic | Après GC | 207,73 | 80,83 | RSS conservé malgré collecte |
| Profil léger, trafic incluant des recherches très larges | Après chargement et GC | 224,82 | 79,18 | Autre processus, mêmes fichiers et flags |
| Même essai, premier lot de 400 requêtes | Avant GC diagnostique | 426,58 | 339,62 | Nombreuses allocations temporaires |
| Même essai, 2 400 requêtes | Après GC | 392,21 | 78,74 | Pas de hausse cumulative du tas vivant |
| Même essai, 30 secondes sans trafic | Après GC | 392,34 | 78,65 | RSS élevé avec tas revenu à son niveau initial |
| Profil léger, GC naturel, trafic incluant des recherches très larges | Après 3 200 requêtes | 491,41 | 204,19 | Objets vivants et déchets en attente de GC |
| Même essai, 60 secondes sans trafic | GC naturel seulement | 491,41 | 204,66 | Le repos n'oblige pas Node à collecter ou rendre les pages |

Le trafic courant comprend listes, détails, recherches médicamenteuses, pagination, JSON, Markdown, vétérinaire, disponibilité, documentation et requêtes distinctes sans résultat. L'essai avec recherches larges ajoute `q=a` sur la liste des spécialités et sur la recherche hybride `source=mixed`. Il ne s'agit pas d'une comparaison de débit ou d'un microbenchmark d'une requête isolée.

Dans l'essai léger avec GC et recherches larges, `external` revient à **14,08 Mio** et `arrayBuffers` à **10,43 Mio** à chaque lot. Les descripteurs passent de **21 au repos à 29 sous trafic**, correspondant aux huit connexions HTTP, puis reviennent à 21 après fermeture des clients. Aucun accroissement cumulatif des sockets n'apparaît dans ces essais.

Le trafic courant relève le RSS d'environ 3,4 Mio puis se stabilise, ce qui ressemble à l'observation initiale de 149 à 154 Mo. La cause de cette observation reste à confirmer avec les métriques du même PID en production.

## Résultats des rechargements et des snapshots

Dans l'essai courant sans snapshot, cinq rechargements font passer le RSS de 207,73 à **268,99 Mio**, tandis que le tas après retour du dernier handler revient à **79,14 Mio**, contre 79,18 au chargement initial. Le pool reste à **25 505 entrées** avec les mêmes données. Les 60 anciens index suivis ont tous disparu après GC hors des handlers.

| Snapshot du profil complet | Avant cinq rechargements | Après cinq rechargements |
| --- | ---: | ---: |
| Instances FrozenMiniSearch | 12 | 12 |
| Instances CorpusRecord | 180 238 | 180 238 |
| Nœuds du snapshot | 1 153 673 | 1 140 986 |
| Somme des tailles propres des nœuds | 94,56 Mio | 93,95 Mio |

Les populations de corpus et d'index ne s'accumulent pas. Un ancien index apparaît encore vivant dans certaines mesures prises à l'intérieur du handler async de rechargement ; il disparaît après retour de ce handler. Ce maintien temporaire est dû au contexte d'exécution du diagnostic, et ne prouve pas une fuite.

La capture de snapshots perturbe fortement le RSS et les allocations natives : les valeurs de RSS du run `full-gc` après capture ne doivent pas servir à estimer le coût normal des rechargements. La somme des tailles propres du snapshot est aussi une métrique distincte de `heapUsed` et du RSS.

## Défauts confirmés et correctifs prioritaires

### Pool global de chaînes conservant les anciennes générations

**Priorité P2 pour les rechargements dans le même processus.** [stringPool.js ligne 13](../src/utils/stringPool.js#L13) possède une `Map` globale contenant des références fortes. `clearInternPool()` existe, mais les loaders et leurs resets ne l'appellent jamais. Quand une valeur disparaît du corpus, elle reste accessible par cette Map jusqu'à la fin du processus.

La reproduction `pool-reload` charge trois générations de 1 000 produits contenant des dates RCP et libellés de présentation distincts. Le nombre de produits reste 1 000, mais le pool passe de **2 000 à 4 000 puis 6 000 entrées**. Après vidage des corpus, remplacement des index et GC, les 6 000 entrées restent présentes. Le vidage explicite du pool les supprime. Recharger les mêmes fichiers ne révèle donc pas cette fuite.

Les sites concernés comprennent les champs BDPM internés par `defineCorpusRecord`, notamment les libellés HAS, et l'interning explicite de `maj_rcp`, `libelle`, unités, espèces, codes et conditions vétérinaires dans [loadPipeline.js](../src/services/vet/loadPipeline.js). Le profil léger conserve `maj_rcp`, nécessaire à la reconstruction du lien RCP ; il ne dispense donc pas de gérer la durée de vie de son pool.

Un pool par domaine et par génération permettrait de libérer l'ancienne Map au remplacement du corpus. Une autre option est une borne explicite avec arrêt de l'ajout au-delà de la capacité, car l'interning est une optimisation et non une exigence fonctionnelle. Éviter un simple vidage global au début de chaque loader : BDPM et vétérinaire partagent le pool, et un tel vidage dégrade la déduplication des données de l'autre domaine. Le nettoyage doit être cohérent avec les chargements concurrents et les échecs partiels.

**Lien avec la production signalée :** si `/health` indique `reload_strategy=restart`, une mise à jour suivie du redémarrage libère tout le pool. Cette fuite ne peut alors pas expliquer une augmentation pendant un processus qui n'a effectué aucun rechargement avec de nouvelles valeurs.

### Téléchargements ne nettoyant pas les deux côtés du flux

**Priorité P1 pour la propagation des erreurs, P2 pour la rétention des ressources.** [syncHelpers.js ligne 55](../src/services/download/syncHelpers.js#L55) utilise `response.data.pipe(writer)` et attend seulement `finish` ou `error` sur le writer. Le flux source n'a pas de gestion d'erreur dans ce helper et n'est pas détruit si l'écriture ou la préparation du dossier échoue.

Trois résultats sont reproduits :

- Une erreur source `AUDIT_SOCKET_RESET` remonte comme erreur non interceptée ; la promesse attend toujours le writer.
- Une erreur d'écriture `AUDIT_DISK_FULL` rejette la promesse, mais le flux source reste ouvert et non détruit.
- Une erreur `ensureDir` après réception des headers rejette aussi sans détruire le flux source.

Le diagnostic intercepte volontairement l'erreur non gérée pour inspecter l'état. En production sans handler `uncaughtException`, cette erreur peut arrêter Node et provoquer un redémarrage PM2. Elle ne doit pas être présentée comme une fuite lente certaine. Les autres branches peuvent garder une réponse HTTP, ses buffers et sa socket jusqu'à leur fermeture ultérieure. Le seul fait qu'une promesse soit pending ne prouve pas sa rétention permanente.

Utiliser `node:stream/promises.pipeline(response.data, writer)` pour propager les erreurs et détruire les flux. Créer le dossier avant d'ouvrir la réponse HTTP, ou garantir la destruction de celle-ci dans le traitement d'erreur. Vérifier aussi la clôture prématurée, l'annulation et un délai global couvrant le transfert complet. Appliquer la même discipline à `hashFile`, dont les handlers rejettent sans détruire explicitement l'autre côté du pipe.

### Flux CSV dont les erreurs de lecture ne rejoignent pas le loader

**Priorité P1 pour la robustesse, P2 pour les ressources sur échec.** [dataLoader.js ligne 86](../src/services/dataLoader.js#L86) conserve le parser obtenu après `.pipe(...)`, mais ne conserve pas le ReadStream source pour l'annuler et ne lui attache aucun handler d'erreur. `pipe` ne propage pas automatiquement toutes les erreurs de sa source vers sa destination.

L'injection d'une erreur du ReadStream produit une erreur non gérée `AUDIT_CSV_READ_FAILURE`, tandis que `loadData()` reste pending dans le diagnostic. Si l'indexeur ou le consommateur s'arrête avant la fin du CSV, le code ne garantit pas non plus la destruction du lecteur initial.

Conserver les deux flux et utiliser un pipeline coordonné avec la consommation async, ou un `try/finally` détruisant les deux côtés avec propagation de l'erreur source. Le correctif doit vérifier que la lecture et l'indexation terminent ou rejettent ensemble, avec une backpressure conservée.

### Descripteur vétérinaire oublié après une erreur de lecture du header

**Priorité P2, chemin d'erreur confirmé.** [loadPipeline.js ligne 274](../src/services/vet/loadPipeline.js#L274) ouvre un descripteur avec `openSync`, puis le ferme après `readSync`. Si la lecture échoue, le `catch` renvoie `null` avant `closeSync`.

L'injection de l'erreur ouvre **un descripteur et n'en ferme aucun**, tandis que le loader continue avec la date du fichier. Des erreurs répétées accumulent des descripteurs et des ressources noyau. Les rechargements normaux testés n'en perdent pas.

Déclarer le descripteur hors du `try`, puis le fermer dans un `finally` dès que l'ouverture a réussi. Ce changement doit préserver le fallback de metadata.

### Planificateur autorisant des rafraîchissements superposés

**Priorité P2, amplificateur conditionnel.** [server.js ligne 120](../src/server.js#L120) programme deux callbacks async par `setInterval`, sans attendre le précédent et sans verrou. L'injection d'un downloader qui ne termine pas permet de démarrer **trois rafraîchissements simultanés** du même domaine.

À l'intervalle par défaut de 72 heures, le chevauchement exige une opération très longue ou bloquée. Les défauts de flux précédents et les configurations courtes augmentent ce risque. Un chevauchement conserve plusieurs contextes de téléchargement et d'indexation, peut multiplier les buffers et utilise les mêmes fichiers temporaires. Les loaders vident et remplissent des tableaux partagés ; leurs commentaires d'atomicité décrivent le reset synchrone, pas l'ensemble du rechargement async.

Utiliser un rafraîchissement unique en cours par domaine, avec le prochain `setTimeout` programmé après la fin du cycle dans un `finally`. Protéger aussi le chargement vétérinaire différé et les appels publics concurrents aux loaders. Une promesse partagée de chargement convient si les callers doivent attendre le même résultat. Un remplacement atomique du corpus est une amélioration distincte, avec un pic mémoire temporaire à budgéter.

### Débordement des durées de rafraîchissement

**Priorité P2, configuration dangereuse confirmée.** `parseIntervalHours` accepte tout entier positif, et [server.js](../src/server.js) multiplie les heures par 3 600 000. Les timers Node acceptent au maximum 2 147 483 647 millisecondes. Dès **597 heures**, le délai demandé dépasse cette borne.

La reproduction accepte 597 heures, demande **2 149 200 000 ms**, et Node transforme le délai en **1 ms** avec un avertissement `TimeoutOverflowWarning`. Couplé au défaut précédent, cela peut créer une rafale de cycles concurrents et d'allocations.

Valider la durée calculée avant `setInterval`, ou découper les longues attentes en délais autorisés. Une valeur invalide doit provoquer une erreur de configuration explicite, jamais un timer d'une milliseconde.

### Sonde Range pouvant télécharger le fichier entier

**Priorité P2, surallocation confirmée.** [remoteFileProbe.js ligne 71](../src/utils/remoteFileProbe.js#L71) utilise `responseType: 'arraybuffer'` après échec de HEAD, avec `Range: bytes=0-0` et sans borne de taille. Un serveur peut ignorer Range et retourner HTTP 200 avec le fichier complet.

Le serveur local de reproduction ignore Range et envoie **4 Mio**. La sonde lit le corps complet ; `external` passe de **2,09 à 19,76 Mio**, avec **16,14 Mio d'arrayBuffers** au point de mesure. Les chiffres incluent le serveur local et ses buffers : ils démontrent une allocation disproportionnée, et ne quantifient pas isolément la mémoire du client axios.

Cette allocation est transitoire et ne démontre pas une fuite. Elle peut néanmoins relever le RSS lors des vérifications. Utiliser une réponse streaming, lire les headers puis détruire le flux sans accumuler le corps, et borner les octets acceptés si un contenu minimal doit être consommé.

## Allocations importantes sans fuite cumulative démontrée

### Recherche large avant pagination

[corpusSearch.js ligne 87](../src/utils/corpusSearch.js#L87) appelle `index.search(query)` sans limite avant de classer toutes les correspondances et de sélectionner la page. [searchOrchestrator.js ligne 408](../src/services/searchOrchestrator.js#L408) collecte les correspondances sur plusieurs index, fusionne les clés et trie les références avant de paginer.

La limite publique de 1 000 lignes borne la réponse, pas tous les candidats, scores, Sets, Maps et tableaux intermédiaires. Une requête à un caractère avec prefix et fuzzy peut visiter une grande fraction des index. `detail=summary` agit après la sélection et l'hydratation de la page ; il réduit principalement la réponse et ne supprime pas le coût du classement.

Les essais montrent un tas collectable et un RSS restant élevé. Réduire les allocations de classement en conservant le total exact et les règles qualité puis score ; exploiter `searchPage` ou une sélection bornée seulement si cela préserve ces règles. Mesurer séparément les préfixes très courts, les fautes de frappe, les pages profondes et la recherche mixte. Une borne de longueur et de nombre de termes de `q` et des critères évite également des allocations proportionnelles à des entrées excessives. Un minimum de longueur constitue un changement de contrat à décider explicitement.

### Parsing de fichiers anormaux et diagnostics prolongés

Le lecteur XML conserve la ligne incomplète et le produit en cours, mais n'impose aucune taille maximale à [pendingLine](../src/utils/streamMedicinalProductsXml.js#L145) ou au produit. Le dictionnaire regex de `loadPipeline.js` conserve `buffer` tant qu'aucun token reconnu n'est rencontré. Le CSV ne définit pas `max_record_size`. Ces buffers sont bornés par le contenu réel, pas par une limite constante : un fichier tronqué ou une ligne géante peut provoquer une surallocation, voire un OOM, pendant un chargement. Ils deviennent collectables après retour ou rejet correctement propagé.

Sur le fichier ANMV local normal, le plus grand bloc produit après suppression des tags ignorés mesure **38 434 octets**. Définir des limites généreuses à partir des maxima observés, puis rejeter explicitement les entrées qui les dépassent. Le tableau `malformed` pourrait conserver seulement les cinq exemples affichés et un compteur total, plutôt que toutes les erreurs du fichier.

[memorySampler.js ligne 42](../src/utils/memorySampler.js#L42) ajoute un échantillon au tableau à chaque tick, sans limite. Son hook global garde le sampler accessible jusqu'à désinstallation. Il n'est pas installé par le serveur normal, donc il n'explique pas le RSS observé dans ce démarrage. Pour un profilage de plusieurs jours, employer une fenêtre bornée ou un journal sur disque, arrêter le sampler et désinstaller le hook dans un `finally`. `unref()` ne libère ni le timer ni ses données.

### Cycle de vie des serveurs et des rate limiters

`startServer()` ne retourne pas le serveur ni une fonction d'arrêt et ne garde pas les handles des intervalles. Plusieurs démarrages dans un même processus ajoutent des tâches permanentes. Avec le rate limiting activé, chaque `createApp()` crée aussi un MemoryStore et son intervalle ; fermer le serveur HTTP ne déclenche pas automatiquement `store.shutdown()`.

Le démarrage unique sous PM2 ne reproduit pas cette accumulation. Pour les usages embarqués, les tests ou des redémarrages dans le même processus, retourner un handle disposant le serveur, les timers, les chargements différés et le store. `MemoryStore` recycle ses deux Maps à chaque fenêtre : la mémoire liée aux clients expire, même si sa cardinalité n'est pas plafonnée à un nombre fixe d'IP.

## Suspects écartés dans les conditions testées

| Suspect | Conclusion appuyée par le code et les mesures |
| --- | --- |
| Cache de pagination | Une entrée par instance d'index dans une WeakMap ; les nouveaux `q` ne créent pas un historique infini. L'entrée reste liée à l'index courant et conserve seulement les priorités et métadonnées. |
| Anciens index FrozenMiniSearch | Tous les anciens index suivis disparaissent après GC hors des handlers ; 12 instances dans les deux snapshots. |
| Corpus et maps CIS ou num | Tableaux vidés, index secondaires remplacés ; 180 238 enregistrements avant et après. Les anciennes lignes ne s'accumulent pas lors des rechargements séquentiels inchangés. |
| Doubles copies par storeFields | `storeFields: []` sur les index runtime ; pas de copie intégrale du corpus via les champs stockés. |
| Parser saxes conservé | Parser et callbacks créés par produit, sans stockage global du parser. Le correctif de copie des textes ANMV du commit `4739843` est présent ; pas de multiplication des blocs XML retenus après cinq rechargements. |
| Structures de recherche FrozenMiniSearch | Maps et Sets des candidats sont propres à la requête ; structures permanentes de taille liée à l'index. Aucun cache global cumulant les recherches relevé dans 1.11.0. |
| Sockets Express sur réponses consommées | Huit connexions sous trafic, libérées au repos ; descripteurs revenus au niveau de base. Les clients lents et réponses interrompues nécessitent des essais spécifiques pour quantifier leur pic temporaire. |
| Timers de logs de plateau | Trois délais ponctuels par chargement, conservant un libellé ; ils expirent. Ils ne retiennent pas le corpus ou les index. |
| Exports JSONL | Écriture ligne par ligne avec descripteur fermé dans un finally. La sérialisation binaire peut allouer un gros Buffer transitoire, mais ces exports ne sont pas déclenchés par les routes runtime. |

Ces conclusions ne signifient pas qu'un fichier de données croissant doit garder la même empreinte : conserver davantage de lignes et d'index est une augmentation légitime de la mémoire utile.

## Diagnostic du processus de production

Le RSS couvre le tas résident, ses pages conservées, les buffers, le code compilé, les piles et d'autres allocations natives. Node n'est pas obligé de rendre immédiatement les pages au système après le GC. Un processus au repos peut aussi garder des objets morts jusqu'à la prochaine collection. L'absence de baisse du RSS ne suffit donc pas à identifier une fuite.

Comparer le **même PID**, avec une charge similaire, et conserver les séries de `rss_mb`, `heap_used_mb`, `heap_total_mb`, `external_mb`, `array_buffers_mb`, `uptime_seconds`, `reload_strategy` et `string_pool_size` de `/config`. Les relevés de santé génèrent eux-mêmes de petites allocations. `arrayBuffers` fait partie d'`external`, il ne faut pas les additionner. `non_heap_mb` vaut RSS moins heapUsed : ce champ inclut les pages inutilisées du tas et n'est pas une mesure pure de mémoire native. `maxRSS` est un maximum historique qui ne peut pas redescendre.

| Observation répétée dans le même processus | Investigation à privilégier |
| --- | --- |
| RSS monte puis plafonne, minima du tas comparables | Échauffement, pages conservées et pics d'allocations |
| Minima du tas montent à charge et données constantes | Comparaison de snapshots et chemins de rétention |
| Pool monte après chaque mise à jour dans le même processus | Anciennes générations de chaînes |
| External ou arrayBuffers montent sans stabilisation | Flux réseau ou fichiers, buffers et anciennes données d'index |
| Descripteurs, sockets ou cycles en cours s'accumulent | Nettoyage des flux et exclusion des rafraîchissements concurrents |
| Sauts corrélés aux mises à jour ou aux recherches courtes | Pics d'indexation et de recherche ; comparer avant et après GC diagnostique local |

Commencer par un relevé périodique pendant 24 à 48 heures couvrant trafic et repos, en annotant les chargements et les redémarrages. L'endpoint de santé doit être interrogé avec un timeout et les réponses écrites sur disque ou dans la supervision, sans créer un collecteur en mémoire non borné. Si les minima du tas augmentent, reproduire la charge sur une instance locale avec les mêmes fichiers et flags et capturer deux snapshots. Les snapshots sont bloquants et gourmands ; leur capture doit être budgétée sur l'instance de diagnostic.

Pour l'observation actuelle de 149 à 154 Mo, la prochaine donnée utile est l'évolution du tas et d'external sur le même PID. Déclencher des GC périodiques ou des redémarrages fréquents sur la seule base de ces 5 Mo masquerait le phénomène sans identifier une fuite.

## Reproduction locale

Depuis la racine du dépôt, avec les fichiers BDPM et ANMV déjà présents et les dépendances du lockfile installées :

```sh
# Trafic courant et rétention après GC
CORPUS_LIGHT_PROFILE=true AUDIT_TRAFFIC_MODE=normal \
  AUDIT_BATCHES=6 AUDIT_REQUESTS=600 AUDIT_IDLE_MS=10000 \
  AUDIT_OUT=tmp/memory-audit/normal-gc.json \
  node --expose-gc --max-semi-space-size=8 scripts/memory/audit-retention.js

# Inclure les recherches larges, sans GC forcé
CORPUS_LIGHT_PROFILE=true AUDIT_FORCE_GC=0 \
  AUDIT_BATCHES=8 AUDIT_REQUESTS=400 AUDIT_RELOADS=3 AUDIT_IDLE_MS=60000 \
  AUDIT_OUT=tmp/memory-audit/light-natural.json \
  node --max-semi-space-size=8 scripts/memory/audit-retention.js

# Snapshots du profil complet ; le RSS est perturbé par leur capture
AUDIT_BATCHES=3 AUDIT_REQUESTS=200 AUDIT_IDLE_MS=10000 \
  AUDIT_SNAPSHOT_DIR=tmp/memory-audit/snapshots \
  AUDIT_OUT=tmp/memory-audit/full-gc.json \
  node --expose-gc --max-semi-space-size=8 scripts/memory/audit-retention.js

# Pool changeant et erreurs de ressources dans des workers isolés
node --expose-gc scripts/memory/audit-resource-errors.js

# Avec les dépendances de développement installées normalement
RUN_SLOW_TESTS=1 npm run test:serial
```

`audit-retention.js` impose loopback, charge directement les corpus sans downloader, mesure des ressources du processus serveur et sépare le client HTTP. `AUDIT_TRAFFIC_MODE=broad` permet de concentrer un essai sur les deux recherches à un caractère. `AUDIT_RELOADS` vaut 5 par défaut. Les résultats et les logs du worker restent dans `tmp/memory-audit`.

`audit-resource-errors.js` exécute neuf scénarios isolés. L'interception des erreurs non gérées et les mocks appartiennent uniquement à ces workers de diagnostic ; ils ne doivent pas être intégrés au serveur. Les fixtures synthétiques sont créées sous le répertoire temporaire puis supprimées. Les fichiers réels du corpus ne sont pas modifiés.

## Ordre des corrections

1. Remplacer les pipes fragiles et garantir la fermeture des ressources sur toutes les erreurs ; fermer le descripteur de header dans un finally.
2. Garantir un seul rafraîchissement et chargement en cours par domaine, puis valider les durées des timers.
3. Donner une durée de vie ou une capacité maximale au pool ; tester trois générations changeantes et un rechargement échoué.
4. Supprimer le corps non borné de la sonde Range ; borner les buffers de parsing selon les volumes réels.
5. Réduire les allocations des recherches larges en conservant les contrats de classement et de total ; mesurer à nouveau le trafic et le plateau RSS.

Pour vérifier un correctif, tester ses chemins d'erreur et la libération effective des ressources, puis rejouer les charges existantes. Le critère n'est pas un RSS qui descend après chaque requête : c'est l'absence d'accumulation des objets utiles, des générations obsolètes et des ressources à travail comparable.
