# ROZ DB — base locale Ragnarok Zero

Application locale qui croise **items, mobs, cartes et drops** extraits de ton client
Ragnarok Zero. Depuis un item tu vois qui le droppe, à quel taux et sur quelle carte ;
depuis un mob, ce qu'il lâche et où il vit ; depuis une carte, tout ce qui peut y tomber.

Tout tourne en local : pas de serveur, pas de compte, pas de réseau.

## Démarrage

```bash
npm install
npm run extract -- --client "C:\Gravity\Ragnarok Zero"   # lit le client, écrit public/data/*.json
npm run icons                                            # optionnel : icônes des items
npm run dev                                              # http://localhost:5174
```

Le chemin du client est mémorisé dans `.client-path` : les fois suivantes, `npm run extract`
suffit. Pour un build statique : `npm run build`, puis ouvrir `dist/` avec n'importe quel
serveur de fichiers.

Avant la première extraction, un inventaire du client dit ce qui est exploitable :

```bash
npm run scan -- "C:\Gravity\Ragnarok Zero"
```

Il liste les archives, les fichiers attendus et leur état — `[v]` exploitable, `[!]` illisible,
`[x]` absent. Le rapport complet part dans `scan-report.json`. Le chemin du client est mémorisé
dès la première commande qui le reçoit : `npm run extract` seul suffit ensuite.

## Ce que le client contient — et ce qu'il ne contient pas

| Donnée | Source | État |
| --- | --- | --- |
| Noms, descriptions, slots des items | `System/itemInfo*.lub` + `data/idnum2item*table.txt` | dans le client |
| Icônes des items | `data/texture/…/item/<res>.bmp` | dans le client |
| Ids et sprites des mobs | `datainfo/npcidentity.lub`, `datainfo/jobname.lub` | dans le client |
| Noms des cartes | `data/mapnametable_<langue>.txt` | dans le client |
| Mob → carte | `navigation/navi_mob*.lub`, joint par le sprite | dans le client |
| Population et niveau des mobs | selon le client — souvent absents | variable |
| **Libellés d'items localisés** | — | **absents** |
| **Tables de drop et taux** | — | **absentes** |
| Stats des mobs (HP, race, élément) | — | **absentes** |

Sur Ragnarok Zero, la seule base d'items du client (`datainfo/iteminfo.lub`, 3,3 Mo) est en
coréen, et aucune variante localisée n'existe — vérifié en listant les 127 fichiers `_frfr`
du client. Les libellés français ou anglais viennent donc du serveur, comme les drops.

Dans le RO officiel, les drops et les stats sont côté serveur : l'encyclopédie en jeu les
reçoit par paquet, elle ne les lit pas sur le disque. L'app fonctionne entièrement sans
elles — les colonnes de taux restent simplement vides — et les accepte dès qu'une source
est branchée.

## Tables de drop

N'importe quelle source se ramène à des triplets `(mob, item, taux)` :

```bash
# CSV : mobId,itemId,taux   (en-tête optionnelle)
npm run import-drops -- drops.csv --source "encyclopédie in-game" --base 10000
```

- `--base 100` (défaut) : le taux est un pourcentage — `70` = 70 %.
- `--base 10000` : échelle des bases serveur — `7000` = 70 %.
- Le JSON est accepté aussi : `[{ "mob": 1002, "item": 909, "chance": 70 }]` ou
  `{ "1002": [{ "item": 909, "chance": 70 }] }`.
- Les imports **fusionnent** par défaut (`--replace` pour repartir de zéro), et
  `npm run extract` n'écrase jamais `drops.json`.

### Alimenter la base en jouant

```bash
npm run build          # une fois, pour que l'overlay puisse être servi
npm run watch          # terminal administrateur, AVANT de lancer le jeu
```

La boucle capture par morceaux de 45 s, lit chacun, et verse ce qu'elle a compris dans
`public/data/observations.json`. Elle reprend là où la session précédente s'était arrêtée.
Rien ne quitte la machine.

Ce qu'elle apprend, et qui n'est **nulle part** dans le client :

| | source | pourquoi le client ne l'a pas |
|---|---|---|
| espèces présentes sur une carte | paquets d'apparition | le client ne connaît que les tables de spawn, pas ce qui est là |
| **nom localisé d'un monstre** | réponse du serveur | il ne l'envoie que si le client le demande — donc si tu le **survoles** |
| objets tombés après une mort | paquets au sol | le serveur envoie ce qui tombe, jamais la probabilité |

