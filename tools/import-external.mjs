#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT } from './client-path.mjs'
import { loadOracle } from './analyze-capture.mjs'

/**
 * Importe une table de drop venue d'ailleurs, sans rien savoir de sa forme.
 *
 * Les bases publiques de Ragnarok Zero exposent leurs donnees en JSON, mais
 * chacune a ses noms de champs, et ils changent. Coder ceux d'aujourd'hui, ce
 * serait casser au prochain changement sans s'en apercevoir.
 *
 * On procede donc comme partout ailleurs ici : on ne suppose pas, on deduit.
 * Le client nous a deja donne la liste exacte des monstres et des objets qui
 * existent — c'est l'oracle. On cherche dans le fichier la forme qui colle :
 * un objet contenant un identifiant de monstre connu et une liste dont chaque
 * element porte un identifiant d'objet connu. Le nom des champs, on le lit
 * dans le fichier ; on ne le decide pas.
 *
 * L'echelle des taux se deduit de la meme facon, par leur ordre de grandeur.
 */

const HELP = `
Importe une table de drop depuis un fichier JSON quelconque.

  npm run import-external -- twroz-mobs.json
  npm run import-external -- base.json --source "TW RO Zero" --ecrire

Options
  -s, --source <texte>  d'ou viennent ces donnees (note dans le fichier produit)
  -o, --out <fichier>   defaut : public/data/drops.json
      --data <dossier>  ou lire l'oracle          (defaut : public/data)
      --ecrire          ecrit vraiment ; sans ca, on montre et on s'arrete
      --max <n>         nombre de lignes montrees                (defaut : 12)

Pourquoi un essai a blanc par defaut
  Une table importee ecrase la precedente. Mieux vaut regarder ce qui a ete
  compris avant de la remplacer.
`

/** Sous ce nombre de monstres reconnus, ce n'est pas une table de drop. */
const MIN_MOBS = 5
/** Echelles usuelles des taux, de la plus fine a la plus grossiere. */
const ECHELLES = [
  { base: 1000000, note: 'un millionieme' },
  { base: 100000, note: 'un cent-millieme' },
  { base: 10000, note: 'un dix-millieme (0,01 %)' },
  { base: 1000, note: 'un milieme' },
  { base: 100, note: 'pourcentage' },
]

function parseArgs(argv) {
  const args = { max: 12 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--source' || a === '-s') args.source = argv[++i]
    else if (a === '--out' || a === '-o') args.out = path.resolve(argv[++i])
    else if (a === '--data') args.data = path.resolve(argv[++i])
    else if (a === '--ecrire') args.ecrire = true
    else if (a === '--max') args.max = Number(argv[++i])
    else if (a === '--help' || a === '-h') args.help = true
    else if (!args.file) args.file = a
  }
  return args
}

const estEntier = (v) => Number.isInteger(v) || (typeof v === 'string' && /^\d+$/.test(v))
const entier = (v) => (typeof v === 'string' ? Number(v) : v)

/**
 * Les champs d'un objet qui portent un identifiant connu.
 *
 * On rend tous les candidats plutot que le premier : c'est la repetition sur
 * l'ensemble du fichier qui tranchera, pas un cas isole.
 */
function champsConnus(noeud, connus) {
  if (!noeud || typeof noeud !== 'object') return []
  return Object.entries(noeud)
    .filter(([, v]) => estEntier(v) && connus.has(entier(v)))
    .map(([k]) => k)
}

/**
 * Cherche, dans tout le fichier, la forme "un monstre et ses objets".
 *
 * Un noeud retenu doit avoir les deux : un champ dont la valeur est un monstre
 * du client, et une liste dont les elements portent un objet du client. Les
 * noms de ces champs sont ceux qui reviennent le plus souvent — un nom qui ne
 * colle qu'une fois est une coincidence, pas une convention.
 */
