#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { openClient } from './vfs.mjs'
import { resolveClientDir } from './client-path.mjs'
import { loadLua } from './luadata.mjs'
import { loadOracle, findDropTables, oracleDensity, minimumRun } from './analyze-capture.mjs'

/**
 * Cherche une table de drop dans tout le client, fichier par fichier.
 *
 * J'ai dit un peu vite que le client n'en contenait pas. C'etait fonde sur les
 * fichiers Lua du GRF, et sur eux seuls : ni l'executable, ni les fichiers
 * binaires, ni les .txt n'avaient ete regardes. Affirmer sans avoir cherche
 * n'est pas une preuve, et ce programme est la pour la produire — dans un sens
 * ou dans l'autre.
 *
 * Trois lectures, parce qu'une table peut se presenter de trois facons :
 *  - une table Lua indexee par monstre, contenant des objets ;
 *  - une suite d'enregistrements binaires reguliers, comme dans une capture ;
 *  - du texte tabule, ou l'on voit un monstre puis des objets sur la ligne.
 *
 * L'oracle du client — la liste exacte des monstres et des objets qui
 * existent — sert de juge dans les trois cas.
 */

const HELP = `
Cherche une table de drop dans tout le client.

  npm run hunt                      # tout le client
  npm run hunt -- --filtre encyclo  # seulement les chemins contenant ce mot
  npm run hunt -- --exe             # aussi les executables et DLL

Options
  -c, --client <dossier>  racine du client (defaut : celui memorise)
      --filtre <mot>      restreint aux chemins contenant ce mot
      --exe               inclut les .exe et .dll de la racine du client
      --min <n>           objets distincts minimum pour signaler  (defaut : 3)
      --tout              fouille aussi les formats qui ne peuvent rien contenir
      --binaire           cherche aussi dans les fichiers binaires (tres bruyant)
      --urls              liste plutot les adresses web que le client contacte
      --max-taille <mo>   ignore les fichiers plus gros           (defaut : 64)
      --data <dossier>    ou lire l'oracle          (defaut : public/data)
      --verbose           dit ce qu'il ouvre, y compris les echecs
`

/** Sous ce nombre d'objets distincts rattaches a un monstre, ce n'est pas une table. */
const MIN_OBJETS = 3
/** Au-dela, on ne charge pas le fichier en memoire pour le fouiller. */
const MAX_TAILLE = 64 * 1024 * 1024

function parseArgs(argv) {
  const args = { min: MIN_OBJETS, maxTaille: MAX_TAILLE }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--client' || a === '-c') args.client = argv[++i]
    else if (a === '--filtre') args.filtre = argv[++i].toLowerCase()
    else if (a === '--exe') args.exe = true
    else if (a === '--tout') args.tout = true
    else if (a === '--binaire') args.binaire = true
    else if (a === '--urls') args.urls = true
    else if (a === '--min') args.min = Number(argv[++i])
    else if (a === '--max-taille') args.maxTaille = Number(argv[++i]) * 1024 * 1024
    else if (a === '--data') args.data = path.resolve(argv[++i])
    else if (a === '--verbose') args.verbose = true
    else if (a === '--help' || a === '-h') args.help = true
    else if (!args.filtre) args.filtre = a.toLowerCase()
  }
  return args
}

/**
 * Une table Lua qui rattache un monstre a des objets.
 *
 * On ne cherche pas un nom de variable : il changerait d'une version a l'autre.
 * On cherche la forme — une cle qui est un monstre connu, une valeur qui
 * contient plusieurs objets connus.
 */
