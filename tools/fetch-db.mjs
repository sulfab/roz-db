#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT } from './client-path.mjs'
import { loadOracle } from './analyze-capture.mjs'

/**
 * Recupere une fiche par monstre depuis une base publique, et les rassemble.
 *
 * L'outil ne sait rien de l'API qu'on lui donne, et c'est voulu : il recoit un
 * gabarit d'adresse avec {id} dedans, appelle une fois par monstre du client, et
 * empile les reponses telles quelles dans un fichier. C'est `import-external`
 * qui en deduira ensuite la forme — donc changer de base ne demande pas de
 * changer une ligne de code.
 *
 * Les identifiants viennent du client, pas de la base distante : on ne demande
 * que ce qui existe reellement dans le jeu qu'on joue.
 */

const HELP = `
Recupere une fiche par monstre depuis une base publique.

  npm run fetch-db -- --url "https://exemple/api/Monster/{id}?apiKey=XXX"
  npm run fetch-db -- --url "..." --pause 1500 --out db.json

Options
  -u, --url <gabarit>  adresse avec {id} a la place de l'identifiant  (requis)
  -o, --out <fichier>  defaut : captures/db-distante.json
      --pause <ms>     attente entre deux appels                (defaut : 1000)
      --reprendre      complete un fichier existant au lieu de tout refaire
      --max <n>        s'arrete apres n monstres (pour essayer d'abord)
      --data <dossier> ou lire la liste des monstres   (defaut : public/data)

Ensuite
  npm run import-external -- captures/db-distante.json --source "..."

Sur la politesse
  Une pause d'une seconde par defaut, et pas de parallelisme : ces bases sont
  tenues par des benevoles, et certaines ont du limiter leur debit a cause
  d'outils qui tapaient des centaines de fois par seconde. Ne baisse la pause
  que si leurs conditions d'usage le permettent.
`

const PAUSE = 1000
/** Au-dela, on considere que l'adresse ou la cle est fausse et on s'arrete. */
const ECHECS_AVANT_ARRET = 10

function parseArgs(argv) {
  const args = { pause: PAUSE }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--url' || a === '-u') args.url = argv[++i]
    else if (a === '--out' || a === '-o') args.out = path.resolve(argv[++i])
    else if (a === '--pause') args.pause = Number(argv[++i])
    else if (a === '--reprendre') args.reprendre = true
    else if (a === '--max') args.max = Number(argv[++i])
    else if (a === '--data') args.data = path.resolve(argv[++i])
    else if (a === '--help' || a === '-h') args.help = true
  }
  return args
}

/** Remplace {id} dans le gabarit. Rien d'autre n'est touche. */
export function buildUrl(gabarit, id) {
  if (!gabarit.includes('{id}')) throw new Error('le gabarit doit contenir {id}')
  return gabarit.replaceAll('{id}', String(id))
}

/** Ce qui reste a demander : les monstres du client absents du fichier deja la. */
export function resterAFaire(mobIds, deja) {
  const vus = new Set(deja.map((f) => f.id))
  return mobIds.filter((id) => !vus.has(id))
}

/** N'ecrit la cle nulle part : une adresse avec cle ne doit pas finir en clair. */
export function masquerCle(url) {
  return url.replace(/([?&](?:api_?key|key|token)=)[^&]+/gi, '$1***')
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.url) { console.log(HELP); return }

  const oracle = loadOracle(args.data)
  if (!oracle.mobs.size) {
    console.error("La liste des monstres du client est vide : lance d'abord `npm run extract`.")
    process.exit(1)
  }

  const out = args.out || path.join(ROOT, 'captures', 'db-distante.json')
  let fiches = []
  if (args.reprendre && fs.existsSync(out)) {
    try { fiches = JSON.parse(fs.readFileSync(out, 'utf8')) } catch { fiches = [] }
  }

  const tous = [...oracle.mobs].sort((a, b) => a - b)
  let restant = resterAFaire(tous, fiches)
  if (args.max) restant = restant.slice(0, args.max)

  console.log(`Adresse : ${masquerCle(buildUrl(args.url, '<id>'))}`)
  console.log(`Monstres : ${restant.length} a demander` +
    (fiches.length ? ` (${fiches.length} deja recuperes)` : ''))
  console.log(`Pause    : ${args.pause} ms entre deux appels\n`)

  let echecs = 0
  let suite = 0
  for (const [n, id] of restant.entries()) {
    let reponse
    try {
      reponse = await fetch(buildUrl(args.url, id), { headers: { accept: 'application/json' } })
    } catch (err) {
      console.error(`  ${id} : ${err.message}`)
      if (++suite >= ECHECS_AVANT_ARRET) break
      continue
    }

    if (reponse.status === 404) { suite = 0; continue }   // ce monstre n'y est pas
    if (!reponse.ok) {
      echecs++
      console.error(`  ${id} : HTTP ${reponse.status}`)
      // Une cle refusee ou un debit depasse se repete : inutile d'insister.
      if (++suite >= ECHECS_AVANT_ARRET) {
        console.error(`\n${ECHECS_AVANT_ARRET} echecs d'affilee — verifie l'adresse et la cle.`)
        break
      }
      await dormir(args.pause)
      continue
    }

    try {
      fiches.push({ id, ...(await reponse.json()) })
      suite = 0
    } catch (err) {
      echecs++
      console.error(`  ${id} : reponse illisible (${err.message})`)
    }

    if ((n + 1) % 25 === 0) {
      process.stdout.write(`\r  ${n + 1}/${restant.length} demandes, ${fiches.length} fiches...   `)
      fs.mkdirSync(path.dirname(out), { recursive: true })
      fs.writeFileSync(out, JSON.stringify(fiches))
    }
    await dormir(args.pause)
  }

  process.stdout.write('\r')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(fiches))
  console.log(`\n${fiches.length} fiche(s) dans ${out}` + (echecs ? `, ${echecs} echec(s)` : ''))
  console.log(`\nEnsuite :  npm run import-external -- "${out}" --source "..."`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
