#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Import des tables de drop.
 *
 * Le client ne contient pas les drops : dans le RO officiel ils sont cotes
 * serveur, l'encyclopedie en jeu les recoit par paquet. Ce script accepte donc
 * n'importe quelle source externe, du moment qu'elle se ramene a des triplets
 * (mob, item, taux).
 *
 * Formats acceptes
 *   CSV   mobId,itemId,chance[,label]      (en-tete optionnelle)
 *   JSON  [{ mob, item, chance }]
 *         { "1002": [{ "item": 909, "chance": 70 }] }
 *
 * Le taux est un pourcentage par defaut (70 = 70 %). Pour les sources qui
 * comptent en 1/10000 (rAthena et la plupart des bases serveur), passer
 * --base 10000 : 7000 devient alors 70 %.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const HELP = `
Importe des tables de drop dans public/data/drops.json.

  node tools/import-drops.mjs drops.csv --source "encyclopedie in-game" --base 10000

Options
  -s, --source <texte>   d'ou viennent ces donnees (affiche dans l'app)
  -b, --base <n>         echelle des taux : 100 = pourcentage (defaut), 10000 = 1/10000
  -o, --out <fichier>    defaut : public/data/drops.json
      --replace          remplace la table au lieu de fusionner
      --dry-run          affiche le resultat sans ecrire
`

function parseArgs(argv) {
  const args = { base: 100, out: path.join(ROOT, 'public', 'data', 'drops.json'), files: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--source' || a === '-s') args.source = argv[++i]
    else if (a === '--base' || a === '-b') args.base = Number(argv[++i])
    else if (a === '--out' || a === '-o') args.out = path.resolve(argv[++i])
    else if (a === '--replace') args.replace = true
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--help' || a === '-h') args.help = true
    else args.files.push(a)
  }
  return args
}

/** @returns {Array<{mob: number, item: number, chance: number, label?: string}>} */
function parseCsv(text) {
  const rows = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('//')) continue
    const cells = line.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ''))
    const [mob, item, chance, label] = cells
    if (!/^\d+$/.test(mob) || !/^\d+$/.test(item)) continue // en-tete ou ligne parasite
    const rate = Number(chance)
    if (!Number.isFinite(rate)) continue
    rows.push({ mob: Number(mob), item: Number(item), chance: rate, label: label || undefined })
  }
  return rows
}

function parseJson(text) {
  const data = JSON.parse(text)
  if (Array.isArray(data)) {
    return data
      .map((d) => ({
        mob: Number(d.mob ?? d.mobId ?? d.monster ?? d.monsterId),
        item: Number(d.item ?? d.itemId ?? d.nameid),
        chance: Number(d.chance ?? d.rate ?? d.drop),
        label: d.label,
      }))
      .filter((d) => Number.isInteger(d.mob) && Number.isInteger(d.item) && Number.isFinite(d.chance))
  }
  const rows = []
  for (const [mobKey, list] of Object.entries(data.mobs ?? data)) {
    const mob = Number(mobKey)
    if (!Number.isInteger(mob) || !Array.isArray(list)) continue
    for (const d of list) {
      const item = Number(d.item ?? d.itemId ?? d.nameid ?? d.id)
      const chance = Number(d.chance ?? d.rate ?? d.drop)
      if (Number.isInteger(item) && Number.isFinite(chance)) rows.push({ mob, item, chance, label: d.label })
    }
  }
  return rows
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.files.length) {
    console.log(HELP)
    process.exit(args.help ? 0 : 1)
  }

  const rows = []
  for (const file of args.files) {
    if (!fs.existsSync(file)) {
      console.error(`Fichier introuvable : ${file}`)
      process.exit(1)
    }
    const text = fs.readFileSync(file, 'utf8')
    const parsed = /^\s*[[{]/.test(text) ? parseJson(text) : parseCsv(text)
    console.log(`${file} : ${parsed.length} lignes`)
    rows.push(...parsed)
  }

  if (!rows.length) {
    console.error('Aucune ligne exploitable. Attendu : mobId,itemId,taux')
    process.exit(1)
  }

  const scale = 100 / args.base
  const existing = !args.replace && fs.existsSync(args.out)
    ? JSON.parse(fs.readFileSync(args.out, 'utf8'))
    : { meta: {}, mobs: {} }

  const table = existing.mobs || {}
  let added = 0
  let updated = 0
  for (const row of rows) {
    const key = String(row.mob)
    const list = (table[key] ||= [])
    const chance = Number((row.chance * scale).toFixed(4))
    const found = list.find((d) => d.item === row.item)
    if (found) {
      if (found.chance !== chance) { found.chance = chance; updated++ }
    } else {
      list.push({ item: row.item, chance, ...(row.label ? { label: row.label } : {}) })
      added++
    }
  }
  for (const list of Object.values(table)) list.sort((a, b) => b.chance - a.chance)

  const output = {
    meta: {
      source: args.source || existing.meta?.source || 'inconnue',
      importedAt: new Date().toISOString(),
      base: args.base,
      mobs: Object.keys(table).length,
      entries: Object.values(table).reduce((n, l) => n + l.length, 0),
    },
    mobs: table,
  }

  console.log(`\nMobs couverts : ${output.meta.mobs}`)
  console.log(`Entrees       : ${output.meta.entries} (${added} ajoutees, ${updated} mises a jour)`)

  if (args.dryRun) {
    console.log('\n--dry-run : rien ecrit.')
    return
  }
  fs.mkdirSync(path.dirname(args.out), { recursive: true })
  fs.writeFileSync(args.out, JSON.stringify(output))
  console.log(`Ecrit         : ${args.out}`)
}

main()
