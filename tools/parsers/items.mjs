import { decode } from '../encoding.mjs'
import { toArray, numericEntries } from '../lua.mjs'
import { loadLua } from '../luadata.mjs'
import { parseSimpleTable, parseDescTable } from './tables.mjs'

/**
 * Items.
 *
 * Deux sources dans le client, complementaires :
 *  - System/itemInfo*.lub : la table complete (nom identifie/non identifie,
 *    description, nombre de slots, ClassNum pour l'icone). Compilee dans les
 *    clients recents, ce qui ne pose plus de probleme : voir luadata.mjs.
 *  - data/*table.txt      : les memes donnees eclatees en tables texte. Les
 *    clients recents ne les livrent plus, les anciens si.
 */

const ITEM_INFO_CANDIDATES = [
  'System/itemInfo.lub',
  'System/itemInfo_true.lub',
  'System/itemInfo_Sak.lub',
  'System/iteminfo.lua',
  'data/luafiles514/lua files/datainfo/iteminfo.lub',
  'data/luafiles514/lua files/datainfo/iteminfo_true.lub',
]

/**
 * Les chemins connus ne suffisent pas toujours : sur Ragnarok Zero,
 * System/itemInfo_true.lub ne fait que 162 octets — un talon. On cherche donc
 * la vraie table parmi les fichiers dont le nom evoque les items, du plus gros
 * au plus petit : une base d'items pese des centaines de kilo-octets, ce qui
 * la place en tete sans avoir a deviner son chemin.
 */
const DISCOVERY_LIMIT = 12
const DISCOVERY_MIN_SIZE = 4096
/** Une base d'items complete pese au moins cela ; en deca, c'est autre chose. */
const BIG_FILE_SIZE = 200_000
const BIG_FILE_LIMIT = 15

function bySizeDesc(a, b) { return b.size - a.size }

/**
 * Deux passes. D'abord les fichiers dont le nom evoque les items. Puis, si
 * aucun n'a donne de table, les plus gros fichiers Lua du client : sur un
 * client ou le nom attendu n'existe pas, la base d'items reste de loin le plus
 * gros fichier de donnees, quel que soit son nom.
 */
function discoverItemFiles(vfs) {
  return vfs
    .list((key) => /item.*\.(lub|lua)$/.test(key) && !/table\.txt$/.test(key))
    .filter((entry) => entry.size >= DISCOVERY_MIN_SIZE)
    .sort(bySizeDesc)
    .slice(0, DISCOVERY_LIMIT)
}

function discoverBigLuaFiles(vfs) {
  return vfs
    .list((key) => /\.(lub|lua)$/.test(key))
    .filter((entry) => entry.size >= BIG_FILE_SIZE)
    .sort(bySizeDesc)
    .slice(0, BIG_FILE_LIMIT)
}

const TEXT_TABLES = {
  displayName: 'data/idnum2itemdisplaynametable.txt',
  resName: 'data/idnum2itemresnametable.txt',
  desc: 'data/idnum2itemdesctable.txt',
  displayNameUnid: 'data/num2itemdisplaynametable.txt',
  resNameUnid: 'data/num2itemresnametable.txt',
  descUnid: 'data/num2itemdesctable.txt',
  slots: 'data/itemslotcounttable.txt',
}

const LUA_FIELDS = {
  name: ['identifiedDisplayName'],
  nameUnid: ['unidentifiedDisplayName'],
  res: ['identifiedResourceName'],
  resUnid: ['unidentifiedResourceName'],
  slots: ['slotCount'],
  classNum: ['ClassNum', 'classNum'],
  costume: ['costume'],
  effectId: ['EffectID'],
}

function pick(entry, names) {
  for (const name of names) {
    if (entry[name] !== undefined && entry[name] !== null) return entry[name]
  }
  return undefined
}

function textLines(value) {
  const arr = toArray(value)
  if (arr.length) return arr.filter((l) => typeof l === 'string')
  return typeof value === 'string' ? [value] : []
}

/**
 * @param {import('../vfs.mjs').Vfs} vfs
 * @param {{encoding?: string}} options
 * @returns {{items: Map<number, object>, sources: string[], warnings: string[]}}
 */