Les morceaux de capture vivent dans un dossier temporaire et disparaissent une fois lus —
une session de plusieurs heures remplirait le disque sinon. Pour garder de quoi analyser un
paquet qu'on ne sait pas encore lire :

```bash
npm run watch -- --brut captures/flux.bin    # le flux du serveur, bout à bout
npm run analyze -- captures/flux.bin         # relecture hors ligne
```

**Un taux observé n'est pas le taux officiel.** C'est un comptage : tant de fois l'objet, sur
tant de morts. Le fichier garde toujours les deux nombres, jamais le seul pourcentage, et
l'affichage prévient tant que les morts observées se comptent sur les doigts.

**Surimpression toujours au-dessus.** L'écran *Surimpression* de l'app affiche en temps réel
les espèces de la carte où tu es, cliquables pour voir leur butin. Le bouton « toujours
au-dessus » ouvre une fenêtre d'incrustation Chrome, qui reste par-dessus le jeu sans outil
externe ni droits d'administrateur — joue en **fenêtre sans bordure**, un plein écran exclusif
passe devant tout, y compris elle.

### Relever l'encyclopédie en jeu

C'est la source la plus fidèle à Zero Global : c'est celle du serveur lui-même.

```bash
npm run sniff                      # capture pendant que tu joues, Ctrl+C pour arrêter
npm run analyze -- captures/…      # cherche les tables de drop, écrit un CSV
npm run import-drops -- captures/drops.csv --source "encyclopédie" --base 10000
```

La capture est **passive** : elle lit le trafic réseau, sans jamais toucher au processus du
jeu, sans rien injecter ni modifier. Elle détecte seule la connexion du jeu via le processus
Ragnarok, et le fichier reste sur ta machine.

Sous Windows, **rien à installer** : `pktmon` est livré avec Windows 10 et 11, il suffit
d'ouvrir le terminal en administrateur. L'outil s'en sert en priorité, capture vers un `.etl`
puis le convertit lui-même en pcapng. `dumpcap`/`tshark` (Wireshark, avec Npcap) et `tcpdump`
restent utilisables — `--tool wireshark` pour forcer. Les CGU de Gravity interdisent largement les outils tiers ;
une écoute passive de son propre trafic n'est pas de la triche, mais l'appréciation leur
appartient.

**Le seuil de reconnaissance est calculé, pas choisi.** Un client de 9 646 items occupe 15 %
des valeurs 16 bits : une valeur quelconque a une chance sur sept d'être un « item valide »,
et quatre coïncidences alignées dans quelques kilo-octets sont attendues des dizaines de
fois. L'analyseur calcule donc, à partir de la densité de l'oracle et de la taille des
données, le nombre d'entrées consécutives au-delà duquel le hasard produirait moins d'une
fausse table sur cent — huit entrées pour un oracle dense en 16 bits, trois seulement en
32 bits où l'espace est immense. Il rejette aussi les tables où un identifiant se répète :
une table de drop ne liste pas deux fois le même objet.

**Le trafic du jeu est en clair.** Ce n'était pas acquis : on a d'abord cherché les tables
de drop à l'aveugle, en supposant le contenu illisible. Une capture réelle a tranché. Elle se
découpe en paquets — un numéro sur deux octets, puis un contenu de longueur déterminée par ce
numéro — et 47 paquets s'y enchaînent sans trou. La preuve n'est pas le découpage lui-même,
qui pourrait être une coïncidence, mais ce qu'il fait tomber juste : le nom du personnage
apparaît **entier, exactement en queue** des paquets d'apparition, trois fois de suite, à des
positions que rien dans l'algorithme ne cherchait.

La difficulté restante est connue : la longueur d'un paquet dépend de son numéro, et la table
qui les relie n'est pas publique. `tools/packets.mjs` répond en deux temps — les longueurs
vérifiées sur du trafic réel sont écrites en dur, **et les autres se déduisent de la capture
elle-même** : une longueur juste fait retomber le flux sur des paquets déjà connus, une
longueur fausse le désynchronise aussitôt. Quand deux longueurs font aussi bien, l'outil ne
tranche pas et s'arrête : mieux vaut 86 % du flux lu que 100 % découpé au hasard.

