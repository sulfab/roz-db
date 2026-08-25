#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PNG } from 'pngjs'
import { openClient } from './vfs.mjs'
import { resolveClientDir } from './client-path.mjs'

/**
 * Icones d'items : BMP dans le GRF -> PNG sur disque.
 *
 * Les icones vivent sous data/texture/<interface utilisateur>/item/<res>.bmp,
 * ou <res> est le nom de ressource de l'item (idnum2itemresnametable.txt).
 * Le magenta pur sert de couleur de transparence, comme dans le client.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const UI_DIR = 'data/texture/유저인터페이스' // "유저인터페이스"

const HELP = `
Extrait les icones d'items du client vers public/icons/.

  node tools/icons.mjs [--client <dossier>] [--collection]

Options
  -c, --client <dossier>  racine du client (defaut : .client-path)
  -o, --out <dossier>     defaut : public/icons
      --collection        prend aussi les grandes images (collection/)
      --limit <n>         s'arrete apres n icones (pour tester)
`

/** Decode un BMP non compresse (8 ou 24/32 bits). @returns {{width, height, rgba: Buffer}|null} */
export function decodeBmp(buf) {
  if (buf.length < 54 || buf[0] !== 0x42 || buf[1] !== 0x4d) return null
  const dataOffset = buf.readUInt32LE(0x0a)
  const headerSize = buf.readUInt32LE(0x0e)
  if (headerSize < 40) return null
  const width = buf.readInt32LE(0x12)
  const rawHeight = buf.readInt32LE(0x16)
  const height = Math.abs(rawHeight)
  const bottomUp = rawHeight > 0
  const bpp = buf.readUInt16LE(0x1c)
  const compression = buf.readUInt32LE(0x1e)
  if (compression !== 0 || width <= 0 || height <= 0 || width > 4096 || height > 4096) return null

  const palette = []
  if (bpp <= 8) {
    let p = 0x0e + headerSize
    const colors = buf.readUInt32LE(0x2e) || 1 << bpp
    for (let i = 0; i < colors && p + 3 < buf.length; i++, p += 4) {
      palette.push([buf[p + 2], buf[p + 1], buf[p]])
    }
  }

  const rowSize = Math.floor((bpp * width + 31) / 32) * 4
  const rgba = Buffer.alloc(width * height * 4)

  for (let y = 0; y < height; y++) {
    const srcY = bottomUp ? height - 1 - y : y
    let p = dataOffset + srcY * rowSize
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0
      if (bpp === 8) {
        const c = palette[buf[p + x]] || [0, 0, 0]
        ;[r, g, b] = c
      } else if (bpp === 24 || bpp === 32) {
        const q = p + x * (bpp / 8)
        if (q + 2 >= buf.length) continue
        b = buf[q]; g = buf[q + 1]; r = buf[q + 2]
      } else if (bpp === 4) {
        const byte = buf[p + (x >> 1)]
        const idx = x % 2 === 0 ? byte >> 4 : byte & 0x0f
        const c = palette[idx] || [0, 0, 0]
        ;[r, g, b] = c
      } else {
        return null
      }
      const o = (y * width + x) * 4
      const transparent = r === 255 && g === 0 && b === 255
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = transparent ? 0 : 255
    }
  }
  return { width, height, rgba }
}

function toPng({ width, height, rgba }) {
  const png = new PNG({ width, height })
  rgba.copy(png.data)
  return PNG.sync.write(png)
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) { console.log(HELP); return }

  let client = null
  let out = path.join(ROOT, 'public', 'icons')
  let limit = Infinity
  let collection = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--client' || argv[i] === '-c') client = argv[++i]
    else if (argv[i] === '--out' || argv[i] === '-o') out = path.resolve(argv[++i])
    else if (argv[i] === '--limit') limit = Number(argv[++i])
    else if (argv[i] === '--collection') collection = true
    else if (!argv[i].startsWith('-') && !client) client = argv[i]
  }
  client = resolveClientDir(client)
  if (!client) { console.error(HELP); process.exit(1) }

  const itemsFile = path.join(ROOT, 'public', 'data', 'items.json')
  if (!fs.existsSync(itemsFile)) {
    console.error('public/data/items.json manquant : lance d\'abord `npm run extract`.')
    process.exit(1)
  }
  const items = JSON.parse(fs.readFileSync(itemsFile, 'utf8'))

  const vfs = openClient(client, { encoding: 'cp949' })
  fs.mkdirSync(out, { recursive: true })
  if (collection) fs.mkdirSync(path.join(out, 'collection'), { recursive: true })

  const written = []
  let done = 0
  let missing = 0
  let failed = 0
  for (const [id, item] of Object.entries(items)) {
    if (done >= limit) break
    if (!item.res) { missing++; continue }
    const buf = vfs.read(`${UI_DIR}/item/${item.res}.bmp`)
    if (!buf) { missing++; continue }
    const bmp = decodeBmp(buf)
    if (!bmp) { failed++; continue }
    fs.writeFileSync(path.join(out, `${id}.png`), toPng(bmp))
    written.push(Number(id))
    done++

    if (collection) {
      const big = vfs.read(`${UI_DIR}/collection/${item.res}.bmp`)
      const decoded = big && decodeBmp(big)
      if (decoded) fs.writeFileSync(path.join(out, 'collection', `${id}.png`), toPng(decoded))
    }
    if (done % 500 === 0) process.stdout.write(`\r  ${done} icones...`)
  }
  vfs.close()

  // Le manifeste evite a l'app de demander une image par item et de remplir
  // la console de 404 quand les icones n'ont pas ete extraites.
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(written.sort((a, b) => a - b)))

  console.log(`\rIcones ecrites : ${done}`)
  if (missing) console.log(`Sans icone     : ${missing} (nom de ressource absent ou fichier introuvable)`)
  if (failed) console.log(`BMP illisibles : ${failed}`)
  console.log(`Sortie         : ${out}`)
}

// Compare des URL des deux cotes : sous Windows, process.argv[1] vaut
// C:\chemin\fichier.mjs, qui n'est jamais egal a file:///C:/chemin/....
if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
