#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openClient } from './vfs.mjs'
import { decode } from './encoding.mjs'
import { parseMapNameTable } from './parsers/tables.mjs'
import { extractItems } from './parsers/items.mjs'
import { extractMobs, looksLikeMobId, prettifySprite } from './parsers/mobs.mjs'
import { extractSpawns } from './parsers/navi.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_PATH_FILE = path.join(ROOT, '.client-path')

function parseArgs(argv) {
  const args = { out: path.join(ROOT, 'public', 'data'), encoding: 'auto' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--client' || a === '-c') args.client = argv[++i]
    else if (a === '--out' || a === '-o') args.out = path.resolve(argv[++i])
    else if (a === '--encoding' || a === '-e') args.encoding = argv[++i]
    else if (a === '--verbose' || a === '-v') args.verbose = true
    else if (a === '--help' || a === '-h') args.help = true
    else if (!args.client) args.client = a
  }
  return args
}

const HELP = `
Extrait items / mobs / cartes / spawns du client Ragnarok Zero.

  node tools/extract.mjs --client "C:\\Gravity\\Ragnarok Zero"

Options
  -c, --client <dossier>   racine du client (contient data.grf, DATA.INI, System/)
                           memorise dans .client-path pour les fois suivantes
  -o, --out <dossier>      sortie JSON            (defaut : public/data)
  -e, --encoding <enc>     auto | cp949 | utf8 | cp1252   (defaut : auto)
  -v, --verbose            detaille les archives lues
`

function resolveClient(args) {
  if (args.client) return args.client
  if (fs.existsSync(CLIENT_PATH_FILE)) return fs.readFileSync(CLIENT_PATH_FILE, 'utf8').trim()
  return null
}

function extractMapNames(vfs, encoding) {
  const buf = vfs.read('data/mapnametable.txt')
  if (!buf) return { names: new Map(), source: null }
  return { names: parseMapNameTable(decode(buf, encoding)), source: 'data/mapnametable.txt' }
}

function writeJson(dir, name, value) {
  const target = path.join(dir, name)
  fs.writeFileSync(target, JSON.stringify(value))
  return { name, bytes: fs.statSync(target).size }
}