De là, `npm run analyze` nomme ce qu'il lit au lieu de le deviner : espèces de monstres
croisées, pseudonymes lus en clair, paquets portant des identifiants d'objets. La position de
la classe du monstre dans le paquet dépend de la version du client : elle est **déduite** en
cherchant le seul décalage où toutes les apparitions tombent sur un monstre que le client
connaît — et l'outil dit combien de décalages le hasard produirait, pour qu'on sache quand
ne pas le croire.

**Un oracle dense ne prouve rien.** Les identifiants d'objets s'étalent de 500 à 20 000 ;
un champ qui ne contient jamais que de petits nombres tombe dans une zone où l'oracle est
presque plein, et « c'est un objet connu » n'y apprend plus rien. C'est la densité **locale**,
sur l'intervalle réellement rencontré, qui décide — sans quoi les paquets de dégâts
ressortaient comme des tables de drop.

**L'analyse statistique ne suppose aucun format de paquet.** Il n'est pas public, et le deviner
produirait des chiffres faux sans qu'on s'en aperçoive. Une table de drop, quel que soit son
enrobage, est une suite d'enregistrements de taille constante contenant chacun un
identifiant d'item valide — et le client vient de nous donner la liste exacte des items et
des mobs qui existent. `analyze-capture.mjs` cherche cette régularité, déduit le pas des
enregistrements, la largeur des champs, la position du taux et l'identifiant du mob qui
précède, puis propose l'échelle des taux. Il affiche ce qu'il a déduit : **vérifie deux ou
trois lignes en jeu avant d'importer.**

Si rien n'est trouvé, l'analyseur le dit et distingue les cas : trafic TLS (illisible),
ou contenu compressé par le jeu. `--raw flux.bin` écrit le flux brut pour inspection, et
`npm run analyze -- flux.bin` sait relire un flux brut aussi bien qu'une capture.

**Lance la capture avant le jeu.** Une session produit des centaines de kilo-octets ; une
capture démarrée après la connexion en attrape quelques-uns et ne contient que des
déplacements. L'analyseur le dit quand c'est le cas, plutôt que de conclure sur trop peu.

**Les noms des monstres ne sont pas dans le paquet d'apparition.** Celui-ci porte la classe
du monstre, pas son nom : le serveur ne l'envoie que lorsque le client le demande, c'est-à-dire
quand tu **survoles ou cibles** le monstre. Pour relever les noms d'une carte, il faut donc
les survoler ; les traverser suffit à relever les espèces présentes.

## Comment ça marche

```
client RO ──► tools/grf.mjs ──┐
              (archives .grf) │
                              ├─► tools/vfs.mjs ──► parsers ──► public/data/*.json ──► app React
data/ en clair ───────────────┘   (priorité comme     │
                                   dans le client)    ├─ items.mjs  itemInfo.lub + tables texte
                                                      ├─ mobs.mjs   npcidentity + jobname
                                                      ├─ navi.mjs   spawns (colonnes déduites)
                                                      └─ tables.mjs tables texte du client
```

Trois points méritent d'être connus :

**Le fichier d'items est cherché, pas supposé.** Sur Ragnarok Zero,
`System/itemInfo_true.lub` ne fait que 162 octets — un talon — tandis que la vraie base est
`datainfo/iteminfo.lub`, 3,3 Mo. L'extraction essaie donc **tous** les chemins connus, puis
les fichiers dont le nom évoque les items, puis les plus gros fichiers Lua du client, et
traite les candidats du plus gros au plus petit. Une lecture qui échoue est signalée, jamais
avalée. La table est reconnue sur deux niveaux de preuve : des champs connus
(`identifiedDisplayName`…), ou, à défaut, la seule forme — beaucoup d'identifiants dans la
plage des items associés à des objets ou à des chaînes. Dans ce second cas les champs sont
identifiés **par leurs valeurs** — un nom est une chaîne présente partout et presque toujours
différente, un nombre de slots un petit entier, une description une liste de lignes — et la
déduction est annoncée dans les avertissements, à vérifier sur deux ou trois items. Une
table indexée par identifiant d'item n'est retenue que si un champ ressemble vraiment à un
libellé — présent partout et presque toujours différent ; sans ce garde-fou, les propriétés
d'équipement passaient pour une base de noms, leur champ le plus varié n'étant qu'une
catégorie. Et les candidats plus gros que celui retenu sont listés avec la raison de leur
écart : c'est souvent là qu'est la vraie base.

