#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { loadFlows, looksTls } from './pcap.mjs'
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

const MIN_RUN = 3          // en deca, une coincidence est trop probable
const MAX_STRIDE = 32      // taille maximale d'un enregistrement
const MOB_LOOKBACK = 96    // ou chercher l'identifiant du mob avant la liste

const HELP = `
Cherche des tables de drop dans une capture reseau du jeu.

  node tools/analyze-capture.mjs captures/zero.pcapng

Options
  -o, --out <fichier>   CSV des drops trouves   (defaut : captures/drops.csv)
      --min-run <n>     nombre minimal d'items consecutifs (defaut : ${MIN_RUN})
      --raw <fichier>   ecrit aussi le flux serveur brut, pour inspection
      --json            sortie detaillee en JSON sur la sortie standard
`

function parseArgs(argv) {
  const args = { minRun: MIN_RUN }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out' || a === '-o') args.out = path.resolve(argv[++i])
    else if (a === '--min-run') args.minRun = Number(argv[++i])
    else if (a === '--raw') args.raw = path.resolve(argv[++i])
    else if (a === '--json') args.json = true
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
  const items = new Set(Object.keys(read('items.json')).map(Number))
  const mobs = new Set(Object.keys(read('mobs.json')).map(Number))
  return { items, mobs }
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
 * Suites de positions espacees d'un pas constant : la signature d'un tableau
 * d'enregistrements de taille fixe.
 */
function findRuns(hits, minRun) {
  const positions = new Set(hits)
  const runs = []
  const consumed = new Set()

  for (const start of hits) {
    if (consumed.has(start)) continue
    for (let stride = 4; stride <= MAX_STRIDE; stride += 2) {
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
export function findDropTables(data, oracle, { minRun = MIN_RUN } = {}) {
  const found = []

  for (const { width: itemWidth, read } of readers) {
    const hits = findItemHits(data, oracle.items, itemWidth, read)
    if (hits.length < minRun) continue

    for (const run of findRuns(hits, minRun)) {
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

  const oracle = loadOracle()
  if (!oracle.items.size) {
    console.error('public/data/items.json est vide : lance d\'abord `npm run extract`.')
    console.error('Sans la liste des identifiants du client, il n\'y a rien pour reconnaitre un drop.')
    process.exit(1)
  }
  console.log(`Oracle : ${oracle.items.size} items, ${oracle.mobs.size} mobs connus du client\n`)

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

  const candidates = flows.filter((f) => f.isServerToClient !== false && f.bytes > 256)
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

  console.log(`\n${results.length} table(s) candidate(s)\n`)
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

if (import.meta.url === `file://${process.argv[1]}`) main()
