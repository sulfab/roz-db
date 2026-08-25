#!/usr/bin/env node
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { loadFlows, looksTls } from './pcap.mjs'
import {
  frameStream, readEntries, inferClassOffset, inferGroundItems, readGroundItem, trailingName,
  inferEncyclopedia,
} from './packets.mjs'
import { ROOT } from './client-path.mjs'

/**
 * Retrouve les tables de drop dans une capture du jeu.
 *
 * Le format des paquets de Ragnarok Zero n'est pas public, et le supposer
 * produirait des chiffres faux sans qu'on s'en apercoive. On procede donc comme
 * pour le GRF et les fichiers de navigation : on deduit la structure des
 * donnees, avec un oracle solide — le client nous a deja donne la liste exacte
 * des identifiants d'items et de mobs qui existent.
 *
 * Une table de drop, quel que soit son enrobage, est une suite d'enregistrements
 * de taille constante contenant chacun un identifiant d'item valide. C'est cette
 * regularite qu'on cherche, pas un numero de paquet.
 */

const MIN_RUN = 3          // plancher absolu ; le vrai seuil est calcule
const MIN_STRIDE = 4       // taille minimale d'un enregistrement
const MAX_STRIDE = 32      // taille maximale d'un enregistrement
const MOB_LOOKBACK = 96    // ou chercher l'identifiant du mob avant la liste
/** Nombre de fausses tables qu'on accepte de voir apparaitre par hasard. */
const FALSE_POSITIVE_BUDGET = 0.01

const HELP = `
Cherche des tables de drop dans une capture reseau du jeu.

  node tools/analyze-capture.mjs captures/zero.pcapng

Options
  -o, --out <fichier>   CSV des drops trouves   (defaut : captures/drops.csv)
      --min-run <n>     force le nombre minimal d'items consecutifs
                        (par defaut, calcule d'apres la densite de l'oracle)
      --raw <fichier>   ecrit aussi le flux serveur brut, pour inspection
      --json            sortie detaillee en JSON sur la sortie standard
      --data <dossier>  ou lire l'oracle          (defaut : public/data)
`

function parseArgs(argv) {
  // null, et non MIN_RUN : sans cela l'option ecrasait le seuil calcule, qui
  // n'etait alors jamais utilise.
  const args = { minRun: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out' || a === '-o') args.out = path.resolve(argv[++i])
    else if (a === '--min-run') args.minRun = Number(argv[++i])
    else if (a === '--raw') args.raw = path.resolve(argv[++i])
    else if (a === '--json') args.json = true
    else if (a === '--data') args.data = path.resolve(argv[++i])
    else if (a === '--help' || a === '-h') args.help = true
    else if (!args.file) args.file = a
  }
  return args
}

/** Identifiants reellement existants, extraits du client : c'est notre oracle. */
export function loadOracle(dataDir = path.join(ROOT, 'public', 'data')) {
  const read = (name) => {
    const file = path.join(dataDir, name)
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
  }
  const itemTable = read('items.json')
  const mobTable = read('mobs.json')
  const items = new Set(Object.keys(itemTable).map(Number))
  const mobs = new Set(Object.keys(mobTable).map(Number))
  // Les noms ne servent pas a reconnaitre : ils rendent lisible ce qu'on a
  // reconnu, quand on affiche les monstres croises dans la capture.
  const mobNames = new Map(Object.entries(mobTable).map(([id, m]) => [Number(id), m?.nom || m?.name]))
  const itemNames = new Map(Object.entries(itemTable).map(([id, i]) => [Number(id), i?.nom || i?.name]))
  return { items, mobs, mobNames, itemNames }
}

const readers = [
  { width: 2, read: (b, at) => b.readUInt16LE(at) },
  { width: 4, read: (b, at) => b.readUInt32LE(at) },
]

/**
 * Positions ou un identifiant d'item valide est lisible.
 * Les petits identifiants sont ecartes : trop frequents par hasard.
 */