**Le bytecode Lua est exécuté, pas décompilé.** Les clients récents ne livrent plus une
seule table en clair : `itemInfo`, `npcidentity`, `jobname`, toute la navigation sont du
bytecode Lua 5.1. Décompiler redonnerait du source qu'il faudrait reparser ; `luac.mjs`
va plus court en *exécutant* le chunk dans une petite machine virtuelle et en récupérant
les globales qu'il a définies — ces fichiers sont de la donnée, ils construisent des tables
et s'arrêtent. Les fonctions attendues du client (`main()` appelle `AddItem`) sont absentes :
elles sont notées et ignorées, la table est déjà construite. Beaucoup de fichiers officiels
se contentent de **définir** `main()` sans l'appeler — c'est le client qui le fait : la VM
l'appelle donc aussi, sans quoi le fichier s'exécute sans rien produire. Et un fichier qui
écrit dans une table posée par un autre fichier ne fait pas échouer l'exécution : la table
manquante est créée. `luadata.mjs` masque la différence, les parseurs ne savent pas s'ils
lisent du source ou du bytecode.

**Le VFS respecte la priorité du client.** Un fichier en clair dans `data/` prime sur les
archives, et l'ordre des `.grf` suit `DATA.INI`. Sans ça on lirait des données périmées là
où le jeu, lui, lit la version patchée.

**Le mob est retrouvé par son sprite.** Sur Ragnarok Zero, les fichiers de navigation ne
contiennent ni identifiant de mob, ni niveau, ni population : seulement `{ carte, nom, sprite }`
(la table s'appelle d'ailleurs `Navi_Mob_strings`). Le lien mob ↔ carte se reconstruit en
joignant le sprite sur `jobname.lub`, qui donne la correspondance sprite → identifiant. Les
lignes dont le sprite est inconnu sont comptées et signalées, jamais perdues en silence.
Quand la population n'est pas dans le client, l'app affiche **présent** et non un nombre :
inventer un `1` le ferait passer pour une mesure.

**La langue prime sur la taille**, et le suffixe ne suffit pas. Les fichiers de données existent souvent en plusieurs
langues, suffixées (`_frfr`, `_enus`, `_kokr`) ; la version sans suffixe est l'originale, en
coréen — mais un suffixe ne garantit rien : `navi_mob_frfr.lub` contient du coréen. C'est
donc le contenu qui tranche. Pour les items, les mobs et les cartes, l'extraction essaie
d'abord la langue demandée
(`--language`, `frfr` par défaut), puis l'anglais. Et elle mesure la part de libellés en
alphabet latin : une table lisible passe devant une table plus fournie mais illisible. Quand
aucune variante lisible n'existe, c'est dit — pas affiché en silence.

**Le nom affiché est celui qu'on peut lire.** Les fichiers de langue contiennent souvent des
noms coréens, y compris dans la variante `frfr`. Un nom non latin est alors remplacé par le
sprite mis en forme (`DRAINLIAR` → `Drainliar`), le nom d'origine restant disponible et
cherchable. `--language enus` si ton client a une variante anglaise utilisable.

**Une seule langue de navigation est lue.** Le client livre le même jeu de spawns en 19
langues (`navi_mob_frfr.lub`, `navi_mob_enus.lub`, …). Les lire toutes multiplierait chaque
population par 19 : l'extraction n'en retient qu'une — le français par défaut, puis l'anglais,
puis le fichier sans suffixe. `--language enus` pour changer ; le fichier retenu est affiché
en fin d'extraction et dans l'écran **Données**.

**Les colonnes des fichiers de navigation sont déduites, pas supposées.** Leur ordre change
d'une version à l'autre. `navi.mjs` identifie la carte et l'id du mob par recoupement avec
les données déjà extraites, puis sépare *niveau* et *population* par un critère simple : le
niveau d'un mob est le même partout, sa population varie d'une carte à l'autre. Le résultat
et sa confiance sont affichés dans l'écran **Données** de l'app — c'est là qu'il faut
regarder si un chiffre paraît faux.

## Quand ça coince

