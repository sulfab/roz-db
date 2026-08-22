import type { Item, Mob, GameMap, DropTable, Drop, Meta, DropSource } from './types'

/**
 * Chargement des JSON generes + tous les index croises dont l'app a besoin.
 *
 * Tout tient en memoire (quelques Mo) : une fois charge, chaque question du
 * type "qui droppe cet item" ou "que droppe ce mob" est une lecture de Map.
 */

export interface Db {
  items: Map<number, Item>
  mobs: Map<number, Mob>
  maps: Map<string, GameMap>
  drops: DropTable
  meta: Meta | null
  /** mobId -> drops (deja trie par taux decroissant) */
  dropsByMob: Map<number, Drop[]>
  /** itemId -> mobs qui le droppent, tri par taux decroissant */
  dropsByItem: Map<number, DropSource[]>
  hasDrops: boolean
  /** false quand la navigation ne donne que la presence, sans nombre. */
  hasPopulations: boolean
  itemList: Item[]
  mobList: Mob[]
  mapList: GameMap[]
}

async function loadJson<T>(name: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(`./data/${name}`)
    if (!res.ok) return fallback
    return (await res.json()) as T
  } catch {
    return fallback
  }
}

/** Accents et casse retires : la recherche doit trouver "epee" sur "Épée". */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

async function loadIcons(): Promise<Set<number> | null> {
  try {
    const res = await fetch('./icons/manifest.json')
    if (!res.ok) return null
    return new Set((await res.json()) as number[])
  } catch {
    return null
  }
}

export async function loadDb(): Promise<Db> {
  const [rawItems, rawMobs, rawMaps, drops, meta, icons] = await Promise.all([
    loadJson<Record<string, Item>>('items.json', {}),
    loadJson<Record<string, Mob>>('mobs.json', {}),
    loadJson<Record<string, GameMap>>('maps.json', {}),
    loadJson<DropTable>('drops.json', { meta: { source: null, importedAt: null }, mobs: {} }),
    loadJson<Meta | null>('meta.json', null),
    loadIcons(),
  ])
  iconIds = icons

  const items = new Map<number, Item>()
  for (const item of Object.values(rawItems)) items.set(item.id, item)
  const mobs = new Map<number, Mob>()
  for (const mob of Object.values(rawMobs)) mobs.set(mob.id, mob)
  const maps = new Map<string, GameMap>()
  for (const map of Object.values(rawMaps)) maps.set(map.id, map)

  const dropsByMob = new Map<number, Drop[]>()
  const dropsByItem = new Map<number, DropSource[]>()

  for (const [mobKey, list] of Object.entries(drops.mobs || {})) {
    const mobId = Number(mobKey)
    const mob = mobs.get(mobId)
    const sorted = [...list].sort((a, b) => b.chance - a.chance)
    dropsByMob.set(mobId, sorted)
    if (!mob) continue // drop pour un mob absent du client : on l'ignore cote item
    for (const drop of sorted) {
      const sources = dropsByItem.get(drop.item) || []
      sources.push({ mob, chance: drop.chance, label: drop.label })
      dropsByItem.set(drop.item, sources)
    }
  }
  for (const sources of dropsByItem.values()) sources.sort((a, b) => b.chance - a.chance)

  const itemList = [...items.values()].sort((a, b) => a.name.localeCompare(b.name))
  const mobList = [...mobs.values()].sort((a, b) => a.name.localeCompare(b.name))
  const mapList = [...maps.values()].sort((a, b) => a.name.localeCompare(b.name))

  return {
    items, mobs, maps, drops, meta,
    dropsByMob, dropsByItem,
    hasDrops: dropsByMob.size > 0,
    hasPopulations: meta?.hasPopulations !== false,
    itemList, mobList, mapList,
  }
}

// --- recherche -------------------------------------------------------------

export type Hit =
  | { kind: 'item'; item: Item; score: number }
  | { kind: 'mob'; mob: Mob; score: number }
  | { kind: 'map'; map: GameMap; score: number }

/**
 * Score : un prefixe vaut mieux qu'un mot interne, qui vaut mieux qu'une
 * sous-chaine quelconque. Suffisant et instantane sur ~20 000 entrees.
 */
