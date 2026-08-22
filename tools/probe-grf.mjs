#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { storedClientDir } from './client-path.mjs'

/**
 * Diagnostic d'archive GRF.
 *
 * A lancer quand `scan` ou `extract` refuse une archive. Le but n'est pas de
 * deviner : c'est d'afficher ce que l'en-tete contient reellement, et de dire
 * lesquelles des interpretations possibles tiennent debout. La sortie est faite
 * pour etre recopiee telle quelle.
 */

const HEADER_SIZE = 0x2e

function hexDump(buf, from = 0) {
  const lines = []
  for (let i = 0; i < buf.length; i += 16) {
    const chunk = buf.subarray(i, i + 16)
    const hex = [...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' ')
    const ascii = [...chunk].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('')
    lines.push(`  ${(from + i).toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  |${ascii}|`)
  }
  return lines.join('\n')
}

/** Un flux zlib commence par 0x78 suivi d'un octet de controle coherent. */
function looksZlib(buf, at) {
  if (at + 1 >= buf.length) return false
  if (buf[at] !== 0x78) return false
  return ((buf[at] << 8) | buf[at + 1]) % 31 === 0
}

/**
 * Cherche le debut reel du flux compresse autour de l'offset de table.
 *
 * En GRF 0x200 l'en-tete de table fait 8 octets ; les versions plus recentes
 * en ajoutent. Plutot que de coder un decalage par version, on essaie les
 * decalages plausibles avec les trois encapsulations courantes et on garde
 * celui qui produit reellement des donnees.
 */
function findStream(fd, tableAt, fileSize) {
  const window = Buffer.alloc(Math.min(1 << 20, fileSize - tableAt))
  fs.readSync(fd, window, 0, window.length, tableAt)

  const methods = [
    ['zlib', (buf) => zlib.inflateSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH })],
    ['deflate brut', (buf) => zlib.inflateRawSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH })],
    ['gzip', (buf) => zlib.gunzipSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH })],
  ]

  for (let offset = 0; offset <= 32; offset += 4) {
    for (const [method, decompress] of methods) {
      // Un flux zlib s'annonce ; pour le deflate brut on tente quand meme.
      if (method === 'zlib' && !looksZlib(window, offset)) continue
      try {
        const out = decompress(window.subarray(offset))
        if (out.length > 64) return { start: tableAt + offset, method, out }
      } catch {
        // decalage ou methode incorrects : on passe au suivant
      }
    }
  }
  return null
}

/** Une table des fichiers GRF valide : des noms ASCII suivis de 17 octets. */
function looksLikeFileTable(table) {
  let p = 0
  let ok = 0
  for (let i = 0; i < 5 && p < table.length; i++) {
    const end = table.indexOf(0, p)
    if (end < 0 || end === p || end - p > 260) return { ok: false, sample: [] }
    p = end + 18
    ok++
  }
  const sample = []
  p = 0
  for (let i = 0; i < 8; i++) {
    const end = table.indexOf(0, p)
    if (end < 0) break
    sample.push(table.subarray(p, end).toString('latin1'))
    p = end + 18
  }
  return { ok: ok >= 5, sample }
}

/** Accepte une archive, un dossier client, ou rien si un client est memorise. */
function resolveArchive(arg) {
  const candidate = arg || storedClientDir()
  if (!candidate) return null
  if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
    const grf = fs.readdirSync(candidate).find((f) => f.toLowerCase().endsWith('.grf'))
    return grf ? path.join(candidate, grf) : null
  }
  return candidate
}