**Archive refusée** — le client Ragnarok Zero s'écarte du GRF classique sur deux points :
la signature annonce `Event Horizon` au lieu de `Master of Magic`, et la version est `0x300`
(en-tête de table de 12 octets au lieu de 8). Le lecteur ne code aucun de ces détails en dur :
il cherche le flux compressé autour de l'offset de table et retient le décalage qui décompresse
réellement, puis choisit la disposition des entrées (offset 32 ou 64 bits) sur celle dont les
valeurs restent cohérentes avec la taille du fichier. `npm run scan` affiche ce qu'il a retenu.
Si une archive reste refusée : `npm run probe -- "C:/Gravity/RagnarokZero/data.grf"` distingue
« format inconnu » de « contenu chiffré » et affiche de quoi caler le lecteur.

**Entrées chiffrées dans l'archive** — certaines entrées, dont la base d'items de Ragnarok
Zero, sont chiffrées avec une variante de DES : permutations standard, un seul tour, aucune
clé. Selon le drapeau de l'entrée, tout le fichier est traité ou seulement son en-tête, et
au-delà des vingt premiers blocs un bloc sur *n* est chiffré tandis qu'un sur sept est
simplement brouillé — l'écart *n* se déduit du nombre de chiffres de la taille compressée.
C'est géré : `tools/des.mjs`. Le contenu déchiffré étant décompressé juste après, un
déchiffrement faux ne passe pas inaperçu, zlib le rejette.

**Accents et caractères cassés** — l'encodage est détecté automatiquement (CP949 des clients
coréens, UTF-8 des repacks). En cas de doute : `npm run extract -- --encoding cp949`.

**Un fichier attendu est introuvable** — `npm run find -- item` liste tout ce qui, dans le
client, contient ce motif dans son chemin, trié par taille. C'est ce qui répond à « ce
fichier existe-t-il, et sous quel nom ? » sans avoir à deviner.

**« structure inattendue » ou « impossible de déduire les colonnes »** — le fichier n'a pas
la forme attendue sur ce client. `npm run dump -- "<chemin du fichier>"` décrit ce qu'il
contient réellement : tables construites, largeur des lignes, exemples. C'est ce qu'il faut
pour caler le parseur sans deviner.

## Développement

```bash
npm test          # 73 tests : lecteur GRF, parseur Lua, parsers, extraction bout en bout
npm run build     # typecheck + build statique
```

Les tests fabriquent un vrai client synthétique (archive GRF valide en 0x200 et 0x300,
tables texte) et font tourner toute la chaîne dessus : rien n'exige d'avoir le client sous
la main. Les fixtures de bytecode (`test/fixtures/*.lub`) sont produites par le vrai
`luac 5.1`, leurs sources `.lua` sont à côté — tester la VM contre un bytecode que j'aurais
assemblé moi-même n'aurait rien prouvé. Même principe pour `test/fixtures/capture.pcap`,
écrit par un vrai `tcpdump` (`test/make-capture-fixture.mjs` le régénère).

### Structure

```
tools/          chaîne d'extraction (Node, sans build)
  grf.mjs       lecteur d'archives GRF (0x200 et 0x300)
  des.mjs       déchiffrement des entrées chiffrées d'une archive
  text.mjs      lisibilité des libellés (alphabet latin ou non)
  vfs.mjs       data/ en clair + archives, dans l'ordre du client
  lua.mjs       parseur Lua tolérant (fichiers .lub en clair)
  luac.mjs      désassemblage + VM Lua 5.1 (fichiers .lub compilés)
  luadata.mjs   point d'entrée unique : source ou bytecode, même résultat
  parsers/      items, mobs, navigation, tables texte
  extract.mjs   orchestration → public/data/*.json
  scan.mjs      inventaire du client
  client-path.mjs  chemin du client, mémorisé et partagé entre les outils
  probe-grf.mjs diagnostic d'archive GRF
  dump-lua.mjs  décrit la structure d'un .lub, pour caler un parseur
  find.mjs      cherche un fichier dans le client, par motif sur le chemin
  sniff.mjs     capture passive du trafic du jeu (pktmon, dumpcap/tshark)
  watch.mjs     capture en boucle, remplit la base, sert l'overlay
  packets.mjs   découpe le trafic en paquets du jeu, en déduisant les longueurs
  pcap.mjs      lecture pcap/pcapng + réassemblage TCP
  analyze-capture.mjs  lit une capture : paquets d'abord, statistique en filet
  icons.mjs     BMP → PNG
  import-drops.mjs
src/            application React (Vite, TypeScript)
test/           tests node:test
```

Les JSON produits sont documentés par les types de [`src/types.ts`](src/types.ts).