function findItemHits(data, items, width, read) {
  const hits = []
  for (let at = 0; at + width <= data.length; at++) {
    const value = read(data, at)
    if (value >= 100 && items.has(value)) hits.push(at)
  }
  return hits
}

/**
 * Combien d'entrees consecutives faut-il pour que ce ne soit pas un hasard ?
 *
 * La question n'a pas de reponse fixe : elle depend de la densite de l'oracle.
 * Un client de 9646 items occupe 15 % de l'espace des entiers 16 bits — une
 * valeur quelconque a donc une chance sur sept d'etre un "item valide", et
 * quatre coincidences alignees dans quelques kilo-octets sont attendues des
 * dizaines de fois. Sur 32 bits la densite tombe a deux millioniemes et trois
 * entrees suffisent largement.
 *
 * On calcule donc le seuil : le plus petit k tel que le nombre de suites
 * attendues par hasard reste sous le budget qu'on s'accorde.
 */
export function minimumRun(dataLength, density, strides = (MAX_STRIDE - MIN_STRIDE) / 2 + 1) {
  if (density <= 0) return MIN_RUN
  if (density >= 1) return Infinity
  const trials = Math.max(1, dataLength * strides)
  for (let k = MIN_RUN; k <= 64; k++) {
    if (trials * Math.pow(density, k) < FALSE_POSITIVE_BUDGET) return k
  }
  return Infinity
}

/** Part de l'espace des valeurs qu'occupe l'oracle, pour une largeur donnee. */
export function oracleDensity(ids, width) {
  const space = Math.pow(256, width)
  let inRange = 0
  for (const id of ids) if (id < space) inRange++
  return inRange / space
}

/**
 * Suites de positions espacees d'un pas constant : la signature d'un tableau
 * d'enregistrements de taille fixe.
 */
function findRuns(hits, minRun) {
  const positions = new Set(hits)
  const runs = []
  const consumed = new Set()

  for (const start of hits) {
    if (consumed.has(start)) continue
    for (let stride = MIN_STRIDE; stride <= MAX_STRIDE; stride += 2) {
      const run = [start]
      let next = start + stride
      while (positions.has(next)) { run.push(next); next += stride }
      if (run.length >= minRun) {
        for (const at of run) consumed.add(at)
        runs.push({ start, stride, count: run.length, positions: run })
        break
      }
    }
  }
  return runs
}

/**
 * Dans un enregistrement, quel champ porte le taux ?
 *
 * Un taux est un entier positif borne : au plus 100 000 pour une echelle en
 * 1/1000 de pourcent. On retient le champ dont toutes les valeurs de la suite
 * tiennent dans cette borne et qui varie d'un enregistrement a l'autre — un
 * champ constant est un drapeau, pas un taux.
 */
function inferRateField(data, run, itemWidth) {
  const candidates = []
  for (const { width, read } of readers) {
    for (let offset = 0; offset + width <= run.stride; offset++) {
      if (offset < itemWidth) continue // ne chevauche pas l'identifiant
      const values = []
      let usable = true
      for (const at of run.positions) {
        const pos = at + offset
        if (pos + width > data.length) { usable = false; break }
        const value = read(data, pos)
        if (value <= 0 || value > 100_000) { usable = false; break }
        values.push(value)
      }
      if (!usable || values.length < run.count) continue
      const distinct = new Set(values).size
      candidates.push({ offset, width, values, distinct })
    }
  }
  if (!candidates.length) return null
  // Le champ le plus varie est le meilleur candidat ; a egalite, le plus proche
  // de l'identifiant, car les structures groupent item et taux ; puis la
  // lecture la plus large, pour la meme raison que pour les identifiants :
  // un entier 32 bits de petite valeur se lit aussi comme un 16 bits.
  candidates.sort((a, b) => b.distinct - a.distinct || a.offset - b.offset || b.width - a.width)
  return candidates[0]
}

