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
      --liste <quoi>   carte | vus | mobs | objets | <fichier>  (defaut : carte)
                       carte  : les especes de la carte ou tu es
                       vus    : toutes celles croisees depuis le debut
                       mobs   : les 585 du client
                       objets : le catalogue entier
      --type <quoi>    mobs | objets, pour un fichier            (defaut : mobs)
      --budget <n>     s'arrete apres n appels, et le dit
      --pause <ms>     attente entre deux appels                (defaut : 1000)
      --reprendre      complete un fichier existant au lieu de tout refaire
      --max <n>        s'arrete apres n fiches (pour essayer d'abord)
      --data <dossier> ou lire les listes du client    (defaut : public/data)

Ensuite
  npm run import-external -- captures/db-distante.json --source "..."

Sur les quotas
  Ces bases limitent le nombre d'appels par jour. Le defaut demande donc les
  seules especes de la carte ou tu te trouves — quelques dizaines, prises dans
  observations.json que remplit "npm run watch". Joue, la liste s'etoffe, et
  chaque carte ne coute que ce qu'elle contient.

  --budget s'arrete avant la limite et --reprendre continue le lendemain sans
  rien reperdre.

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
    else if (a === '--liste') args.liste = argv[++i]
    else if (a === '--type') args.type = argv[++i]
    else if (a === '--budget') args.budget = Number(argv[++i])
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

/**
 * Quels identifiants demander.
 *
 * Par defaut les monstres du client. Mais on peut aussi partir d'un fichier —
 * typiquement la table de drop qu'on vient d'importer — pour ne demander que
 * les objets qui y figurent reellement. Sur un quota journalier, la difference
 * est celle entre quelques centaines d'appels et plusieurs milliers.
 */
export function collecterIds(source, oracle, {
  type = 'mobs',
  lire = (f) => JSON.parse(fs.readFileSync(f, 'utf8')),
  observations = null,
} = {}) {
  if (source === 'mobs') return [...oracle.mobs].sort((a, b) => a - b)
  if (source === 'objets') return [...oracle.items].sort((a, b) => a - b)

  if (!source || source === 'carte' || source === 'vus') {
    const etat = observations ?? {}
    const especes = source === 'vus' || !etat.derniereCarte
      ? Object.keys(etat.mobs || {})
      : Object.keys(etat.cartes?.[etat.derniereCarte]?.especes || {})
    return especes.map(Number).filter((id) => oracle.mobs.has(id)).sort((a, b) => a - b)
  }

  // Un fichier quelconque : on y ramasse les identifiants qui existent dans le
  // client, cote monstres ou cote objets selon ce qu'on cherche.
  const univers = type === 'objets' ? oracle.items : oracle.mobs
  const trouve = new Set()
  const visite = (v, profondeur) => {
    if (profondeur > 8 || v === null) return
    if (Array.isArray(v)) { for (const e of v) visite(e, profondeur + 1); return }
    if (typeof v === 'object') {
      for (const [cle, sous] of Object.entries(v)) {
        const n = Number(cle)
        if (Number.isInteger(n) && univers.has(n)) trouve.add(n)
        visite(sous, profondeur + 1)
      }
      return
    }
    if (Number.isInteger(v) && univers.has(v)) trouve.add(v)
  }
  visite(lire(source), 0)
  return [...trouve].sort((a, b) => a - b)
}

/** Ce qui reste a demander : les identifiants absents du fichier deja la. */
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

  const suivi = path.join(args.data || path.join(ROOT, 'public', 'data'), 'observations.json')
  let observations = null
  if (fs.existsSync(suivi)) {
    try { observations = JSON.parse(fs.readFileSync(suivi, 'utf8')) } catch { observations = null }
  }

  let tous
  try { tous = collecterIds(args.liste, oracle, { type: args.type, observations }) } catch (err) {
    console.error(`--liste : ${err.message}`)
    process.exit(1)
  }
  if (!tous.length) {
    if (!args.liste || args.liste === 'carte' || args.liste === 'vus') {
      console.error("Aucune espece observee pour l'instant.")
      console.error('Lance `npm run watch` et traverse une carte : la liste se remplit toute')
      console.error("seule. Sinon, `--liste mobs` demande les 585 monstres du client d'un coup.")
    } else {
      console.error('Aucun identifiant a demander : verifie --liste.')
    }
    process.exit(1)
  }
  console.log(`Liste   : ${args.liste || 'carte'}` +
    (observations?.derniereCarte && (!args.liste || args.liste === 'carte')
      ? ` (${observations.derniereCarte})` : ''))

  const manquants = resterAFaire(tous, fiches)
  const plafond = Math.min(args.max || Infinity, args.budget || Infinity)
  const restant = Number.isFinite(plafond) ? manquants.slice(0, plafond) : manquants

  console.log(`Adresse : ${masquerCle(buildUrl(args.url, '<id>'))}`)
  console.log(`A faire : ${restant.length} appel(s)` +
    (fiches.length ? `, ${fiches.length} deja recuperes` : '') +
    (restant.length < manquants.length ? `, ${manquants.length - restant.length} remis a plus tard` : ''))
  console.log(`Pause   : ${args.pause} ms entre deux appels\n`)

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

  const reste = resterAFaire(tous, fiches).length
  if (reste) {
    console.log(`${reste} identifiant(s) pas encore demandes.`)
    console.log(`Reprends demain, sans rien reperdre :`)
    console.log(`  npm run fetch-db -- --url "..." --reprendre${args.budget ? ` --budget ${args.budget}` : ''}`)
  }
  console.log(`\nEnsuite :  npm run import-external -- "${out}" --source "..."`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
