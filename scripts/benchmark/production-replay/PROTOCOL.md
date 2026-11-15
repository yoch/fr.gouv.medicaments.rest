# Protocole de décision

## Questions distinctes

1. À arguments identiques, B1/B2 retrouvent-ils mieux les identités et variantes que B0 ?
2. Les arguments formulés par l'agent conservent-ils la demande explicite du dernier message ?
3. Les réponses historiques observées étaient-elles documentaires utiles à l'époque ?

Ces trois évaluations n'utilisent pas le même contexte ni la même vérité. La version 1 implémente le rejeu comparatif pour 1, des packets d'audit séparés pour 2, et la lecture des réponses historiques pour calibrer le juge de 3. Elle ne reconstruit pas les snapshots historiques ni la politique séquentielle de l'agent après une réponse différente.

## Unités / exclusions

Une ligne source = un appel d'outil dédupliqué par tool_call_id. Un cas de retrieval = un dictionnaire exact d'arguments, avec poids égal au nombre d'appels représentés. Un groupe de fuite = composante connectée de requêtes normalisées identiques (y compris critères différents), dernier message identique et conversations reliées en mode exact. Ne pas employer run_candidate ni count_mismatch comme liens fiables. Les liens exacts restent heuristiques, comme le dit le README source.

125 appels de disponibilité sont isolés : la disponibilité est temporelle, l'absence d'alerte n'est pas l'absence d'un médicament. Une recherche avec arguments invalides n'est pas un échec de retrieval. Les recherches historiques en erreur serveur ou non exécutées restent rejouables lorsque leurs arguments sont valides, mais ne comptent pas dans le taux historique de réponses vides.

## Limites de représentativité

L'extraction provient de error.log*, et uniquement des tools LangGraph. Elle ne décrit pas tous les usages HTTP de l'API ni tous les utilisateurs. La fréquence d'appels dépend aussi des reformulations et du comportement du modèle générateur. Rapporter à la fois requêtes uniques et poids de trafic. Les sessions étant incomplètes, pas d'inférence causale sur le nombre d'essais nécessaires à un succès utilisateur. Le changement de modèle générateur et les formats JSON/Markdown peuvent être des facteurs de distribution ; conserver ces strates privées.

Les horodatages anciens sont approximatifs. Le découpage livré est par groupes déterministes, pas temporel. Il bloque certaines fuites évidentes mais ne garantit pas des familles de médicaments inédites. Une validation temporelle ultérieure utilisera une nouvelle extraction, avec protocole figé à l'avance.

## LLM : assistant d'annotation, pas oracle

Les preuves documentaires du snapshot fixent ce qui peut être jugé. Le juge n'invente pas les indications, contre-indications, disponibilités actuelles ou équivalences. Il n'utilise pas les flags produits par le moteur comme preuve. Les passages source cités doivent exister littéralement dans la fiche ; cette vérification est automatique, mais elle ne prouve pas que la citation justifie la note, d'où la calibration indépendante.

Les grades sont ordinaux 0..3 ou indéterminés. Une contradiction documentaire n'est pas une conclusion sur un risque thérapeutique. Une réponse apparemment plausible mais sans preuve n'est pas un positif certain. Une réponse vide commune à tous les moteurs n'est pas une preuve d'inexistence.

Le juge principal ne voit pas le classement ni les noms de systèmes. Les candidats sont dédupliqués, mélangés, puis une fraction est inversée. Les désaccords d'ordre sont écartés des classements évaluables et envoyés en revue. Un deuxième modèle indépendant sert d'abord à la calibration et aux cas ambigus. Le même modèle que le générateur n'est pas automatiquement interdit, mais un second juge différent est préférable pour déceler des biais corrélés.

## Préenregistrement avant test final

Conserver code SHA, snapshot complet, contrat du wrapper, seed et partitions, rubric/schema hashes, modèle et révision du juge, params, limites, pool top-k, stratégie d'admissibilité et fréquence de double jugement. Un ajustement majeur de la rubrique après consultation du test consomme ce test : ne pas le rebaptiser « inédit ».

Les seuils de promotion métier sont à décider AVANT ouverture du test. Proposition : aucune régression confirmée sur les codes exacts et la source ; aucune hausse de fausses satisfactions de dose/forme/voie sur les cas vérifiés ; amélioration documentée du Top-1/variantes avec couverture publiée ; budget de latence/mémoire fixé par l'exploitation. Les défauts critiques revus humainement priment sur une hausse moyenne de nDCG.

Pas de conclusion statistique à partir d'un simple intervalle LLM : le bootstrap ne valide ni la rubrique, ni la justesse du juge, ni la représentativité des logs. Conserver tous les cas exclus et comparer les dénominateurs.

## Sécurité / conservation

Aucun artefact réel dans le code public. Les exports privés de requêtes et de réponses ne sont pas anonymes par défaut. L'envoi distant exige un opérateur autorisé, un fournisseur accepté et le hash du fichier effectivement revu. Pas de clé dans un fichier ou dans un argument URL. Ne pas journaliser les corps d'erreur d'API. Le banc refuse les redirects et les proxies implicites lors du jugement.

Les snapshots et tableaux de référence sont privés ; les contrôles de code peuvent être publics s'ils n'incluent que des fixtures synthétiques. La réduction des données personnelles est préférée à une anonymisation supposée par regex.

## Références de méthode (pas sources de vérité pharmaceutique)

- Zheng et al., *Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena*, arXiv:2306.05685 : biais de position, de verbosité et autres limites du jugement LLM.
- Documentation officielle OpenAI, *Structured model outputs* : le JSON Schema stabilise la forme, pas la véracité des réponses ; gérer les refus et sorties incomplètes.
- README et summary fournis avec l'extraction : provenance, grain, formats et limites de rattachement des sessions.