export function inferShape(racine, oracle) {
  const votesMob = new Map()
  const votesListe = new Map()
  const votesItem = new Map()
  const noeuds = []

  const visite = (noeud, profondeur) => {
    if (profondeur > 8 || !noeud || typeof noeud !== 'object') return
    if (Array.isArray(noeud)) {
      for (const e of noeud) visite(e, profondeur + 1)
      return
    }

    const champsMob = champsConnus(noeud, oracle.mobs)
    if (champsMob.length) {
      for (const [cle, valeur] of Object.entries(noeud)) {
        if (!Array.isArray(valeur) || !valeur.length) continue
        const champsItem = new Map()
        for (const element of valeur) {
          for (const champ of champsConnus(element, oracle.items)) {
            champsItem.set(champ, (champsItem.get(champ) || 0) + 1)
          }
        }
        if (!champsItem.size) continue
        // La liste doit majoritairement contenir des objets connus, sinon ce
        // n'est pas une table de drop mais une liste qui en croise un.
        const meilleur = [...champsItem].sort((a, b) => b[1] - a[1])[0]
        if (meilleur[1] < valeur.length / 2) continue

        for (const champ of champsMob) votesMob.set(champ, (votesMob.get(champ) || 0) + 1)
        votesListe.set(cle, (votesListe.get(cle) || 0) + 1)
        votesItem.set(meilleur[0], (votesItem.get(meilleur[0]) || 0) + 1)
        noeuds.push(noeud)
      }
    }

    for (const valeur of Object.values(noeud)) visite(valeur, profondeur + 1)
  }

  visite(racine, 0)
  if (noeuds.length < MIN_MOBS) return null

  const dominant = (votes) => [...votes].sort((a, b) => b[1] - a[1])[0][0]
  const forme = {
    mob: dominant(votesMob),
    liste: dominant(votesListe),
    item: dominant(votesItem),
    noeuds: noeuds.length,
  }
  forme.taux = inferRateField(noeuds, forme, oracle)
  return forme
}

/**
 * Quel champ porte le taux.
 *
 * Un taux est un nombre qui varie d'un objet a l'autre, et qui n'est pas un
 * identifiant. On ecarte donc le champ de l'objet, puis on garde celui qui est
 * present partout et qui prend le plus de valeurs differentes : une constante
 * ne serait pas un taux.
 */
export function inferRateField(noeuds, forme, oracle) {
  const valeurs = new Map()
  let total = 0
  for (const noeud of noeuds) {
    for (const element of noeud[forme.liste] || []) {
      if (!element || typeof element !== 'object') continue
      total++
      for (const [cle, v] of Object.entries(element)) {
        if (cle === forme.item) continue
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) continue
        // Un champ dont la valeur est toujours un objet connu est un second
        // identifiant, pas un taux.
        if (oracle.items.has(v)) continue
        if (!valeurs.has(cle)) valeurs.set(cle, [])
        valeurs.get(cle).push(v)
      }
    }
  }
  if (!total) return null

  let best = null
  for (const [cle, liste] of valeurs) {
    if (liste.length < total * 0.8) continue
    const distincts = new Set(liste).size
    if (distincts < 2) continue
    if (!best || distincts > best.distincts) best = { cle, distincts, max: Math.max(...liste) }
  }
  return best
}

/**
 * A quelle echelle sont ecrits ces taux.
 *
 * Personne ne l'ecrit dans le fichier, mais l'ordre de grandeur le dit : une
 * table en dix-milliemes monte a 10000, une table en pourcentage plafonne a
 * 100. On prend la plus fine qui contienne encore la plus grande valeur.
 */
export function inferScale(max) {
  for (const echelle of [...ECHELLES].reverse()) {
    if (max <= echelle.base) return echelle
  }
  return ECHELLES[0]
}