/** L'identifiant du mob precede generalement sa liste de drops. */
function findMobId(data, runStart, mobs) {
  for (let back = 2; back <= MOB_LOOKBACK; back++) {
    const at = runStart - back
    if (at < 0) break
    for (const { width, read } of readers) {
      if (at + width > data.length) continue
      const value = read(data, at)
      if (mobs.has(value)) return { mobId: value, at, width, distance: back }
    }
  }
  return null
}

/**
 * @param {Buffer} data flux serveur -> client reassemble
 * @param {{items: Set<number>, mobs: Set<number>}} oracle
 * @returns {Array<object>} tables candidates, la plus credible en tete
 */
/** Ecart moyen en deca duquel une suite croissante compte les objets au lieu de les citer. */
const PAS_MOYEN_MINIMUM = 32

/**
 * Une suite croissante a petits pas n'est pas une table de drop.
 *
 * C'est la lecon d'un balayage de tout le client : les fichiers de geometrie
 * et de sprites contiennent de longues suites d'entiers qui montent un par un.
 * Comme les identifiants d'objets sont denses par tranches, ces compteurs
 * ressortaient tous comme des tables — 4001, 4002, 4003, 4004... sur des
 * dizaines d'entrees.
 *
 * Une vraie table de drop ne ressemble pas a ca : ses objets sont pris un peu
 * partout dans la numerotation, donc leurs ecarts sont grands et irreguliers.
 */
export function looksLikeCounter(values) {
  if (values.length < 3) return false
  let croissant = true
  for (let i = 1; i < values.length; i++) if (values[i] <= values[i - 1]) { croissant = false; break }
  if (!croissant) return false
  const pas = (values[values.length - 1] - values[0]) / (values.length - 1)
  return pas < PAS_MOYEN_MINIMUM
}

export function findDropTables(data, oracle, { minRun = null } = {}) {
  const found = []

  for (const { width: itemWidth, read } of readers) {
    // Seuil propre a cette largeur de lecture : sur 16 bits l'oracle est dense,
    // sur 32 bits il ne l'est pas.
    const density = oracleDensity(oracle.items, itemWidth)
    const required = minRun ?? minimumRun(data.length, density)
    if (!Number.isFinite(required)) continue

    const hits = findItemHits(data, oracle.items, itemWidth, read)
    if (hits.length < required) continue

    for (const run of findRuns(hits, required)) {
      // Une table de drop ne liste pas deux fois le meme objet. Un tableau ou
      // un identifiant se repete est un alignement fortuit, pas une structure.
      const values = run.positions.map((at) => read(data, at))
      if (new Set(values).size !== values.length) continue
      if (looksLikeCounter(values)) continue

      const rate = inferRateField(data, run, itemWidth)
      const mob = findMobId(data, run.start, oracle.mobs)
      const entries = run.positions.map((at, i) => ({
        item: read(data, at),
        rate: rate ? rate.values[i] : null,
      }))

      found.push({
        offset: run.start,
        stride: run.stride,
        count: run.count,
        itemWidth,
        rateOffset: rate ? rate.offset : null,
        rateWidth: rate ? rate.width : null,
        mobId: mob ? mob.mobId : null,
        mobDistance: mob ? mob.distance : null,
        entries,
        density,
        required,
        // Une table credible : un mob identifie, des taux qui varient, et
        // assez d'entrees pour que le hasard soit exclu.
        score: run.count * 2 + (mob ? 10 : 0) + (rate ? rate.distinct : 0),
      })
    }
  }

  return dedupe(found).sort((a, b) => b.score - a.score)
}

/**
 * Un identifiant sur 32 bits en petit-boutiste se lit aussi comme un 16 bits
 * suivi de deux octets nuls : le meme tableau est donc trouve deux fois. On
 * garde la lecture la plus large quand elle donne exactement les memes
 * identifiants, pour que la structure rapportee decrive vraiment le paquet.
 */
