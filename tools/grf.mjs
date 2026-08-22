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
    const sig = header.subarray(0, SIGNATURE.length).toString('latin1')
    if (sig !== SIGNATURE) throw new Error(`${this.path}: signature GRF absente (lu "${sig}")`)

    this.version = header.readUInt32LE(0x2a)
    if (this.version !== 0x200) {
      throw new Error(
        `${this.path}: version GRF 0x${this.version.toString(16)} non geree (seul 0x200 l'est). ` +
        `Repacke l'archive avec GRF Editor si besoin.`
      )
    }

    const tableOffset = header.readUInt32LE(0x1e)
    const seed = header.readUInt32LE(0x22)
    const declared = header.readUInt32LE(0x26) - seed - 7

    const sizes = this.#read(HEADER_SIZE + tableOffset, 8)
    const packedLen = sizes.readUInt32LE(0)
    const realLen = sizes.readUInt32LE(4)
    const packed = this.#read(HEADER_SIZE + tableOffset + 8, packedLen)
    const table = zlib.inflateSync(packed)
    if (table.length !== realLen) {
      throw new Error(`${this.path}: table des fichiers corrompue (${table.length} != ${realLen})`)
    }

    let p = 0
    while (p < table.length) {
      const end = table.indexOf(0, p)
      if (end < 0) break
      const rawName = table.subarray(p, end)
      p = end + 1
      if (p + 17 > table.length) break
      const entry = {
        name: decode(rawName, this.encoding),
        key: rawName.toString('latin1').toLowerCase().replace(/\\/g, '/'),
        packed: table.readUInt32LE(p),
        aligned: table.readUInt32LE(p + 4),
        size: table.readUInt32LE(p + 8),
        flags: table.readUInt8(p + 12),
        offset: table.readUInt32LE(p + 13),
      }
      p += 17
      if (entry.flags & FLAG_FILE) this.entries.set(entry.key, entry)
    }
    this.declaredCount = declared
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