/** Convertit la forme reconnue en la table que l'application sait lire. */
export function buildTable(racine, oracle, { source = null } = {}) {
  const forme = inferShape(racine, oracle)
  if (!forme) return null

  const echelle = forme.taux ? inferScale(forme.taux.max) : null
  const mobs = {}
  let entrees = 0
  let inconnus = 0

  const visite = (noeud, profondeur) => {
    if (profondeur > 8 || !noeud || typeof noeud !== 'object') return
    if (Array.isArray(noeud)) { for (const e of noeud) visite(e, profondeur + 1); return }

    const mobId = entier(noeud[forme.mob])
    const liste = noeud[forme.liste]
    if (oracle.mobs.has(mobId) && Array.isArray(liste)) {
      const drops = []
      for (const element of liste) {
        if (!element || typeof element !== 'object') continue
        const item = entier(element[forme.item])
        if (!Number.isInteger(item)) continue
        if (!oracle.items.has(item)) { inconnus++; continue }
        const brut = forme.taux ? element[forme.taux.cle] : null
        drops.push({
          item,
          chance: typeof brut === 'number' && echelle ? (brut / echelle.base) * 100 : null,
          label: oracle.itemNames?.get(item) || undefined,
        })
        entrees++
      }
      if (drops.length) {
        drops.sort((a, b) => (b.chance ?? 0) - (a.chance ?? 0))
        mobs[String(mobId)] = drops
      }
    }

    for (const valeur of Object.values(noeud)) visite(valeur, profondeur + 1)
  }

  visite(racine, 0)
  return {
    forme,
    echelle,
    inconnus,
    table: {
      meta: {
        source,
        importedAt: new Date().toISOString(),
        base: echelle?.base ?? null,
        mobs: Object.keys(mobs).length,
        entries: entrees,
      },
      mobs,
    },
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.file) { console.log(HELP); return }

  const oracle = loadOracle(args.data)
  if (!oracle.mobs.size || !oracle.items.size) {
    console.error("L'oracle est vide : lance d'abord `npm run extract`.")
    console.error('Sans la liste des monstres et des objets du client, rien ne peut etre reconnu.')
    process.exit(1)
  }

  let racine
  try {
    racine = JSON.parse(fs.readFileSync(args.file, 'utf8'))
  } catch (err) {
    console.error(`${args.file} : ${err.message}`)
    process.exit(1)
  }

  const resultat = buildTable(racine, oracle, { source: args.source || path.basename(args.file) })
  if (!resultat) {
    console.error('\nAucune table de drop reconnue dans ce fichier.')
    console.error('On y cherche un objet portant un identifiant de monstre du client, et une')
    console.error("liste dont les elements portent un identifiant d'objet du client.")
    console.error("Si le fichier utilise des noms au lieu d'identifiants, il faut d'abord les")
    console.error('convertir : envoie-moi un extrait.')
    process.exit(1)
  }

  const { forme, echelle, inconnus, table } = resultat
  console.log(`Champs deduits : monstre « ${forme.mob} », liste « ${forme.liste} », ` +
    `objet « ${forme.item} », taux « ${forme.taux?.cle ?? 'aucun'} »`)
  console.log(echelle
    ? `Echelle deduite : ${echelle.base} (${echelle.note}), d'apres un maximum de ${forme.taux.max}`
    : 'Aucun champ de taux : seuls les objets seront importes.')
  console.log(`Reconnu : ${table.meta.mobs} monstres, ${table.meta.entries} drops` +
    (inconnus ? `, ${inconnus} objet(s) inconnus du client ignores` : ''))
  console.log(`Couverture : ${table.meta.mobs} des ${oracle.mobs.size} monstres du client\n`)

  for (const [mobId, drops] of Object.entries(table.mobs).slice(0, args.max)) {
    const nom = oracle.mobNames?.get(Number(mobId)) || '?'
    console.log(`  ${String(mobId).padStart(5)} ${nom}`)
    for (const drop of drops.slice(0, 4)) {
      console.log(`        ${drop.chance === null ? '     ?' : `${drop.chance.toFixed(2)} %`}  ` +
        `${drop.item} ${drop.label || ''}`.trim())
    }
  }

  const out = args.out || path.join(ROOT, 'public', 'data', 'drops.json')
  if (!args.ecrire) {
    console.log(`\nEssai a blanc. Verifie deux ou trois lignes en jeu, puis relance avec --ecrire.`)
    console.log(`Le fichier serait ecrit dans ${out}`)
    return
  }
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(table, null, 2))
  console.log(`\nEcrit dans ${out}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
