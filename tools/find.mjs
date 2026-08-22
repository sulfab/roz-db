#!/usr/bin/env node
import { openClient } from './vfs.mjs'
import { resolveClientDir } from './client-path.mjs'

/**
 * Cherche des fichiers dans le client, par motif sur le chemin.
 *
 * Sert a repondre a la seule question qui bloque quand un parseur ne trouve
 * rien : ce fichier existe-t-il, et sous quel nom ?
 */

const HELP = `
Liste les fichiers du client dont le chemin contient un motif.

  npm run find -- item          # tout ce qui parle d'items
  npm run find -- "navi_mob"    # les fichiers de navigation
  npm run find -- .txt --top 40 # les plus gros fichiers texte

Options
  -c, --client <dossier>  racine du client (defaut : celui memorise)
  -n, --top <n>           nombre de resultats             (defaut : 30)
      --all               ne trie pas par taille, trie par chemin
`

function parseArgs(argv) {
  const args = { top: 30, patterns: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--client' || a === '-c') args.client = argv[++i]
    else if (a === '--top' || a === '-n') args.top = Number(argv[++i])
    else if (a === '--all') args.all = true
    else if (a === '--help' || a === '-h') args.help = true
    else args.patterns.push(a)
  }
  return args
}

function human(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} Mo`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} ko`
  return `${bytes} o`
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.patterns.length) {
    console.log(HELP)
    process.exit(args.help ? 0 : 1)
  }

  const clientDir = resolveClientDir(args.client)
  if (!clientDir) {
    console.error('Aucun client memorise. Lance d\'abord `npm run scan -- "<dossier du client>"`.')
    process.exit(1)
  }

  const vfs = openClient(clientDir, { encoding: 'cp949' })
  const needles = args.patterns.map((p) => p.toLowerCase())
  const hits = vfs.list((key) => needles.every((n) => key.includes(n)))

  hits.sort(args.all
    ? (a, b) => a.key.localeCompare(b.key)
    : (a, b) => b.size - a.size)

  console.log(`${hits.length} fichier(s) pour ${args.patterns.map((p) => `"${p}"`).join(' + ')}\n`)
  for (const hit of hits.slice(0, args.top)) {
    console.log(`  ${human(hit.size).padStart(8)}  ${hit.name}`)
  }
  if (hits.length > args.top) console.log(`\n  ... et ${hits.length - args.top} autres (--top pour en voir plus)`)

  vfs.close()
}

main()
