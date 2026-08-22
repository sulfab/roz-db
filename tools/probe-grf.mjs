#!/usr/bin/env node
import fs from 'node:fs'
import zlib from 'node:zlib'

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

function tryInflate(fd, offset, length) {
  try {
    const buf = Buffer.alloc(Math.min(length, 1 << 22))
    fs.readSync(fd, buf, 0, buf.length, offset)
    return zlib.inflateSync(buf)
  } catch {
    return null
  }
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

function main() {
  const target = process.argv[2]
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
  verdicts.push(['version 0x200', version === 0x200])
  verdicts.push(['offset de table dans le fichier', plausibleOffset])
  verdicts.push(['nombre de fichiers plausible', rawCount - seed - 7 > 0 && rawCount - seed - 7 < 2_000_000])

  if (plausibleOffset) {
    const sizes = Buffer.alloc(8)
    fs.readSync(fd, sizes, 0, 8, HEADER_SIZE + tableOffset)
    const packedLen = sizes.readUInt32LE(0)
    const realLen = sizes.readUInt32LE(4)
    console.log(`\nA l'offset de table : compresse=${packedLen}, decompresse=${realLen}`)

    const at = HEADER_SIZE + tableOffset + 8
    const probe = Buffer.alloc(2)
    fs.readSync(fd, probe, 0, 2, at)
    const zlibHere = looksZlib(probe, 0)
    console.log(`  premiers octets : ${probe[0].toString(16).padStart(2, '0')} ${probe[1].toString(16).padStart(2, '0')}` +
      `  -> ${zlibHere ? 'en-tete zlib valide' : 'PAS un en-tete zlib'}`)
    verdicts.push(['flux zlib a l\'offset de table', zlibHere])

    if (zlibHere) {
      const table = tryInflate(fd, at, packedLen)
      if (table) {
        const { ok, sample } = looksLikeFileTable(table)
        console.log(`  decompression   : ${table.length} octets (attendu ${realLen})`)
        verdicts.push(['table decompressee', true])
        verdicts.push(['table structuree comme un GRF', ok])
        if (sample.length) {
          console.log('\n  Premiers noms de fichiers :')
          for (const name of sample) console.log(`    ${name}`)
        }
      } else {
        console.log('  decompression   : ECHEC')
        verdicts.push(['table decompressee', false])
      }
    }
  }

  // Si l'offset declare ne mene nulle part, on cherche un flux zlib ailleurs :
  // cela distingue "en-tete different" de "contenu chiffre".
  if (!verdicts.find(([label]) => label === 'table decompressee')?.[1]) {
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
