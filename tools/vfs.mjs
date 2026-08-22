import fs from 'node:fs'
import path from 'node:path'
import { openGrf } from './grf.mjs'
import { decode } from './encoding.mjs'

/**
 * Systeme de fichiers virtuel du client RO.
 *
 * Le client cherche un fichier d'abord dans le dossier `data/` en clair (les
 * patchs y sont deposes), puis dans les archives GRF dans l'ordre declare par
 * DATA.INI. On reproduit exactement cette priorite, sinon on lit des donnees
 * perimees la ou le client, lui, lit la version patchee.
 */
export class Vfs {
  #listingCache

  constructor(clientDir, { encoding = 'cp949', verbose = false } = {}) {
    this.clientDir = path.resolve(clientDir)
    this.encoding = encoding
    this.verbose = verbose
    this.grfs = []
    this.errors = []
    this.#listingCache = new Map()
    this.looseDir = this.#findLooseData()
    this.#openArchives()
  }

  #findLooseData() {
    for (const name of ['data', 'Data', 'DATA']) {
      const dir = path.join(this.clientDir, name)
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir
    }
    return null
  }

  /** Ordre de chargement declare par DATA.INI, sinon toutes les .grf trouvees. */
  #grfOrder() {
    const iniName = fs.readdirSync(this.clientDir).find((f) => f.toLowerCase() === 'data.ini')
    const found = fs.readdirSync(this.clientDir).filter((f) => f.toLowerCase().endsWith('.grf'))
    if (!iniName) return found.sort()

    const ini = decode(fs.readFileSync(path.join(this.clientDir, iniName)), this.encoding)
    const listed = []
    for (const line of ini.split(/\r?\n/)) {
      const m = /^\s*(\d+)\s*=\s*(.+?)\s*$/.exec(line)
      if (m) listed.push([Number(m[1]), m[2]])
    }
    listed.sort((a, b) => a[0] - b[0])
    const ordered = listed
      .map(([, name]) => found.find((f) => f.toLowerCase() === name.toLowerCase()))
      .filter(Boolean)
    // Les GRF presentes mais absentes de DATA.INI passent en dernier.
    return [...ordered, ...found.filter((f) => !ordered.includes(f))]
  }

  #openArchives() {
    for (const name of this.#grfOrder()) {
      const full = path.join(this.clientDir, name)
      try {
        const grf = openGrf(full, { encoding: this.encoding })
        this.grfs.push({ name, grf })
        if (this.verbose) console.error(`  grf ${name}: ${grf.entries.size} fichiers`)
      } catch (err) {
        this.errors.push(`${name}: ${err.message}`)
      }
    }
  }

  /**
   * Resout un chemin segment par segment sans tenir compte de la casse : les
   * chemins du client sont ecrits a la windows ("System/itemInfo.lub") alors
   * que l'extraction peut tourner sous Linux ou macOS.
   */
  #resolveOnDisk(baseDir, relPath) {
    let current = baseDir
    for (const segment of relPath.split('/')) {
      if (!segment || segment === '.') continue
      if (segment === '..') return null
      const direct = path.join(current, segment)
      if (fs.existsSync(direct)) { current = direct; continue }
      let listing = this.#listingCache.get(current)
      if (!listing) {
        try {
          listing = new Map(fs.readdirSync(current).map((n) => [n.toLowerCase(), n]))
        } catch { return null }
        this.#listingCache.set(current, listing)
      }
      const actual = listing.get(segment.toLowerCase())
      if (!actual) return null
      current = path.join(current, actual)
    }
    return current
  }

  /**
   * Priorite des fichiers en clair :
   *  1. le dossier data/ (ou atterrissent les patchs), pour les chemins data/...
   *  2. la racine du client, pour tout le reste (System/, AI/, ...)
   */
  #loosePath(p) {
    const rel = p.replace(/\\/g, '/')
    const candidates = []
    if (this.looseDir && /^data\//i.test(rel)) candidates.push([this.looseDir, rel.slice(5)])
    candidates.push([this.clientDir, rel])

    for (const [base, sub] of candidates) {
      const full = this.#resolveOnDisk(base, sub)
      if (full && fs.existsSync(full) && fs.statSync(full).isFile()) return full
    }
    return null
  }

  /** @returns {Buffer|null} */
  read(p) {
    const loose = this.#loosePath(p)
    if (loose) return fs.readFileSync(loose)
    for (const { grf } of this.grfs) {
      const buf = grf.read(p)
      if (buf) return buf
    }
    return null
  }

  /** Lit le premier chemin existant parmi plusieurs candidats. */
  readAny(paths) {
    for (const p of paths) {
      const buf = this.read(p)
      if (buf) return { path: p, buffer: buf }
    }
    return null
  }

  readText(p, encoding = 'auto') {
    const buf = this.read(p)
    return buf ? decode(buf, encoding === 'auto' ? 'auto' : encoding) : null
  }

  exists(p) {
    if (this.#loosePath(p)) return true
    return this.grfs.some(({ grf }) => grf.has(p))
  }

  /**
   * Liste tous les chemins connus (GRF + dossier data/) matchant un predicat
   * applique au chemin en octets bruts minuscules.
   */
  list(predicate) {
    const seen = new Map()
    for (const { grf, name } of this.grfs) {
      for (const entry of grf.list(predicate)) {
        if (!seen.has(entry.key)) seen.set(entry.key, { key: entry.key, name: entry.name, size: entry.size, from: name })
      }
    }
    if (this.looseDir) {
      const walk = (dir, prefix) => {
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${item.name}` : item.name
          if (item.isDirectory()) walk(path.join(dir, item.name), rel)
          else {
            const key = `data/${rel}`.toLowerCase()
            if (!predicate || predicate(key)) {
              seen.set(key, { key, name: `data/${rel}`, size: fs.statSync(path.join(dir, item.name)).size, from: 'data/' })
            }
          }
        }
      }
      walk(this.looseDir, '')
    }
    return [...seen.values()]
  }

  close() {
    for (const { grf } of this.grfs) grf.close()
  }
}

export function openClient(clientDir, opts) {
  if (!fs.existsSync(clientDir)) {
    throw new Error(`Dossier client introuvable : ${clientDir}`)
  }
  return new Vfs(clientDir, opts)
}
