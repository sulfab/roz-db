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

  // Tous les chemins connus, pas seulement le premier : sur Ragnarok Zero,
  // System/itemInfo_true.lub existe mais ne fait que 162 octets, et s'arreter
  // la faisait manquer la vraie base, 3,3 Mo plus loin.
  // Le meme fichier arrive sous plusieurs ecritures : chemin connu avec des
  // barres obliques, entree d'archive avec des antislashs. Comparer les chaines
  // telles quelles le faisait essayer — et signaler — trois fois.
  const seen = new Set()
  const addAll = (entries) => {
    for (const entry of entries) {
      const name = entry.name ?? entry
      const key = name.toLowerCase().replace(/\\/g, '/')
      if (seen.has(key)) continue
      seen.add(key)
      let buffer
      try {
        buffer = vfs.read(name)
      } catch (err) {
        // Une lecture qui echoue doit se voir : l'avaler en silence donnait un
        // "aucune table reconnue" qui ne disait pas que le fichier existait.
        tried.push({ path: name, score: 0, error: err.message })
        continue
      }
      // Les chemins connus arrivent sans taille : on prend celle du contenu,
      // sinon un candidat ecarte serait rapporte sans son poids.
      if (buffer) attempts.push({ path: name, buffer, size: entry.size ?? buffer.length })
    }
  }

  addAll(ITEM_INFO_CANDIDATES)
  addAll(discoverItemFiles(vfs))
  addAll(discoverBigLuaFiles(vfs))

  // Le plus gros d'abord : une base d'items complete se reconnait a sa taille.
  attempts.sort((a, b) => b.size - a.size)

  if (!attempts.length && !tried.length) {
    warnings.push(`Aucun fichier d'items trouve (cherche : ${ITEM_INFO_CANDIDATES.join(', ')})`)
  } else if (!attempts.length) {
    warnings.push(
      `Aucun fichier d'items lisible. ` +
      tried.map((t) => `${t.path} : ${t.error}`).join(' ; ')
    )
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
        tried.push({ path: attempt.path, score, env, tables, luaWarnings, size: attempt.size })
        if (table && (!winner || score > winner.score)) {
          winner = { path: attempt.path, table, score, luaWarnings }
        }
      } catch (err) {
        tried.push({ path: attempt.path, score: 0, error: err.message, size: attempt.size })
      }
      // Une base d'items complete se reconnait tout de suite : inutile de
      // continuer a executer des fichiers une fois qu'on la tient.
      if (winner && winner.score >= 100) break
    }

    // Les candidats sont traites du plus gros au plus petit : ceux qui
    // precedent le gagnant sont plus gros que lui et n'ont rien donne. C'est
    // l'information la plus utile du lot, l'un d'eux est peut-etre la vraie
    // base. La taire laissait croire que le gagnant etait le bon fichier.
    const winnerIndex = winner ? tried.findIndex((t) => t.path === winner.path) : tried.length
    const skipped = tried.slice(0, Math.max(0, winnerIndex)).filter((t) => t.score === 0)
    if (skipped.length) {
      warnings.push(
        `${skipped.length} fichier(s) plus gros ecarte(s) : ` +
        skipped.slice(0, 4).map((t) => {
          const size = t.size ? ` (${Math.round(t.size / 1024)} ko)` : ''
          const why = t.error || (t.luaWarnings || []).join(' ; ') || 'aucune table d\'items reconnue'
          return `${t.path}${size} : ${why}`
        }).join(' ; ')
      )
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
      const analysis = analyzeItemTable(table)

      if (analysis.shape === 'noms') {
        // Table id -> nom : c'est parfois tout ce qu'un client embarque.
        for (const [id, name] of analysis.entries) ensure(id).name = name
      } else {
        // Sans champs reconnus, on les identifie par leurs valeurs plutot que
        // de renoncer : un nom est une chaine presque toujours differente, un
        // nombre de slots un petit entier, une description une liste de lignes.
        const inferred = analysis.named ? null : inferFields(analysis.entries)
        if (inferred) {
          warnings.push(
            `${source} : champs deduits — nom=${inferred.name ?? 'aucun'}, ` +
            `slots=${inferred.slots ?? 'aucun'}, description=${inferred.desc ?? 'aucune'}. ` +
            `Verifie deux ou trois items dans l'app.`
          )
        }

        const nameFields = inferred?.name ? [inferred.name, ...LUA_FIELDS.name] : LUA_FIELDS.name
        const slotFields = inferred?.slots ? [inferred.slots, ...LUA_FIELDS.slots] : LUA_FIELDS.slots

        for (const [id, entry] of analysis.entries) {
          const item = ensure(id)
          const name = pick(entry, nameFields)
          const nameUnid = pick(entry, LUA_FIELDS.nameUnid)
          if (typeof name === 'string' && name) item.name = name
          if (typeof nameUnid === 'string' && nameUnid) item.nameUnid = nameUnid

          const res = pick(entry, LUA_FIELDS.res) ?? pick(entry, LUA_FIELDS.resUnid)
          if (typeof res === 'string' && res) item.res = res

          const slots = pick(entry, slotFields)
          if (typeof slots === 'number') item.slots = slots

          const classNum = pick(entry, LUA_FIELDS.classNum)
          if (typeof classNum === 'number') item.classNum = classNum

          const desc = textLines(entry.identifiedDescriptionName ?? (inferred?.desc ? entry[inferred.desc] : undefined))
          if (desc.length) item.desc = desc
          const descUnid = textLines(entry.unidentifiedDescriptionName)
          if (descUnid.length) item.descUnid = descUnid
        }
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

/** Plage ou vivent les identifiants d'items, toutes extensions confondues. */
const ITEM_ID_MIN = 100
const ITEM_ID_MAX = 100_000
/** Sans champ reconnu, il faut beaucoup d'entrees pour conclure. */
const MIN_INFERRED_ENTRIES = 50

/**
 * Quand les champs ne portent pas les noms attendus, on les reconnait a leurs
 * valeurs : un nom est une chaine presente partout et presque toujours
 * differente ; un nombre de slots est un petit entier ; une description est une
 * liste de lignes.
 */
function inferFields(entries) {
  const sample = entries.slice(0, 800)
  const stats = new Map()
  const note = (key, kind) => {
    const s = stats.get(key) || { strings: 0, numbers: 0, lists: 0, distinct: new Set(), small: 0 }
    s[kind]++
    stats.set(key, s)
    return s
  }

  for (const [, value] of sample) {
    for (const [key, v] of Object.entries(value)) {
      if (typeof v === 'string' && v) note(key, 'strings').distinct.add(v)
      else if (typeof v === 'number') { const s = note(key, 'numbers'); if (v >= 0 && v <= 4) s.small++ }
      else if (v && typeof v === 'object') {
        const lines = toArray(v)
        if (lines.length && lines.every((l) => typeof l === 'string')) note(key, 'lists')
      }
    }
  }

  const pickBy = (score) => [...stats.entries()]
    .map(([key, s]) => ({ key, value: score(s) }))
    .filter((c) => c.value > 0)
    .sort((a, b) => b.value - a.value)[0]?.key

  // Un libelle est present sur presque toutes les entrees et presque toujours
  // different. Un champ present partout mais qui ne prend que quelques valeurs
  // est une categorie, pas un nom.
  const NAME_VARIETY = 0.5
  return {
    name: pickBy((s) => (
      s.strings > sample.length * 0.5 && s.distinct.size >= s.strings * NAME_VARIETY
        ? s.distinct.size
        : 0
    )),
    slots: pickBy((s) => (s.numbers > sample.length * 0.5 && s.small === s.numbers ? s.numbers : 0)),
    desc: pickBy((s) => s.lists),
  }
}

/**
 * Reconnait une table d'items sans exiger des noms de champs precis.
 *
 * Deux formes existent : la table detaillee des clients classiques (id -> objet
 * decrivant l'item) et la simple table de noms (id -> chaine), qui est parfois
 * tout ce qu'un client embarque. Exiger `identifiedDisplayName` faisait passer
 * la seconde pour rien du tout.
 */
export function analyzeItemTable(value) {
  if (!value || typeof value !== 'object') return null
  const entries = numericEntries(value).filter(([id]) => id >= ITEM_ID_MIN && id <= ITEM_ID_MAX)
  if (entries.length < 2) return null

  const objects = entries.filter(([, v]) => v && typeof v === 'object')
  const strings = entries.filter(([, v]) => typeof v === 'string' && v.length > 0)

  if (objects.length >= entries.length * 0.8) {
    const named = objects.filter(([, v]) =>
      v.identifiedDisplayName !== undefined || v.unidentifiedDisplayName !== undefined
    ).length
    // Des champs reconnus sont une preuve forte : deux entrees ne sont pas une
    // coincidence. La forme seule est une preuve faible : il en faut beaucoup.
    if (named >= 2) return { shape: 'objet', entries: objects, named, score: named * 10 }

    if (objects.length >= MIN_INFERRED_ENTRIES) {
      // Une table d'items sans champ reconnu doit au moins porter un libelle.
      // Sans ce garde-fou, n'importe quelle table indexee par identifiant
      // d'item passait pour une base de noms — les proprietes d'equipement,
      // par exemple, dont le champ le plus varie n'est qu'une categorie.
      const fields = inferFields(objects)
      if (fields.name) return { shape: 'objet', entries: objects, named: 0, fields, score: objects.length }
    }
    return null
  }

  if (strings.length >= entries.length * 0.8 && strings.length >= MIN_INFERRED_ENTRIES) {
    return { shape: 'noms', entries: strings, named: 0, score: strings.length }
  }
  return null
}

/** Une table est une table d'items si ses valeurs portent les bons champs. */
function scoreItemTable(value) {
  const analyzed = analyzeItemTable(value)
  return analyzed ? analyzed.score : 0
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
  return best
}

/** La table d'items s'appelle `tbl` dans kRO, mais pas dans tous les repacks. */
function findItemTable(env) {
  if (env.tbl && scoreItemTable(env.tbl) > 0) return env.tbl
  let best = null
  let bestScore = 0
  for (const value of Object.values(env)) {
    const score = scoreItemTable(value)
    if (score > bestScore) { best = value; bestScore = score }
  }
  return best
}