export function huntLuaTables(valeur, oracle, { min = MIN_OBJETS } = {}) {
  const trouve = []
  const vus = new Set()

  const objetsDe = (v, profondeur = 0) => {
    if (profondeur > 3) return []
    if (typeof v === 'number') return oracle.items.has(v) ? [v] : []
    if (typeof v !== 'object' || v === null) return []
    const out = []
    for (const sous of Object.values(v)) out.push(...objetsDe(sous, profondeur + 1))
    // Les cles aussi peuvent porter l'objet : { [909] = 3500 }
    for (const cle of Object.keys(v)) {
      const n = Number(cle)
      if (Number.isInteger(n) && oracle.items.has(n)) out.push(n)
    }
    return out
  }

  const visite = (v, chemin, profondeur) => {
    if (profondeur > 4 || typeof v !== 'object' || v === null) return
    if (vus.has(v)) return
    vus.add(v)

    for (const [cle, sous] of Object.entries(v)) {
      const mob = Number(cle)
      if (Number.isInteger(mob) && oracle.mobs.has(mob)) {
        const objets = [...new Set(objetsDe(sous))]
        if (objets.length >= min) trouve.push({ chemin: `${chemin}.${cle}`, mob, objets })
      }
      visite(sous, `${chemin}.${cle}`, profondeur + 1)
    }
  }

  visite(valeur, '', 0)
  return trouve
}

/**
 * Une ligne de texte ou un monstre precede plusieurs objets.
 *
 * C'est la forme des vieux `mob_db.txt` : des nombres separes par des virgules,
 * le monstre en tete, les objets et leurs taux ensuite.
 */
export function huntTextLines(texte, oracle, { min = MIN_OBJETS } = {}) {
  const trouve = []
  for (const ligne of texte.split(/\r?\n/)) {
    if (ligne.length < 20 || ligne.length > 4000) continue
    if (!estLigneDeNombres(ligne)) continue
    const nombres = [...ligne.matchAll(/\d+/g)].map((m) => Number(m[0]))
    if (nombres.length < min + 1) continue
    const mob = nombres.find((n) => oracle.mobs.has(n))
    if (!mob) continue
    const objets = [...new Set(nombres.filter((n) => n !== mob && oracle.items.has(n)))]
    if (objets.length >= min) trouve.push({ mob, objets, extrait: ligne.slice(0, 120) })
  }
  return trouve
}

/**
 * Une ligne de table est faite de nombres et de separateurs, rien d'autre.
 *
 * Sans ce garde-fou, les fichiers de traduction du client ressortaient : leurs
 * lignes contiennent du base64, ou les suites de chiffres abondent et tombent
 * dans les tranches d'identifiants. De la prose et des mots longs ne sont pas
 * une table, quels que soient les nombres qu'ils contiennent.
 */
export function estLigneDeNombres(ligne) {
  // Une longue suite de lettres et de chiffres colles : c'est du base64, ou une
  // empreinte. Un vrai fichier tabule a des noms courts entre ses nombres.
  if (/[A-Za-z0-9+/]{16,}/.test(ligne)) return false
  const chiffres = (ligne.match(/\d/g) || []).length
  return chiffres >= ligne.length * 0.3
}

const estLua = (p) => /\.(lub|lua)$/i.test(p)
const estTexte = (p) => /\.(txt|csv|xml|json|ini|conf)$/i.test(p)

/**
 * Formats dont on sait ce qu'ils contiennent, et ou une table n'a rien a faire.
 *
 * Ce n'est pas de la paresse : geometrie de carte, sprites, textures, sons et
 * videos ont des formats connus, faits d'entiers qui se suivent. Les fouiller a
 * l'aveugle noie le resultat sous des dizaines de milliers de faux — un
 * balayage complet du client a rendu 6898 "tables" pour un seul fichier de
 * terrain. --tout les rouvre si on veut en juger soi-meme.
 */
const SANS_INTERET = /\.(gnd|gat|rsw|rsm|spr|act|bik|bmp|tga|jpg|jpeg|png|gif|wav|mp3|ogg|avi|ttf|otf|pal|imf)$/i