function main() {
  const target = resolveArchive(process.argv[2])
  if (!target) {
    console.error('Usage : node tools/probe-grf.mjs "C:/Gravity/RagnarokZero/data.grf"')
    process.exit(1)
  }
  if (!fs.existsSync(target)) {
    console.error(`Fichier introuvable : ${target}`)
    process.exit(1)
  }

  const stat = fs.statSync(target)
  const fd = fs.openSync(target, 'r')
  const header = Buffer.alloc(HEADER_SIZE)
  fs.readSync(fd, header, 0, HEADER_SIZE, 0)

  console.log(`Fichier : ${target}`)
  console.log(`Taille  : ${stat.size.toLocaleString('fr-FR')} octets\n`)

  console.log('En-tete (64 premiers octets)')
  const head64 = Buffer.alloc(64)
  fs.readSync(fd, head64, 0, 64, 0)
  console.log(hexDump(head64))

  const signature = header.subarray(0, 15).toString('latin1').replace(/\0/g, '.')
  const keyField = header.subarray(15, 30).toString('latin1').replace(/[^\x20-\x7e]/g, '.')
  const tableOffset = header.readUInt32LE(0x1e)
  const seed = header.readUInt32LE(0x22)
  const rawCount = header.readUInt32LE(0x26)
  const version = header.readUInt32LE(0x2a)

  console.log('\nLecture selon le format standard')
  console.log(`  signature (0x00, 15o) : "${signature}"`)
  console.log(`  champ cle (0x0f, 15o) : "${keyField}"`)
  console.log(`  offset table  (0x1e)  : ${tableOffset} -> absolu ${HEADER_SIZE + tableOffset}`)
  console.log(`  seed          (0x22)  : ${seed}`)
  console.log(`  compte brut   (0x26)  : ${rawCount}  (soit ${rawCount - seed - 7} fichiers)`)
  console.log(`  version       (0x2a)  : 0x${version.toString(16)}`)

  const verdicts = []
  const plausibleOffset = tableOffset > 0 && HEADER_SIZE + tableOffset + 8 < stat.size
  verdicts.push(['version connue (0x200 ou 0x300)', version === 0x200 || version === 0x300])
  verdicts.push(['offset de table dans le fichier', plausibleOffset])
  verdicts.push(['nombre de fichiers plausible', rawCount - seed - 7 > 0 && rawCount - seed - 7 < 2_000_000])

  // La taille de l'en-tete de table depend de la version, et n'est pas
  // documentee pour 0x300 : on l'etablit en essayant, plutot qu'en supposant.
  if (plausibleOffset) {
    const tableAt = HEADER_SIZE + tableOffset
    console.log('\nEn-tete de la table des fichiers (48 octets bruts)')
    const raw = Buffer.alloc(Math.min(48, stat.size - tableAt))
    fs.readSync(fd, raw, 0, raw.length, tableAt)
    console.log(hexDump(raw, tableAt))

    console.log('\n  Champs 32 bits successifs :')
    for (let i = 0; i + 4 <= Math.min(24, raw.length); i += 4) {
      const value = raw.readUInt32LE(i)
      const asData = tableAt + i + 4 + value === stat.size ? '  <- flux jusqu\'a la fin du fichier si le flux commence ici' : ''
      console.log(`    +${i.toString().padStart(2)} : ${value.toString().padStart(12)}${asData}`)
    }

    const found = findStream(fd, tableAt, stat.size)
    if (found) {
      console.log(`\n  Flux trouve : debut a +${found.start - tableAt}, methode ${found.method}`)
      console.log(`  Decompresse (echantillon) : ${found.out.length} octets`)
      console.log('\n  Debut de la table decompressee')
      console.log(hexDump(found.out.subarray(0, 256)))
      verdicts.push([`flux de table lisible (+${found.start - tableAt}, ${found.method})`, true])

      const { ok, sample } = looksLikeFileTable(found.out)
      verdicts.push(['table structuree comme un GRF 0x200', ok])
      if (sample.length) {
        console.log('\n  Chaines lues comme des noms de fichiers :')
        for (const name of sample) console.log(`    ${JSON.stringify(name)}`)
      }
    } else {
      console.log('\n  Aucun flux compresse lisible autour de l\'offset de table.')
      verdicts.push(['flux de table lisible', false])
    }
  }

  // Si rien n'a ete lu, on cherche un flux zlib ailleurs : cela distingue
  // "en-tete different" de "contenu chiffre".
  if (!verdicts.some(([label, ok]) => ok && label.startsWith('flux de table lisible'))) {
    console.log('\nRecherche d\'un flux zlib dans le premier Mo...')
    const scan = Buffer.alloc(Math.min(1 << 20, stat.size))
    fs.readSync(fd, scan, 0, scan.length, 0)
    const found = []
    for (let i = 0; i < scan.length - 1 && found.length < 5; i++) {
      if (looksZlib(scan, i)) found.push(i)
    }
    console.log(found.length
      ? `  candidats aux offsets : ${found.join(', ')}`
      : '  aucun flux zlib trouve : le contenu est chiffre, pas seulement l\'en-tete.')
  }

  fs.closeSync(fd)

  console.log('\nVerdict')
  for (const [label, ok] of verdicts) console.log(`  [${ok ? 'v' : 'x'}] ${label}`)

  const readable = verdicts.every(([, ok]) => ok)
  console.log(readable
    ? '\nL\'archive est lisible : seule la signature differe, l\'extraction peut la traiter.'
    : '\nL\'archive n\'est pas lisible telle quelle. Recopie cette sortie complete.')
}

main()
