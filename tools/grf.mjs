import fs from 'node:fs'
import zlib from 'node:zlib'
import { decode, pathKey } from './encoding.mjs'

/**
 * Lecteur d'archives GRF (format 0x200, celui de tous les clients modernes).
 *
 * En-tete, 46 octets :
 *   0x00  char signature[15]   "Master of Magic"
 *   0x0f  char encryption[15]
 *   0x1e  u32  fileTableOffset (relatif a la fin de l'en-tete)
 *   0x22  u32  seed
 *   0x26  u32  fileCountRaw    (nb reel = raw - seed - 7)
 *   0x2a  u32  version         (0x200)
 *
 * Table des fichiers (0x200) : u32 compressedLen, u32 realLen, puis un bloc
 * deflate contenant, pour chaque entree : nom termine par \0, u32 tailleCompressee,
 * u32 tailleCompresseeAlignee, u32 tailleReelle, u8 flags, u32 offset.
 */

const HEADER_SIZE = 0x2e
const SIGNATURE = 'Master of Magic'

/** En-tete de table : 8 octets en 0x200, davantage dans les versions suivantes. */
const TABLE_HEADER_MIN = 8
const TABLE_HEADER_MAX = 32
const TABLE_WINDOW = 64
const MIN_ENTRY_BYTES = 19

/**
 * Certains clients recents (dont Ragnarok Zero) remplacent la chaine magique
 * par autre chose — "Event Horizon" par exemple — sans changer le format pour
 * autant. On ne valide donc pas sur la signature, mais sur ce qui compte
 * vraiment : une version connue et une table des fichiers qui se decompresse.
 */
export function isKnownSignature(sig) {
  return sig.startsWith(SIGNATURE)
}

export const FLAG_FILE = 0x01
export const FLAG_DES_FULL = 0x02   // fichier entierement chiffre (DES RO)
export const FLAG_DES_HEADER = 0x04 // seuls les premiers blocs sont chiffres

export class Grf {
  constructor(path, { encoding = 'cp949' } = {}) {
    this.path = path
    this.encoding = encoding
    this.fd = fs.openSync(path, 'r')
    /** @type {Map<string, {name: string, key: string, size: number, packed: number, aligned: number, offset: number, flags: number}>} */
    this.entries = new Map()
    this.#readTable()

  }

  #read(offset, length) {
    const buf = Buffer.alloc(length)
    fs.readSync(this.fd, buf, 0, length, offset)
    return buf
  }

  #readTable() {
    const header = this.#read(0, HEADER_SIZE)
    this.signature = header.subarray(0, SIGNATURE.length).toString('latin1').replace(/\0.*$/, '')
    this.customSignature = !isKnownSignature(this.signature)

    this.version = header.readUInt32LE(0x2a)
    const tableOffset = header.readUInt32LE(0x1e)
    const seed = header.readUInt32LE(0x22)
    this.declaredCount = header.readUInt32LE(0x26) - seed - 7
    this.fileSize = fs.fstatSync(this.fd).size

    const tableAt = HEADER_SIZE + tableOffset
    if (tableOffset <= 0 || tableAt + TABLE_HEADER_MIN >= this.fileSize) {
      throw new Error(
        `${this.path}: offset de table hors limites (${tableOffset} pour un fichier de ` +
        `${this.fileSize} octets), version 0x${this.version.toString(16)}, ` +
        `signature "${this.signature}". Lance \`npm run probe -- "${this.path}"\`.`
      )
    }

    const table = this.#inflateTable(tableAt)
    this.entries = parseEntries(table, this.fileSize, this)
  }

  /**
   * Decompresse la table des fichiers.
   *
   * L'en-tete de table fait 8 octets en 0x200 et davantage dans les versions
   * plus recentes (0x300, celle de Ragnarok Zero). Plutot que de coder une
   * taille par version — dont la liste n'est ni publique ni stable — on essaie
   * les decalages plausibles et on garde celui qui decompresse vraiment.
   */
  #inflateTable(tableAt) {
    const window = this.#read(tableAt, Math.min(TABLE_WINDOW, this.fileSize - tableAt))
    const errors = []

    for (let skip = TABLE_HEADER_MIN; skip <= TABLE_HEADER_MAX; skip += 4) {
      if (!looksZlib(window, skip)) continue
      const stream = this.#read(tableAt + skip, this.fileSize - tableAt - skip)
      try {
        // Z_SYNC_FLUSH : le flux peut etre suivi d'octets de bourrage.
        const out = zlib.inflateSync(stream, { finishFlush: zlib.constants.Z_SYNC_FLUSH })
        // Une entree fait au minimum un nom d'un caractere, son \0 et 17 octets.
        if (out.length >= MIN_ENTRY_BYTES) {
          this.tableHeaderSize = skip
          return out
        }
      } catch (err) {
        errors.push(`+${skip}: ${err.message}`)
      }
    }

    throw new Error(
      `${this.path}: table des fichiers illisible (version 0x${this.version.toString(16)}, ` +
      `signature "${this.signature}"). Aucun flux zlib exploitable entre ` +
      `+${TABLE_HEADER_MIN} et +${TABLE_HEADER_MAX} de l'offset de table. ` +
      `L'archive est probablement chiffree. ` +
      `Lance \`npm run probe -- "${this.path}"\` et envoie la sortie.`
    )
  }

  has(path) {
    return this.entries.has(pathKey(path, this.encoding))
  }

  /** @returns {Buffer|null} */
  read(path) {
    const entry = this.entries.get(pathKey(path, this.encoding))
    return entry ? this.readEntry(entry) : null
  }

  readEntry(entry) {
    if (entry.flags & (FLAG_DES_FULL | FLAG_DES_HEADER)) {
      throw new Error(
        `${entry.name} est chiffre en DES dans ${this.path}. ` +
        `Extrais-le avec GRF Editor dans un dossier data/ a cote du client, ` +
        `l'extraction le reprendra depuis la.`
      )
    }
    const raw = this.#read(HEADER_SIZE + entry.offset, entry.aligned)
    if (entry.packed === entry.size) return raw.subarray(0, entry.size)
    const out = zlib.inflateSync(raw.subarray(0, entry.packed))
    return out.subarray(0, entry.size)
  }

  /** Liste les entrees dont le chemin (octets bruts, minuscules) matche le predicat. */
  list(predicate) {
    const out = []
    for (const entry of this.entries.values()) {
      if (!predicate || predicate(entry.key, entry)) out.push(entry)
    }
    return out
  }

  close() {
    fs.closeSync(this.fd)
  }
}