function fouiller(nom, buf, oracle, args) {
  const resultats = []

  if (estLua(nom)) {
    try {
      const { globals, tables } = loadLua(buf, { includeTables: true })
      for (const source of [globals, ...(tables || [])]) {
        for (const hit of huntLuaTables(source, oracle, { min: args.min })) {
          resultats.push({ genre: 'lua', ...hit })
        }
      }
    } catch (err) {
      if (args.verbose) console.error(`  ${nom} : ${err.message}`)
    }
    return resultats
  }

  if (estTexte(nom)) {
    for (const hit of huntTextLines(buf.toString('latin1'), oracle, { min: args.min })) {
      resultats.push({ genre: 'texte', ...hit })
    }
    return resultats
  }

  // Binaire : sur demande seulement, et il faut savoir pourquoi.
  //
  // Le calcul de hasard suppose des octets quelconques. Un fichier reel ne
  // l'est pas : tables de sauts, listes de ressources, matrices de distances
  // sont faites de suites regulieres d'entiers, et comme les identifiants
  // d'objets sont denses par tranches, ces suites passent le seuil quel qu'il
  // soit. Un balayage du client a rendu des centaines de "tables" jusque dans
  // les DLL de Microsoft. Aucun seuil ne repare ca : c'est le modele qui est
  // faux, pas son reglage.
  if (!args.binaire) return resultats
  for (const table of findDropTables(buf, oracle, { minRun: args.seuil })) {
    if (table.count < args.min) continue
    resultats.push({
      genre: 'binaire',
      mob: table.mobId,
      objets: table.entries.map((e) => e.item),
      offset: table.offset,
      stride: table.stride,
    })
  }
  return resultats
}

/**
 * Adresses web contenues dans le client.
 *
 * Un client moderne ne garde pas tout dans ses fichiers : l'encyclopedie des
 * monstres, la boutique, les evenements sont souvent servis par une adresse
 * web appelee en cours de partie. Si une telle adresse existe, elle est ecrite
 * quelque part — dans un Lua, dans un fichier de configuration, ou en dur dans
 * l'executable. La lister, c'est repondre a la question "le client va-t-il
 * chercher ses donnees ailleurs ?" par une preuve plutot que par une opinion.
 */
const MOTIF_URL = /https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]{4,200}/g

