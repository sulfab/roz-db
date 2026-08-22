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
| Noms des cartes | `data/mapnametable.txt` | dans le client |
| Mob → carte, population, niveau | `navigation/navi_mob_*.lub` | dans le client |
| **Tables de drop et taux** | — | **absentes** |
| Stats des mobs (HP, race, élément) | — | **absentes** |

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

### Relever l'encyclopédie en jeu

C'est la source la plus fidèle à Zero Global : c'est celle du serveur lui-même.

```bash
npm run sniff                      # capture pendant que tu joues, Ctrl+C pour arrêter
npm run analyze -- captures/…      # cherche les tables de drop, écrit un CSV
npm run import-drops -- captures/drops.csv --source "encyclopédie" --base 10000
```

La capture est **passive** : elle lit le trafic réseau, sans jamais toucher au processus du
jeu, sans rien injecter ni modifier. Elle pilote `dumpcap`/`tshark` — installe Wireshark
(avec Npcap) sous Windows — et détecte seule la connexion du jeu via le processus Ragnarok.
Le fichier reste sur ta machine. Les CGU de Gravity interdisent largement les outils tiers ;
une écoute passive de son propre trafic n'est pas de la triche, mais l'appréciation leur
appartient.

**L'analyse ne suppose aucun format de paquet.** Il n'est pas public, et le deviner
produirait des chiffres faux sans qu'on s'en aperçoive. Une table de drop, quel que soit son
enrobage, est une suite d'enregistrements de taille constante contenant chacun un
identifiant d'item valide — et le client vient de nous donner la liste exacte des items et
des mobs qui existent. `analyze-capture.mjs` cherche cette régularité, déduit le pas des
enregistrements, la largeur des champs, la position du taux et l'identifiant du mob qui
précède, puis propose l'échelle des taux. Il affiche ce qu'il a déduit : **vérifie deux ou
trois lignes en jeu avant d'importer.**

Si rien n'est trouvé, l'analyseur le dit et distingue les cas : trafic TLS (illisible),
ou contenu compressé par le jeu. `--raw flux.bin` écrit le flux brut pour inspection.

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

**Le bytecode Lua est exécuté, pas décompilé.** Les clients récents ne livrent plus une
seule table en clair : `itemInfo`, `npcidentity`, `jobname`, toute la navigation sont du
bytecode Lua 5.1. Décompiler redonnerait du source qu'il faudrait reparser ; `luac.mjs`
va plus court en *exécutant* le chunk dans une petite machine virtuelle et en récupérant
les globales qu'il a définies — ces fichiers sont de la donnée, ils construisent des tables
et s'arrêtent. Les fonctions attendues du client (`main()` appelle `AddItem`) sont absentes :
elles sont notées et ignorées, la table est déjà construite. `luadata.mjs` masque la
différence, les parseurs ne savent pas s'ils lisent du source ou du bytecode.

**Le VFS respecte la priorité du client.** Un fichier en clair dans `data/` prime sur les
archives, et l'ordre des `.grf` suit `DATA.INI`. Sans ça on lirait des données périmées là
où le jeu, lui, lit la version patchée.

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

**`fichier chiffré en DES`** — rare, et non géré. Extrais-le avec GRF Editor vers un dossier
`data/` à côté du client ; l'extraction le lira de là.

**Accents et caractères cassés** — l'encodage est détecté automatiquement (CP949 des clients
coréens, UTF-8 des repacks). En cas de doute : `npm run extract -- --encoding cp949`.

**« structure inattendue » ou « impossible de déduire les colonnes »** — le fichier n'a pas
la forme attendue sur ce client. `npm run dump -- "<chemin du fichier>"` décrit ce qu'il
contient réellement : tables construites, largeur des lignes, exemples. C'est ce qu'il faut
pour caler le parseur sans deviner.

## Développement

```bash
npm test          # 53 tests : lecteur GRF, parseur Lua, parsers, extraction bout en bout
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
  sniff.mjs     capture passive du trafic du jeu (pilote dumpcap/tshark)
  pcap.mjs      lecture pcap/pcapng + réassemblage TCP
  analyze-capture.mjs  déduit les tables de drop dans une capture
  icons.mjs     BMP → PNG
  import-drops.mjs
src/            application React (Vite, TypeScript)
test/           tests node:test
```

Les JSON produits sont documentés par les types de [`src/types.ts`](src/types.ts).