function dedupe(found) {
  const byPosition = new Map()
  for (const table of found) {
    const key = `${table.offset}:${table.stride}:${table.count}`
    const previous = byPosition.get(key)
    if (!previous) { byPosition.set(key, table); continue }
    const sameItems = previous.entries.every((e, i) => e.item === table.entries[i]?.item)
    if (sameItems && table.itemWidth > previous.itemWidth) byPosition.set(key, table)
  }
  return [...byPosition.values()]
}

/**
 * Les taux arrivent bruts : 1/10000 chez la plupart des serveurs, parfois en
 * 1/1000 de pourcent. On propose l'echelle, sans trancher a la place de qui
 * verifiera en jeu.
 */
export function guessScale(entries) {
  const values = entries.map((e) => e.rate).filter((v) => typeof v === 'number')
  if (!values.length) return null
  const max = Math.max(...values)
  if (max <= 100) return { base: 100, note: 'pourcentage direct' }
  if (max <= 10_000) return { base: 10_000, note: '1/10000, echelle serveur habituelle' }
  return { base: 100_000, note: '1/1000 de pourcent' }
}

/**
 * Lit la capture comme ce qu'elle est : une suite de paquets du jeu.
 *
 * On a longtemps cherche les tables de drop a l'aveugle, par statistique, faute
 * de savoir ce qu'il y avait dans le flux. Ce n'est plus necessaire : le trafic
 * est en clair et il se decoupe, donc on peut nommer ce qu'on lit au lieu de le
 * deviner. La recherche statistique reste ensuite, comme filet.
 */