function human(bytes) {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} Mo`
  return `${Math.round(bytes / 1024)} ko`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { console.log(HELP); return }

  const clientDir = resolveClient(args)
  if (!clientDir) {
    console.error(HELP)
    console.error('Erreur : aucun dossier client fourni.\n')
    process.exit(1)
  }

  console.log(`Client   : ${clientDir}`)
  const vfs = openClient(clientDir, { encoding: 'cp949', verbose: args.verbose })
  fs.writeFileSync(CLIENT_PATH_FILE, clientDir)

  console.log(`Archives : ${vfs.grfs.map((g) => g.name).join(', ') || 'aucune'}${vfs.looseDir ? ' + data/ en clair' : ''}`)
  for (const err of vfs.errors) console.warn(`  ! ${err}`)

  const warnings = [...vfs.errors]
  const sources = []

  // --- cartes -------------------------------------------------------------
  const { names: mapNames, source: mapSource } = extractMapNames(vfs, args.encoding)
  if (mapSource) sources.push(mapSource)
  else warnings.push('data/mapnametable.txt absent : les cartes n\'auront pas de nom lisible.')

  // --- items --------------------------------------------------------------
  const itemResult = extractItems(vfs, { encoding: args.encoding })
  sources.push(...itemResult.sources)
  warnings.push(...itemResult.warnings)

  // --- mobs ---------------------------------------------------------------
  const mobResult = extractMobs(vfs, { encoding: args.encoding })
  sources.push(...mobResult.sources)
  warnings.push(...mobResult.warnings)

  // --- spawns -------------------------------------------------------------
  const spawnResult = extractSpawns(vfs, {
    encoding: args.encoding,
    knownMaps: new Set(mapNames.keys()),
    knownMobIds: new Set(mobResult.mobs.keys()),
  })
  sources.push(...spawnResult.files)
  warnings.push(...spawnResult.warnings)

  // --- assemblage ---------------------------------------------------------
  const mobs = mobResult.mobs
  /** @type {Map<string, {id: string, name: string, mobs: Array<{id: number, amount: number}>}>} */
  const maps = new Map()
  const ensureMap = (id) => {
    let m = maps.get(id)
    if (!m) { m = { id, name: mapNames.get(id) || id, mobs: [] }; maps.set(id, m) }
    return m
  }
  for (const [id, name] of mapNames) ensureMap(id).name = name

  const spawnIndex = new Map() // `${mobId}@${map}` -> amount
  for (const spawn of spawnResult.spawns) {
    if (!looksLikeMobId(spawn.mobId)) continue
    let mob = mobs.get(spawn.mobId)
    if (!mob) {
      mob = { id: spawn.mobId, name: spawn.name || `Mob ${spawn.mobId}`, nameSource: 'navi' }
      mobs.set(spawn.mobId, mob)
    }
    // Le nom du fichier de navigation est localise : il prime sur le sprite.
    if (spawn.name && mob.nameSource !== 'navi') { mob.name = spawn.name; mob.nameSource = 'navi' }
    if (spawn.level !== undefined && mob.level === undefined) mob.level = spawn.level

    const key = `${spawn.mobId}@${spawn.map}`
    spawnIndex.set(key, (spawnIndex.get(key) || 0) + (spawn.amount || 1))
  }

  for (const [key, amount] of spawnIndex) {
    const [mobId, mapId] = key.split('@')
    const id = Number(mobId)
    const map = ensureMap(mapId)
    map.mobs.push({ id, amount })
    const mob = mobs.get(id)
    if (mob) (mob.spawns ||= []).push({ map: mapId, amount })
  }

  for (const map of maps.values()) map.mobs.sort((a, b) => b.amount - a.amount)
  for (const mob of mobs.values()) if (mob.spawns) mob.spawns.sort((a, b) => b.amount - a.amount)

  // Les mobs sans sprite ni spawn sont des ids fantomes : on les ecarte.
  for (const [id, mob] of mobs) {
    if (!mob.spawns && !mob.sprite && mob.nameSource !== 'navi') mobs.delete(id)
    else delete mob.nameSource
  }

  // --- ecriture -----------------------------------------------------------
  fs.mkdirSync(args.out, { recursive: true })
  const toObject = (map) => Object.fromEntries([...map].map(([k, v]) => [k, v]))

  const written = [
    writeJson(args.out, 'items.json', toObject(itemResult.items)),
    writeJson(args.out, 'mobs.json', toObject(mobs)),
    writeJson(args.out, 'maps.json', toObject(maps)),
  ]

  const meta = {
    generatedAt: new Date().toISOString(),
    client: clientDir,
    archives: vfs.grfs.map((g) => g.name),
    looseData: Boolean(vfs.looseDir),
    encoding: args.encoding,
    counts: {
      items: itemResult.items.size,
      mobs: mobs.size,
      maps: maps.size,
      spawns: spawnIndex.size,
      mobsWithSpawns: [...mobs.values()].filter((m) => m.spawns).length,
    },
    naviColumns: spawnResult.columns,
    naviConfidence: spawnResult.confidence,
    sources: [...new Set(sources)],
    warnings,
  }
  written.push(writeJson(args.out, 'meta.json', meta))

  if (!fs.existsSync(path.join(args.out, 'drops.json'))) {
    writeJson(args.out, 'drops.json', { meta: { source: null, importedAt: null }, mobs: {} })
  }

  vfs.close()

  console.log('')
  console.log(`Items    : ${meta.counts.items}`)
  console.log(`Mobs     : ${meta.counts.mobs} (${meta.counts.mobsWithSpawns} avec au moins une zone)`)
  console.log(`Cartes   : ${meta.counts.maps}`)
  console.log(`Spawns   : ${meta.counts.spawns}`)
  if (spawnResult.columns) {
    const c = spawnResult.columns
    console.log(`Colonnes navi deduites : carte=${c.map} id=${c.id} nom=${c.name} niveau=${c.level} nombre=${c.amount}`)
  }
  console.log(`Sortie   : ${args.out} (${written.map((w) => `${w.name} ${human(w.bytes)}`).join(', ')})`)

  if (warnings.length) {
    console.log('\nAvertissements :')
    for (const w of warnings) console.log(`  - ${w}`)
  }
  console.log('\nDrops : le client ne les contient pas. Voir README > "Tables de drop".')
}

main().catch((err) => {
  console.error(`\nEchec : ${err.message}`)
  if (process.env.DEBUG) console.error(err.stack)
  process.exit(1)
})