export function extractItems(vfs, { encoding = 'auto' } = {}) {
  /** @type {Map<number, object>} */
  const items = new Map()
  const sources = []
  const warnings = []

  const ensure = (id) => {
    let item = items.get(id)
    if (!item) { item = { id }; items.set(id, item) }
    return item
  }

  // --- 1. itemInfo.lub ----------------------------------------------------
  const tried = []
  const attempts = []

  const found = vfs.readAny(ITEM_INFO_CANDIDATES)
  if (found) attempts.push({ path: found.path, buffer: found.buffer })

  const read = (entry) => {
    try { return vfs.read(entry.name) } catch { return null }
  }
  const addAll = (entries) => {
    for (const entry of entries) {
      if (attempts.some((a) => a.path === entry.name)) continue
      const buffer = read(entry)
      if (buffer) attempts.push({ path: entry.name, buffer, size: entry.size })
    }
  }
  addAll(discoverItemFiles(vfs))
  addAll(discoverBigLuaFiles(vfs))

  if (!attempts.length) {
    warnings.push(`Aucun fichier d'items trouve (cherche : ${ITEM_INFO_CANDIDATES.join(', ')})`)
  } else {
    let winner = null
    for (const attempt of attempts) {
      try {
        const { env, tables, warnings: luaWarnings } = loadLua(attempt.buffer, {
          encoding,
          includeTables: true,
        })
        const table = findItemTable(env) || bestItemTable(tables)
        const score = table ? scoreItemTable(table) : 0
        tried.push({ path: attempt.path, score, env, tables })
        if (table && (!winner || score > winner.score)) {
          winner = { path: attempt.path, table, score, luaWarnings }
        }
      } catch (err) {
        tried.push({ path: attempt.path, score: 0, error: err.message })
      }
      // Une base d'items complete se reconnait tout de suite : inutile de
      // continuer a executer des fichiers une fois qu'on la tient.
      if (winner && winner.score >= 100) break
    }

    if (!winner) {
      const detail = tried.slice(0, 6)
        .map((t) => {
          const size = attempts.find((a) => a.path === t.path)?.size
          return `${t.path}${size ? ` (${Math.round(size / 1024)} ko)` : ''}${t.error ? ` [${t.error}]` : ''}`
        })
        .join(', ')
      warnings.push(
        `Aucune table d'items reconnue parmi ${tried.length} fichier(s) : ${detail}. ` +
        (tried[0] && tried[0].env ? describeTables(tried[0].env, tried[0].tables) : '') +
        ` Lance \`npm run dump -- "<fichier>"\` et envoie la sortie.`
      )
    } else {
      const { path: source, table, luaWarnings } = winner
      for (const [id, entry] of numericEntries(table)) {
        if (!entry || typeof entry !== 'object') continue
        const item = ensure(id)
        const name = pick(entry, LUA_FIELDS.name)
        const nameUnid = pick(entry, LUA_FIELDS.nameUnid)
        if (typeof name === 'string' && name) item.name = name
        if (typeof nameUnid === 'string' && nameUnid) item.nameUnid = nameUnid
        const res = pick(entry, LUA_FIELDS.res) ?? pick(entry, LUA_FIELDS.resUnid)
        if (typeof res === 'string' && res) item.res = res
        const slots = pick(entry, LUA_FIELDS.slots)
        if (typeof slots === 'number') item.slots = slots
        const classNum = pick(entry, LUA_FIELDS.classNum)
        if (typeof classNum === 'number') item.classNum = classNum
        const desc = textLines(entry.identifiedDescriptionName)
        if (desc.length) item.desc = desc
        const descUnid = textLines(entry.unidentifiedDescriptionName)
        if (descUnid.length) item.descUnid = descUnid
      }
      sources.push(source)
      for (const w of luaWarnings || []) warnings.push(`${source} : ${w}`)
    }
  }

  // --- 2. tables texte (complement / secours) ------------------------------
  const readTable = (path, parser) => {
    const buf = vfs.read(path)
    if (!buf) return null
    sources.push(path)
    return parser(decode(buf, encoding))
  }

  const names = readTable(TEXT_TABLES.displayName, parseSimpleTable)
  const namesUnid = readTable(TEXT_TABLES.displayNameUnid, parseSimpleTable)
  const res = readTable(TEXT_TABLES.resName, parseSimpleTable)
  const slots = readTable(TEXT_TABLES.slots, parseSimpleTable)
  const descs = readTable(TEXT_TABLES.desc, parseDescTable)
  const descsUnid = readTable(TEXT_TABLES.descUnid, parseDescTable)

  const applyMap = (map, apply) => {
    if (!map) return
    for (const [key, value] of map) {
      const id = Number(key)
      if (!Number.isInteger(id) || id <= 0) continue
      apply(ensure(id), value)
    }
  }

  applyMap(names, (item, v) => { if (!item.name && v) item.name = v })
  applyMap(namesUnid, (item, v) => { if (!item.nameUnid && v) item.nameUnid = v })
  applyMap(res, (item, v) => { if (!item.res && v) item.res = v })
  applyMap(slots, (item, v) => {
    const n = Number(v)
    if (item.slots === undefined && Number.isInteger(n)) item.slots = n
  })
  applyMap(descs, (item, v) => { if (!item.desc && v.length) item.desc = v })
  applyMap(descsUnid, (item, v) => { if (!item.descUnid && v.length) item.descUnid = v })

  // Un item sans nom identifie retombe sur son nom non identifie.
  for (const item of items.values()) {
    if (!item.name && item.nameUnid) item.name = item.nameUnid
  }

  // Les entrees totalement vides (ids reserves) ne servent a rien.
  for (const [id, item] of items) {
    if (!item.name) items.delete(id)
  }

  if (!items.size) warnings.push('Aucun item extrait : verifie le chemin du client et l\'encodage.')
  return { items, sources, warnings }
}