export function openGrf(path, opts) {
  return new Grf(path, opts)
}

/** Un flux zlib commence par 0x78 suivi d'un octet de controle coherent. */
function looksZlib(buf, at) {
  if (at + 1 >= buf.length) return false
  if (buf[at] !== 0x78) return false
  return ((buf[at] << 8) | buf[at + 1]) % 31 === 0
}

/**
 * Dispositions connues d'une entree, apres le nom termine par \0.
 *
 * Les archives depassant 4 Go ne peuvent plus adresser leurs donnees sur
 * 32 bits : une variante 64 bits est donc plausible sur les gros GRF recents.
 * On ne choisit pas a l'avance — on lit un echantillon avec chaque disposition
 * et on garde celle dont les valeurs sont coherentes avec la taille du fichier.
 */
const ENTRY_LAYOUTS = [
  {
    label: '17 octets, offset 32 bits',
    size: 17,
    read: (t, p) => ({
      packed: t.readUInt32LE(p),
      aligned: t.readUInt32LE(p + 4),
      size: t.readUInt32LE(p + 8),
      flags: t.readUInt8(p + 12),
      offset: t.readUInt32LE(p + 13),
    }),
  },
  {
    label: '21 octets, offset 64 bits',
    size: 21,
    read: (t, p) => ({
      packed: t.readUInt32LE(p),
      aligned: t.readUInt32LE(p + 4),
      size: t.readUInt32LE(p + 8),
      flags: t.readUInt8(p + 12),
      offset: Number(t.readBigUInt64LE(p + 13)),
    }),
  },
]

/** Une entree est credible si elle designe une plage reelle du fichier. */
function plausible(entry, fileSize) {
  return (
    entry.flags > 0 && entry.flags < 0x20 &&
    entry.aligned >= entry.packed &&
    entry.offset >= 0 &&
    entry.offset + entry.aligned <= fileSize &&
    entry.size < 1 << 30
  )
}

/**
 * @param {object} options limit : nombre d'entrees a lire ; maxBad : au-dela de
 *   combien d'entrees incoherentes on considere qu'on lit du bruit.
 */
function walk(table, layout, fileSize, { limit = Infinity, maxBad = 4 } = {}) {
  const entries = []
  let p = 0
  let bad = 0
  while (p < table.length && entries.length < limit) {
    const end = table.indexOf(0, p)
    if (end < 0 || end === p || end - p > 260) break
    const rawName = table.subarray(p, end)
    p = end + 1
    if (p + layout.size > table.length) break
    const entry = layout.read(table, p)
    p += layout.size
    if (!plausible(entry, fileSize)) { bad++; if (bad > maxBad) break; continue }
    entry.name = rawName.toString('latin1')
    entry.rawName = rawName
    entries.push(entry)
  }
  return { entries, bad }
}

function parseEntries(table, fileSize, grf) {
  const scored = ENTRY_LAYOUTS.map((layout) => {
    const { entries, bad } = walk(table, layout, fileSize, { limit: 300 })
    return { layout, count: entries.length, score: entries.length - bad * 10 }
  }).sort((a, b) => b.score - a.score)

  const best = scored[0]
  if (!best || best.count === 0 || best.score <= 0) {
    throw new Error(
      `${grf.path}: table des fichiers decompressee mais illisible ` +
      `(version 0x${grf.version.toString(16)}, aucune disposition d'entree reconnue). ` +
      `Lance \`npm run probe -- "${grf.path}"\` et envoie la sortie.`
    )
  }

  grf.entryLayout = best.layout.label
  const map = new Map()
  // Sur une grosse archive, quelques entrees aberrantes ne doivent pas
  // interrompre la lecture des 170 000 autres.
  const full = walk(table, best.layout, fileSize, { maxBad: 1000 })
  grf.skippedEntries = full.bad
  for (const entry of full.entries) {
    if (!(entry.flags & FLAG_FILE)) continue
    map.set(entry.name.toLowerCase().replace(/\\/g, '/'), {
      name: decode(entry.rawName, grf.encoding),
      key: entry.name.toLowerCase().replace(/\\/g, '/'),
      packed: entry.packed,
      aligned: entry.aligned,
      size: entry.size,
      flags: entry.flags,
      offset: entry.offset,
    })
  }
  return map
}