function score(haystack: string, needle: string): number {
  const at = haystack.indexOf(needle)
  if (at < 0) return 0
  if (at === 0) return haystack.length === needle.length ? 100 : 80
  if (haystack[at - 1] === ' ') return 60
  return 30
}

export function search(db: Db, query: string, limit = 50): Hit[] {
  const needle = normalize(query.trim())
  if (needle.length < 1) return []
  const hits: Hit[] = []

  const numeric = /^\d+$/.test(needle) ? Number(needle) : null
  if (numeric !== null) {
    const item = db.items.get(numeric)
    if (item) hits.push({ kind: 'item', item, score: 200 })
    const mob = db.mobs.get(numeric)
    if (mob) hits.push({ kind: 'mob', mob, score: 200 })
  }

  for (const item of db.itemList) {
    const s = score(normalize(item.name), needle)
    if (s) hits.push({ kind: 'item', item, score: s })
  }
  for (const mob of db.mobList) {
    const s = Math.max(
      score(normalize(mob.name), needle),
      mob.nameLocal ? score(mob.nameLocal.toLowerCase(), needle) : 0,
      mob.sprite ? score(normalize(mob.sprite), needle) * 0.5 : 0
    )
    if (s) hits.push({ kind: 'mob', mob, score: s })
  }
  for (const map of db.mapList) {
    const s = Math.max(score(normalize(map.name), needle), score(map.id, needle) * 0.9)
    if (s) hits.push({ kind: 'map', map, score: s })
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit)
}

// --- helpers metier --------------------------------------------------------

/** Ou farmer cet item : le meilleur couple (taux, population) par carte. */
export interface FarmSpot {
  mob: Mob
  chance: number
  map: GameMap | null
  amount: number | null
}

export function farmSpots(db: Db, itemId: number): FarmSpot[] {
  const spots: FarmSpot[] = []
  for (const source of db.dropsByItem.get(itemId) || []) {
    const spawns = source.mob.spawns || []
    if (!spawns.length) {
      spots.push({ mob: source.mob, chance: source.chance, map: null, amount: 0 })
      continue
    }
    for (const spawn of spawns) {
      spots.push({
        mob: source.mob,
        chance: source.chance,
        map: db.maps.get(spawn.map) || null,
        amount: spawn.amount,
      })
    }
  }
  // Le taux prime ; a taux egal, la carte la plus peuplee.
  return spots.sort((a, b) => b.chance - a.chance || (b.amount ?? 0) - (a.amount ?? 0))
}

/** Tout ce qui tombe sur une carte donnee, agrege par item. */
export function mapLoot(db: Db, map: GameMap): Array<{ item: Item; chance: number; mob: Mob }> {
  const best = new Map<number, { item: Item; chance: number; mob: Mob }>()
  for (const entry of map.mobs) {
    const mob = db.mobs.get(entry.id)
    if (!mob) continue
    for (const drop of db.dropsByMob.get(entry.id) || []) {
      const item = db.items.get(drop.item)
      if (!item) continue
      const current = best.get(drop.item)
      if (!current || drop.chance > current.chance) best.set(drop.item, { item, chance: drop.chance, mob })
    }
  }
  return [...best.values()].sort((a, b) => b.chance - a.chance)
}

/** Toute l'interface est en francais : la virgule decimale aussi. */
export function formatChance(chance: number): string {
  const decimals = chance >= 10 ? 0 : chance >= 1 ? 1 : chance >= 0.01 ? 2 : 4
  return `${chance.toFixed(decimals).replace('.', ',')} %`
}

/** "0,01 %" parle mal ; "1 sur 10 000" parle tout de suite. */
export function formatOdds(chance: number): string {
  if (chance <= 0) return ''
  if (chance >= 100) return 'systematique'
  const one = 100 / chance
  // Sous 10 tirages, l'arrondi a l'entier ecraserait la difference entre
  // 70 % (1 sur 1,4) et 95 % (1 sur 1,1).
  return one < 10
    ? `1 sur ${one.toFixed(1).replace('.', ',')}`
    : `1 sur ${Math.round(one).toLocaleString('fr-FR')}`
}

/**
 * Icones : elles sont optionnelles (`npm run icons`). Sans manifeste, l'app
 * demanderait une image par item et remplirait la console de 404.
 */
let iconIds: Set<number> | null = null

export function hasIcon(id: number): boolean {
  return iconIds !== null && iconIds.has(id)
}
