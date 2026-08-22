import { decode } from '../encoding.mjs'
import { parseLua, isCompiledLua, toArray, numericEntries } from '../lua.mjs'
import { parseSimpleTable, parseDescTable } from './tables.mjs'

/**
 * Items.
 *
 * Deux sources dans le client, complementaires :
 *  - System/itemInfo*.lub : la table complete (nom identifie/non identifie,
 *    description, nombre de slots, ClassNum pour l'icone). Souvent compilee.
 *  - data/*table.txt      : les memes donnees eclatees en tables texte, toujours
 *    lisibles. C'est le filet de securite quand le .lub est du bytecode.
 */

const ITEM_INFO_CANDIDATES = [
  'System/itemInfo.lub',
  'System/itemInfo_true.lub',
  'System/itemInfo_Sak.lub',
  'System/iteminfo.lua',
  'data/luafiles514/lua files/datainfo/iteminfo.lub',
  'data/luafiles514/lua files/datainfo/iteminfo_true.lub',
]

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
  const found = vfs.readAny(ITEM_INFO_CANDIDATES)
  if (!found) {
    warnings.push(`Aucun itemInfo trouve (cherche : ${ITEM_INFO_CANDIDATES.join(', ')})`)
  } else if (isCompiledLua(found.buffer)) {
    warnings.push(
      `${found.path} est du bytecode Lua compile : on retombe sur les tables texte. ` +
      `Pour recuperer les descriptions completes, decompile-le ` +
      `(unluac / luadec) et depose le resultat en clair dans data/.`
    )
  } else {
    try {
      const { env, warnings: luaWarnings } = parseLua(decode(found.buffer, encoding))
      const table = findItemTable(env)
      if (!table) {
        warnings.push(`${found.path} : aucune table d'items reconnue`)
      } else {
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
        sources.push(found.path)
        if (luaWarnings.length) {
          warnings.push(`${found.path} : ${luaWarnings.length} fragment(s) ignore(s) par le parseur Lua`)
        }
      }
    } catch (err) {
      warnings.push(`${found.path} : ${err.message}`)
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

/** La table d'items s'appelle `tbl` dans kRO, mais pas dans tous les repacks. */
function findItemTable(env) {
  if (env.tbl && typeof env.tbl === 'object') return env.tbl
  let best = null
  let bestScore = 0
  for (const value of Object.values(env)) {
    if (!value || typeof value !== 'object') continue
    const entries = numericEntries(value)
    if (entries.length < 4) continue
    const score = entries.filter(([, v]) =>
      v && typeof v === 'object' &&
      (v.unidentifiedDisplayName !== undefined || v.identifiedDisplayName !== undefined)
    ).length
    if (score > bestScore) { best = value; bestScore = score }
  }
  return bestScore >= 4 ? best : null
}
