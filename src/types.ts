/** Formes exactes des fichiers produits par `npm run extract`. */

export interface Item {
  id: number
  /** Nom identifie ; retombe sur le nom non identifie s'il manque. */
  name: string
  nameUnid?: string
  /** Nom de ressource : sert a retrouver l'icone (public/icons/<id>.png). */
  res?: string
  slots?: number
  classNum?: number
  /** Description, une entree par ligne, codes couleur ^RRGGBB compris. */
  desc?: string[]
  descUnid?: string[]
}

export interface Spawn {
  map: string
  amount: number
}

export interface Mob {
  id: number
  name: string
  sprite?: string
  constant?: string
  level?: number
  spawns?: Spawn[]
}

export interface GameMap {
  id: string
  name: string
  mobs: Array<{ id: number; amount: number }>
}

export interface Drop {
  item: number
  /** Pourcentage : 70 = 70 %, 0.01 = 1 sur 10 000. */
  chance: number
  label?: string
}

export interface DropTable {
  meta: { source: string | null; importedAt: string | null; base?: number; mobs?: number; entries?: number }
  mobs: Record<string, Drop[]>
}

export interface Meta {
  generatedAt: string
  client: string
  archives: string[]
  looseData: boolean
  encoding: string
  counts: { items: number; mobs: number; maps: number; spawns: number; mobsWithSpawns: number }
  naviColumns: Record<string, number> | null
  naviConfidence: Record<string, number> | null
  sources: string[]
  warnings: string[]
}

/** Un drop vu depuis l'item : quel mob, a quel taux, et ou le trouver. */
export interface DropSource {
  mob: Mob
  chance: number
  label?: string
}