function reportPackets(flow, oracle) {
  const framed = frameStream(flow.data)
  if (!framed.packets.length) {
    console.log(`\nPaquets de ${flow.key} : ce flux ne se decoupe pas en paquets du jeu.`)
    return
  }

  console.log(`\nPaquets de ${flow.key}`)
  console.log(`  ${framed.packets.length} paquets, ` +
    `${(framed.coverage * 100).toFixed(0)} % des octets reconnus` +
    (framed.learned.size ? `, ${framed.learned.size} longueur(s) deduite(s)` : ''))

  const entries = readEntries(framed.packets)
  const mobs = entries.filter((e) => e.kind === 'monstre')

  const classe = inferClassOffset(entries, oracle.mobs)
  if (classe) {
    const vus = new Map()
    for (const e of mobs) {
      const id = e.payload.readUInt16LE(classe.offset)
      vus.set(id, (vus.get(id) || 0) + 1)
    }
    console.log(`  ${mobs.length} apparition(s) de monstre, ${vus.size} espece(s) :`)
    for (const [id, n] of [...vus].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      console.log(`      ${String(id).padStart(5)}  ${oracle.mobNames?.get(id) || '?'}  x${n}`)
    }
    if (!classe.solid) {
      console.log('      (a prendre avec des pincettes : avec si peu d\'especes croisees, ' +
        `le hasard produirait ${classe.expectedByChance.toFixed(2)} position(s) aussi bonne(s))`)
    }
  } else if (mobs.length) {
    console.log(`  ${mobs.length} apparition(s) de monstre, mais aucune position ne donne ` +
      'un monstre connu du client : la capture est trop courte pour trancher.')
  }

  const noms = new Map()
  for (const e of entries) {
    const nom = trailingName(e.payload)
    if (nom) noms.set(e.aid, nom)
  }
  if (noms.size) {
    console.log(`  ${noms.size} nom(s) lus en clair : ${[...noms.values()].slice(0, 8).join(', ')}`)
  }

  // L'encyclopedie d'abord : c'est la seule chose du flux qui porte de vrais
  // taux, et pour le bon serveur. Tout le reste n'est que comptage.
  const fiches = inferEncyclopedia(framed.packets, oracle)
  if (fiches.length) {
    console.log(`  ${fiches.length} fiche(s) d'encyclopedie — des taux annonces, pas observes :`)
    for (const fiche of fiches.slice(0, 4)) {
      console.log(`      paquet 0x${fiche.opcode.toString(16).padStart(4, '0')}, ` +
        `monstre ${fiche.mob} ${oracle.mobNames?.get(fiche.mob) || ''}`.trimEnd())
      fiche.lignes.forEach((ligne, i) => {
        const brut = fiche.taux ? fiche.taux.valeurs[i] : null
        console.log(`        ${String(ligne.item).padStart(6)} ${oracle.itemNames?.get(ligne.item) || ''}`.trimEnd() +
          (brut === null ? '' : `   ${(brut / 100).toFixed(2)} %  (brut ${brut})`))
      })
    }
    console.log('      Ouvre l\'encyclopedie sur d\'autres monstres pour completer la table.')
  }

  const formes = inferGroundItems(framed.packets, oracle.items, {
    entityIds: new Set(entries.map((e) => e.aid)),
  })
  if (formes.length) {
    console.log('  Objets tombes au sol :')
    for (const forme of formes.slice(0, 4)) {
      const tombes = framed.packets.map((p) => readGroundItem(p, forme)).filter(Boolean)
      console.log(`      paquet 0x${forme.opcode.toString(16).padStart(4, '0')}, objet a ` +
        `+${forme.offset} sur ${forme.size * 8} bits — reconnu par les ${forme.paires} ` +
        `identifiants qu'il partage avec le paquet de ramassage ` +
        `0x${forme.retrait.toString(16).padStart(4, '0')}`)
      for (const objet of tombes.slice(0, 8)) {
        console.log(`        ${String(objet.item).padStart(6)}  ${oracle.itemNames?.get(objet.item) || ''}`)
      }
    }
  } else {
    console.log("  Aucun objet au sol : rien n'est tombe pendant la capture, ou elle est " +
      'trop courte pour que le va-et-vient chute/ramassage se voie.')
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.file) {
    console.log(HELP)
    process.exit(args.help ? 0 : 1)
  }
  if (!fs.existsSync(args.file)) {
    console.error(`Capture introuvable : ${args.file}`)
    process.exit(1)
  }

  const oracle = loadOracle(args.data)
  if (!oracle.items.size) {
    console.error('public/data/items.json est vide : lance d\'abord `npm run extract`.')
    console.error('Sans la liste des identifiants du client, il n\'y a rien pour reconnaitre un drop.')
    process.exit(1)
  }
  const density16 = oracleDensity(oracle.items, 2)
  console.log(`Oracle : ${oracle.items.size} items, ${oracle.mobs.size} mobs connus du client`)
  console.log(
    `         ces items occupent ${(density16 * 100).toFixed(1)} % des valeurs 16 bits : ` +
    `une valeur au hasard a ${(1 / density16).toFixed(0)} chances sur ${(1 / density16).toFixed(0)} ` +
    `d'en etre un par accident.`
  )

  const flows = loadFlows(args.file)
  if (!flows.length) {
    console.error('Aucun flux TCP dans cette capture.')
    process.exit(1)
  }

  console.log('Flux TCP')
  for (const flow of flows.slice(0, 8)) {
    const direction = flow.isServerToClient === true ? 'serveur -> client'
      : flow.isServerToClient === false ? 'client -> serveur' : 'sens indetermine'
    console.log(`  ${flow.key.padEnd(46)} ${String(flow.bytes).padStart(9)} o  ${direction}` +
      (flow.gaps ? `  (${flow.gaps} trou(s))` : ''))
  }

  const serverBytes = flows
    .filter((f) => f.isServerToClient !== false)
    .reduce((n, f) => n + f.bytes, 0)
  if (serverBytes < 50_000) {
    console.log(
      `\nSeulement ${serverBytes} octets recus du serveur. Une session de jeu en produit ` +
      `des centaines de kilo-octets : la capture a probablement demarre apres la connexion, ` +
      `ou s'est arretee trop tot. Relance-la avant de lancer le jeu.`
    )
  }

  // Le seul flux inexploitable est celui trop court pour contenir la plus
  // petite table possible : MIN_RUN entrees au pas minimal. Ecarter davantage
  // reviendrait a jeter des donnees sur un seuil invente.
  const floor = MIN_RUN * MIN_STRIDE
  const candidates = flows.filter((f) => f.isServerToClient !== false && f.bytes >= floor)
  if (!candidates.length) {
    console.error('\nAucun flux serveur -> client exploitable.')
    process.exit(1)
  }

  const tls = candidates.filter((f) => looksTls(f.data))
  if (tls.length === candidates.length) {
    console.error('\nTout le trafic est chiffre en TLS : rien a lire dans la capture.')
    console.error('Il faudra une autre source pour les taux de drop.')
    process.exit(1)
  }

  const results = []
  for (const flow of candidates) {
    if (looksTls(flow.data)) continue
    if (args.raw) fs.writeFileSync(args.raw, flow.data)
    reportPackets(flow, oracle)
    for (const table of findDropTables(flow.data, oracle, { minRun: args.minRun })) {
      results.push({ flow: flow.key, ...table })
    }
  }

  if (!results.length) {
    console.log('\nAucune table de drop reconnue.')
    console.log('Aucun identifiant d\'item du client n\'apparait a intervalle regulier dans le flux.')
    console.log('Le contenu est probablement chiffre ou compresse par le jeu lui-meme.')
    console.log('Relance avec --raw flux.bin et envoie le fichier pour analyse.')
    return
  }

  console.log(`\n${results.length} table(s) candidate(s)`)
  const required = results[0]?.required
  if (required) {
    console.log(`Seuil retenu : ${required} entrees consecutives, calcule pour que le hasard ` +
      `en produise moins d'une centieme.\n`)
  }
  const best = results.slice(0, 10)
  for (const table of best) {
    const scale = guessScale(table.entries)
    console.log(`  offset ${table.offset}  ${table.count} entrees de ${table.stride} octets` +
      `  item ${table.itemWidth === 2 ? '16' : '32'} bits` +
      (table.rateOffset !== null ? `  taux a +${table.rateOffset} (${table.rateWidth * 8} bits)` : '  taux non identifie') +
      (table.mobId ? `  mob ${table.mobId}` : '  mob non identifie'))
    for (const entry of table.entries.slice(0, 5)) {
      console.log(`      item ${String(entry.item).padStart(6)}   valeur brute ${entry.rate ?? '—'}`)
    }
    if (scale) console.log(`      echelle proposee : ${scale.base} (${scale.note})`)
  }

  const withMob = results.filter((t) => t.mobId && t.rateOffset !== null)
  const out = args.out || path.join(path.dirname(args.file), 'drops.csv')
  if (withMob.length) {
    const scale = guessScale(withMob.flatMap((t) => t.entries))
    const lines = ['mobId,itemId,taux']
    const seen = new Set()
    for (const table of withMob) {
      for (const entry of table.entries) {
        const key = `${table.mobId},${entry.item}`
        if (seen.has(key)) continue
        seen.add(key)
        lines.push(`${table.mobId},${entry.item},${entry.rate}`)
      }
    }
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, lines.join('\n') + '\n')
    console.log(`\n${lines.length - 1} drop(s) ecrits dans ${out}`)
    console.log(`Verifie deux ou trois lignes en jeu, puis :`)
    console.log(`  npm run import-drops -- "${out}" --source "encyclopedie in-game" --base ${scale ? scale.base : 10000}`)
  } else {
    console.log('\nAucune table ne combine un mob identifie et un champ de taux :')
    console.log('les listes trouvees ne sont peut-etre pas des drops. Rien n\'a ete ecrit.')
  }

  if (args.json) console.log(JSON.stringify(results, null, 2))
}

// Compare des URL des deux cotes : sous Windows, process.argv[1] vaut
// C:\chemin\fichier.mjs, qui n'est jamais egal a file:///C:/chemin/....
// argv[1] est absent quand le module est importe, notamment par les tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
