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

C'est la source la plus fidèle à Zero Global, puisque c'est celle du serveur lui-même.
Elle demande une capture côté client (paquets ou relevé écran), que cet outil ne fait pas
encore : il n'y a pas de format public à parser à l'aveugle. La marche à suivre :
produire un `drops.csv` au format ci-dessus, par quelque moyen que ce soit, puis
`import-drops`. Envoie-moi un échantillon de capture et j'écris le parseur qui va avec.

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

**Aucun mob, aucune zone** — le client n'a pas de `navi_mob_*.lub`, ou ils sont compilés.
`npm run scan` le dit ; l'app reste utilisable pour les items.

## Développement

```bash
npm test          # 44 tests : lecteur GRF, parseur Lua, parsers, extraction bout en bout
npm run build     # typecheck + build statique
```

Les tests fabriquent un vrai client synthétique (archive GRF valide en 0x200 et 0x300,
tables texte) et font tourner toute la chaîne dessus : rien n'exige d'avoir le client sous
la main. Les fixtures de bytecode (`test/fixtures/*.lub`) sont produites par le vrai
`luac 5.1`, leurs sources `.lua` sont à côté — tester la VM contre un bytecode que j'aurais
assemblé moi-même n'aurait rien prouvé.

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
  icons.mjs     BMP → PNG
  import-drops.mjs
src/            application React (Vite, TypeScript)
test/           tests node:test
```

Les JSON produits sont documentés par les types de [`src/types.ts`](src/types.ts).
