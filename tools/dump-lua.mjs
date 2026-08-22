#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { openClient } from './vfs.mjs'
import { loadLua } from './luadata.mjs'
import { resolveClientDir } from './client-path.mjs'

/**
 * Montre ce qu'un fichier .lub contient reellement.
 *
 * A lancer quand l'extraction dit "structure inattendue" : la sortie decrit les
 * tables construites et donne des lignes d'exemple. C'est ce qu'il faut pour
 * caler un parseur sur un client precis, sans avoir a deviner.
 */

const HELP = `
Decrit la structure d'un fichier .lub du client.

  npm run dump -- "data/luafiles514/lua files/navigation/navi_mob_frfr.lub"
  npm run dump -- "System/itemInfo_true.lub"

Options
  -c, --client <dossier>  racine du client (defaut : celui memorise)
  -n, --samples <n>       lignes d'exemple par table       (defaut : 5)
  -t, --tables <n>        nombre de tables a decrire       (defaut : 8)
      --find <texte>      ne montre que les tables contenant ce texte
`

function parseArgs(argv) {
  const args = { samples: 5, tables: 8 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--client' || a === '-c') args.client = argv[++i]
    else if (a === '--samples' || a === '-n') args.samples = Number(argv[++i])
    else if (a === '--tables' || a === '-t') args.tables = Number(argv[++i])
    else if (a === '--find') args.find = argv[++i]
    else if (a === '--help' || a === '-h') args.help = true
    else if (!args.file) args.file = a
  }
  return args
}

const isPlainTable = (v) => v !== null && typeof v === 'object'

/** Resume une valeur en une ligne lisible. */
function brief(value, depth = 0) {
  if (value === null) return 'nil'
  if (typeof value === 'string') return JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}…` : value)
  if (typeof value !== 'object') return String(value)
  if (depth >= 2) return '{…}'
  const entries = Object.entries(value)
  const inner = entries.slice(0, 8).map(([k, v]) => `${/^-?\d+$/.test(k) ? '' : `${k} = `}${brief(v, depth + 1)}`)
  return `{ ${inner.join(', ')}${entries.length > 8 ? ', …' : ''} }`
}

function describe(table) {
  const keys = Object.keys(table)
  const numeric = keys.filter((k) => /^-?\d+$/.test(k))
  const named = keys.filter((k) => !/^-?\d+$/.test(k))
  const rows = numeric.map((k) => table[k]).filter(isPlainTable)

  // Largeur des lignes : c'est ce qui manque quand un parseur se trompe.
  const widths = new Map()
  for (const row of rows.slice(0, 500)) {
    const width = Object.keys(row).filter((k) => /^-?\d+$/.test(k)).length
    widths.set(width, (widths.get(width) || 0) + 1)
  }

  return {
    keys: keys.length,
    numeric: numeric.length,
    named,
    rows: rows.length,
    widths: [...widths].sort((a, b) => b[1] - a[1]),
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.file) {
    console.log(HELP)
    process.exit(args.help ? 0 : 1)
  }

  const clientDir = resolveClientDir(args.client)
  if (!clientDir) {
    console.error('Aucun client memorise. Lance d\'abord `npm run scan -- "<dossier du client>"`.')
    process.exit(1)
  }

  const vfs = openClient(clientDir, { encoding: 'cp949' })
  const buf = vfs.read(args.file)
  if (!buf) {
    console.error(`Introuvable dans le client : ${args.file}`)
    const guess = vfs.list((key) => key.includes(path.basename(args.file).toLowerCase())).slice(0, 10)
    if (guess.length) {
      console.error('\nPeut-etre cherchais-tu :')
      for (const g of guess) console.error(`  ${g.name}`)
    }
    process.exit(1)
  }

  console.log(`Fichier : ${args.file}`)
  console.log(`Taille  : ${buf.length.toLocaleString('fr-FR')} octets`)

  const { env, tables, warnings, compiled } = loadLua(buf, { includeTables: true })
  console.log(`Forme   : ${compiled ? 'bytecode Lua 5.1' : 'source Lua'}`)
  for (const w of warnings) console.log(`  ! ${w}`)

  const globals = Object.entries(env).filter(([, v]) => isPlainTable(v))
  console.log(`\nGlobales : ${Object.keys(env).length} (${globals.length} table(s))`)
  for (const [name, value] of globals) {
    const info = describe(value)
    console.log(`  ${name} : ${info.keys} cles, ${info.numeric} numeriques, ${info.rows} sous-tables`)
    if (info.named.length) console.log(`      champs nommes : ${info.named.slice(0, 12).join(', ')}`)
  }

  // Les tables les plus grosses, globales ou non : c'est generalement la donnee.
  const ranked = tables
    .filter(isPlainTable)
    .map((t) => ({ table: t, info: describe(t) }))
    .filter(({ info }) => info.keys >= 3)
    .sort((a, b) => b.info.keys - a.info.keys)
    .slice(0, args.tables)

  console.log(`\nTables construites : ${tables.length} (les ${ranked.length} plus grosses)`)
  for (const { table, info } of ranked) {
    const entries = Object.entries(table)
    if (args.find && !JSON.stringify(entries.slice(0, 50)).includes(args.find)) continue

    console.log(`\n  ${info.keys} cles — ${info.numeric} numeriques, ${info.rows} sous-tables`)
    if (info.named.length) console.log(`  champs nommes : ${info.named.slice(0, 12).join(', ')}`)
    if (info.widths.length) {
      console.log(`  largeur des lignes : ${info.widths.map(([w, n]) => `${w} colonnes x${n}`).join(', ')}`)
    }
    for (const [key, value] of entries.slice(0, args.samples)) {
      console.log(`      [${key}] ${brief(value)}`)
    }
  }

  vfs.close()
  console.log('\nRecopie cette sortie pour que le parseur soit cale sur ce format.')
}

main()
