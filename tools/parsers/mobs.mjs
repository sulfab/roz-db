import { numericEntries } from '../lua.mjs'
import { loadLua } from '../luadata.mjs'

/**
 * Mobs.
 *
 * Le client ne connait pas les *statistiques* des monstres (elles arrivent du
 * serveur par paquet), mais il connait :
 *  - la correspondance id <-> constante JT_* (npcidentity.lub)
 *  - la correspondance id <-> sprite (jobname.lub)
 *  - les noms localises et les cartes, via les fichiers de navigation.
 *
 * On assemble ces trois sources ; les stats et les drops arrivent par
 * `import-drops.mjs`.
 */

const NPC_IDENTITY = [
  'data/luafiles514/lua files/datainfo/npcidentity.lub',
  'data/luafiles514/lua files/datainfo/npcidentity.lua',
  'System/npcidentity.lub',
]

const JOB_NAME = [
  'data/luafiles514/lua files/datainfo/jobname.lub',
  'data/luafiles514/lua files/datainfo/jobname.lua',
  'System/jobname.lub',
]

/** Plages d'ids ou vivent les monstres dans les clients officiels. */
const MOB_ID_RANGES = [[1001, 3999], [20000, 24999]]

export function looksLikeMobId(id) {
  return MOB_ID_RANGES.some(([lo, hi]) => id >= lo && id <= hi)
}

function readLua(vfs, candidates, encoding, warnings, env) {
  const found = vfs.readAny(candidates)
  if (!found) return null
  try {
    const result = loadLua(found.buffer, { encoding, env })
    for (const w of result.warnings) warnings.push(`${found.path} : ${w}`)
    return { path: found.path, env: result.env }
  } catch (err) {
    warnings.push(`${found.path} : ${err.message}`)
    return null
  }
}

/** jobtbl = { JT_PORING = 1002, ... } */
function findConstants(env) {
  const out = new Map()
  const visit = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 2) return
    for (const [key, v] of Object.entries(value)) {
      if (typeof v === 'number' && /^JT_/.test(key)) out.set(key, v)
      else if (typeof v === 'object') visit(v, depth + 1)
    }
  }
  visit(env, 0)
  return out
}

/** JobNameTable = { [jobtbl.JT_PORING] = "PORING", ... } */
function findSpriteTable(env) {
  let best = null
  let bestSize = 0
  const visit = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 2) return
    const entries = numericEntries(value)
    const strings = entries.filter(([, v]) => typeof v === 'string')
    if (strings.length > bestSize) { best = strings; bestSize = strings.length }
    for (const v of Object.values(value)) if (typeof v === 'object') visit(v, depth + 1)
  }
  visit(env, 0)
  // Une table id -> sprite est trop specifique pour etre confondue avec autre
  // chose : quelques entrees suffisent a la reconnaitre.
  return bestSize >= 3 ? new Map(best) : new Map()
}

/** "PORING" -> "Poring", "BAPHOMET_" -> "Baphomet" */
export function prettifySprite(sprite) {
  return sprite
    .replace(/_+$/, '')
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

/**
 * @returns {{mobs: Map<number, object>, constants: Map<string, number>, sources: string[], warnings: string[]}}
 */
export function extractMobs(vfs, { encoding = 'auto' } = {}) {
  const warnings = []
  const sources = []
  /** @type {Map<number, object>} */
  const mobs = new Map()

  const identity = readLua(vfs, NPC_IDENTITY, encoding, warnings, undefined)
  const constants = identity ? findConstants(identity.env) : new Map()
  if (identity) sources.push(identity.path)
  else warnings.push(`npcidentity introuvable (cherche : ${NPC_IDENTITY.join(', ')})`)

  const jobs = readLua(vfs, JOB_NAME, encoding, warnings, identity ? identity.env : undefined)
  const sprites = jobs ? findSpriteTable(jobs.env) : new Map()
  if (jobs) sources.push(jobs.path)

  const constantById = new Map()
  for (const [name, id] of constants) if (!constantById.has(id)) constantById.set(id, name)

  for (const [id, name] of constantById) {
    if (!looksLikeMobId(id)) continue
    const sprite = sprites.get(id)
    mobs.set(id, {
      id,
      name: sprite ? prettifySprite(sprite) : prettifySprite(name.replace(/^JT_/, '')),
      sprite: typeof sprite === 'string' ? sprite : undefined,
      constant: name,
      nameSource: 'sprite',
    })
  }

  // Des sprites sans constante JT_ (repacks) : on les prend quand meme.
  for (const [id, sprite] of sprites) {
    if (mobs.has(id) || !looksLikeMobId(id) || typeof sprite !== 'string') continue
    mobs.set(id, { id, name: prettifySprite(sprite), sprite, nameSource: 'sprite' })
  }

  if (!mobs.size) {
    warnings.push(
      'Aucun mob identifie depuis datainfo : les noms viendront uniquement des ' +
      'fichiers de navigation.'
    )
  }

  // Les plages d'ids servent a ecarter les classes de joueur d'une liste
  // generique. Pour la jointure avec la navigation, elles n'ont pas a decider :
  // un sprite present dans un fichier de monstres est un monstre.
  const spriteToId = new Map()

  // npcidentity.lub nomme chaque monstre JT_<SPRITE> : la constante donne donc
  // un sprite, y compris pour les monstres absents de jobname.lub.
  for (const [name, id] of constants) {
    const sprite = name.replace(/^JT_/, '').toUpperCase()
    if (sprite) spriteToId.set(sprite, id)
  }
  // jobname.lub est plus sur quand il existe : il ecrase la deduction.
  for (const [id, sprite] of sprites) {
    if (typeof sprite === 'string' && sprite) spriteToId.set(sprite.toUpperCase(), id)
  }

  return { mobs, constants, sprites, spriteToId, sources, warnings }
}