export function huntUrls(buf) {
  const out = new Set()
  // Deux lectures. Un executable Windows range ses chaines en UTF-16 : un octet
  // utile, un octet nul. Lue telle quelle, l'adresse ne ressemble a rien, car
  // meme "http" n'y est pas d'un seul tenant. On relit donc en ne gardant qu'un
  // octet sur deux, dans les deux alignements possibles.
  for (const vue of [buf, deuxOctetsSurUn(buf, 0), deuxOctetsSurUn(buf, 1)]) {
    for (const m of vue.toString('latin1').matchAll(MOTIF_URL)) {
      const url = m[0].replace(/[.,;'")\]]+$/, '')
      if (url.length > 10) out.add(url)
    }
  }
  return [...out]
}

function deuxOctetsSurUn(buf, depart) {
  const out = Buffer.alloc(Math.max(0, Math.ceil((buf.length - depart) / 2)))
  for (let i = depart, j = 0; i < buf.length; i += 2, j++) out[j] = buf[i]
  return out
}

function listerUrls(cibles, args) {
  const parHote = new Map()
  let lus = 0
  for (const cible of cibles) {
    let buf
    try { buf = cible.lire() } catch { continue }
    if (!buf || buf.length > args.maxTaille) continue
    lus++
    if (lus % 2000 === 0) process.stdout.write(`\r  ${lus} fichiers lus...   `)
    for (const url of huntUrls(buf)) {
      let hote
      try { hote = new URL(url).host } catch { continue }
      if (!parHote.has(hote)) parHote.set(hote, new Map())
      const chemins = parHote.get(hote)
      if (!chemins.has(url)) chemins.set(url, cible.nom)
    }
  }

  process.stdout.write('\r')
  console.log(`${lus} fichiers lus, ${parHote.size} hote(s) distinct(s).\n`)
  for (const [hote, chemins] of [...parHote].sort((a, b) => b[1].size - a[1].size)) {
    console.log(`${hote}  (${chemins.size} adresse(s))`)
    for (const [url, fichier] of [...chemins].slice(0, 6)) {
      console.log(`  ${url}`)
      console.log(`      ${fichier}`)
    }
    if (chemins.size > 6) console.log(`  … et ${chemins.size - 6} autres`)
  }
  if (!parHote.size) {
    console.log("Le client ne contient aucune adresse web : il ne va chercher ses donnees")
    console.log('nulle part, tout ce qu\'il affiche vient de ses fichiers ou du serveur de jeu.')
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { console.log(HELP); return }

  const oracle = loadOracle(args.data)
  if (!args.urls && (!oracle.items.size || !oracle.mobs.size)) {
    console.error("L'oracle est vide : lance d'abord `npm run extract`.")
    console.error('Sans la liste des objets et des monstres du client, rien ne peut etre juge.')
    process.exit(1)
  }
  if (!args.urls) console.log(`Oracle : ${oracle.items.size} objets, ${oracle.mobs.size} monstres`)

  const clientDir = resolveClientDir(args.client)
  const vfs = openClient(clientDir, { verbose: args.verbose })

  const tous = vfs.list((key) => !args.filtre || key.includes(args.filtre))
  const fichiers = args.tout ? tous : tous.filter((f) => !SANS_INTERET.test(f.name))
  fichiers.sort((a, b) => b.size - a.size)
  console.log(`Fichiers : ${fichiers.length}${args.filtre ? ` (filtre « ${args.filtre} »)` : ''}` +
    (tous.length !== fichiers.length
      ? `, ${tous.length - fichiers.length} ecarte(s) : geometrie, sprites, sons, videos`
      : ''))

  // Le seuil se calcule sur tout le corpus, pas fichier par fichier. Juger
  // chaque fichier avec le meme budget de hasard, c'est accepter une fausse
  // table tous les cent fichiers — donc mille sur un client entier.
  const octets = args.urls ? 0 : fichiers.reduce((n, f) => n + Math.min(f.size, args.maxTaille), 0)
  const seuil = Math.max(
    minimumRun(octets, oracleDensity(oracle.items, 2)),
    minimumRun(octets, oracleDensity(oracle.items, 4)),
  )
  if (args.binaire) {
    console.log(`Corpus : ${(octets / 1024 / 1024 / 1024).toFixed(1)} Go — il faut ${seuil} ` +
      `entrees consecutives pour que le hasard n'en produise pas une seule.`)
  }
  args.seuil = Number.isFinite(seuil) ? seuil : null

  const cibles = fichiers.map((f) => ({ nom: f.name, lire: () => vfs.read(f.name) }))

  if (args.exe) {
    for (const nom of fs.readdirSync(clientDir)) {
      if (!/\.(exe|dll)$/i.test(nom)) continue
      const complet = path.join(clientDir, nom)
      cibles.push({ nom, lire: () => fs.readFileSync(complet) })
    }
    console.log(`Executables : ${cibles.length - fichiers.length}`)
  }

  console.log('')
  if (args.urls) { listerUrls(cibles, args); return }

  let lus = 0
  let signales = 0
  for (const cible of cibles) {
    let buf
    try { buf = cible.lire() } catch (err) {
      if (args.verbose) console.error(`  ${cible.nom} : ${err.message}`)
      continue
    }
    if (!buf || buf.length > args.maxTaille) continue
    lus++
    if (lus % 5000 === 0) process.stdout.write(`\r  ${lus} fichiers lus...   `)

    const hits = fouiller(cible.nom, buf, oracle, args)
    if (!hits.length) continue

    signales++
    process.stdout.write('\r')
    console.log(`${cible.nom}  (${hits.length} rattachement(s), ${buf.length} o)`)
    for (const hit of hits.slice(0, 5)) {
      const nomMob = oracle.mobNames?.get(hit.mob) || '?'
      console.log(`  ${hit.genre.padEnd(8)} monstre ${hit.mob} ${nomMob} -> ` +
        hit.objets.slice(0, 8).map((o) => `${o} ${oracle.itemNames?.get(o) || ''}`.trim()).join(', '))
      if (hit.extrait) console.log(`           ${hit.extrait}`)
    }
    if (hits.length > 5) console.log(`  … et ${hits.length - 5} autres`)
  }

  process.stdout.write('\r')
  console.log(`\n${lus} fichiers lus, ${signales} signale(s).`)
  if (!signales) {
    console.log('')
    console.log("Aucun fichier du client ne rattache un monstre a plusieurs objets connus.")
    console.log('Cela ne prouve pas qu\'il n\'y a rien : une table chiffree, compressee, ou')
    console.log('rangee sous une forme que ces trois lectures ne couvrent pas, resterait')
    console.log("invisible. Mais les trois formes usuelles, elles, ont ete regardees.")
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