/**
 * Quand rien n'est reconnu, dire ce qui a ete vu vaut mieux qu'un constat
 * d'echec : les noms de champs suffisent generalement a caler le parseur.
 */
function describeTables(env, tables) {
  const globals = Object.keys(env).filter((k) => env[k] && typeof env[k] === 'object')
  const biggest = tables
    .filter((t) => t && typeof t === 'object')
    .sort((a, b) => Object.keys(b).length - Object.keys(a).length)[0]
  const fields = biggest
    ? [...new Set(Object.values(biggest).flatMap((v) =>
        v && typeof v === 'object' ? Object.keys(v).filter((k) => !/^-?\d+$/.test(k)) : []))].slice(0, 12)
    : []
  return `Globales : ${globals.join(', ') || 'aucune'}.` +
    (biggest ? ` Plus grosse table : ${Object.keys(biggest).length} cles` : '') +
    (fields.length ? `, champs ${fields.join(', ')}.` : '.')
}

/** Une table est une table d'items si ses valeurs portent les bons champs. */
function scoreItemTable(value) {
  if (!value || typeof value !== 'object') return 0
  const entries = numericEntries(value)
  if (entries.length < 4) return 0
  return entries.filter(([, v]) =>
    v && typeof v === 'object' &&
    (v.unidentifiedDisplayName !== undefined || v.identifiedDisplayName !== undefined)
  ).length
}

/**
 * Repli quand la table n'est dans aucune globale : les fichiers officiels la
 * declarent parfois en local, ou la construisent dans une fonction.
 */
function bestItemTable(tables) {
  let best = null
  let bestScore = 0
  for (const table of tables) {
    const score = scoreItemTable(table)
    if (score > bestScore) { best = table; bestScore = score }
  }
  return bestScore >= 4 ? best : null
}

/** La table d'items s'appelle `tbl` dans kRO, mais pas dans tous les repacks. */
function findItemTable(env) {
  if (env.tbl && typeof env.tbl === 'object') return env.tbl
  let best = null
  let bestScore = 0
  for (const value of Object.values(env)) {
    const score = scoreItemTable(value)
    if (score > bestScore) { best = value; bestScore = score }
  }
  return bestScore >= 4 ? best : null
}
