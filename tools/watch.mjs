#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { ROOT } from './client-path.mjs'
import { findCaptureTool, findGameConnection, capturePktmon, captureWireshark } from './sniff.mjs'
import { loadFlows, looksTls } from './pcap.mjs'
import {
  frameStream, readEntries, inferClassOffset, inferItemPackets,
  readNameReplies, readMapChanges, readVanishings,
} from './packets.mjs'

/**
 * Capture en continu, et remplit la base au fur et a mesure.
 *
 * `npm run sniff` prend une photo qu'il faut ensuite analyser a la main. Ici on
 * boucle : on capture un morceau, on le lit, on verse ce qu'on y a compris dans
 * observations.json, on recommence. Rien ne quitte la machine.
 *
 * Ce que la boucle apprend, et qui n'est nulle part dans le client :
 *  - quelles especes vivent sur quelle carte, et en quel nombre ;
 *  - le nom localise d'un monstre, que le serveur n'envoie que si on le survole ;
 *  - les objets tombes au sol apres une mort, donc un taux **observe**.
 *
 * Un taux observe n'est pas le taux officiel : c'est un comptage, et il ne vaut
 * que par le nombre de morts derriere lui. Le fichier garde donc toujours les
 * deux nombres, jamais le seul pourcentage.
 */

const HELP = `
Capture en continu et remplit la base au fur et a mesure.

  npm run watch                    # boucle jusqu'a Ctrl+C
  npm run watch -- --chunk 30      # morceaux de 30 s (defaut : 45)
  npm run watch -- --no-serve      # sans le serveur de l'overlay

Options
  -c, --chunk <s>     duree d'un morceau de capture   (defaut : 45)
  -p, --port <n>      port du serveur local           (defaut : 7355)
      --data <dir>    ou ecrire les observations      (defaut : public/data)
      --brut <fichier> conserve le flux serveur brut, pour analyse ulterieure
      --garder <dir>  conserve aussi les captures au lieu de les effacer
      --no-serve      ne pas ouvrir le serveur local
      --host <ip>     adresse du serveur de jeu
      --port-jeu <n>  port du serveur de jeu

Marche a suivre
  1. Terminal en administrateur, puis cette commande, AVANT de lancer le jeu.
  2. Joue normalement. Survole les monstres : c'est a ce moment-la, et pas
     avant, que le serveur envoie leur nom.
  3. L'overlay est sur http://localhost:7355/  (bouton "toujours au-dessus").
`

/** Ce qui compte comme "juste apres une mort", en paquets. */
const FENETRE_DROP = 40
/** Nombre de morceaux ou une piste doit reapparaitre avant d'etre crue. */
const CONFIRMATIONS = 3

function parseArgs(argv) {
  const args = { chunk: 45, port: 7355, serve: true }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--chunk' || a === '-c') args.chunk = Number(argv[++i])
    else if (a === '--port' || a === '-p') args.port = Number(argv[++i])
    else if (a === '--data') args.data = path.resolve(argv[++i])
    else if (a === '--brut') args.brut = path.resolve(argv[++i])
    else if (a === '--garder') args.garder = path.resolve(argv[++i])
    else if (a === '--no-serve') args.serve = false
    else if (a === '--host') args.host = argv[++i]
    else if (a === '--port-jeu') args.gamePort = Number(argv[++i])
    else if (a === '--help' || a === '-h') args.help = true
  }
  return args
}

/** Longueur en deca de laquelle un nom n'en est pas un. */
const NOM_MINIMUM = 3

/** Etat cumule, relu au demarrage : une session reprend la precedente. */
function loadState(file) {
  if (fs.existsSync(file)) {
    try { return nettoyer(JSON.parse(fs.readFileSync(file, 'utf8'))) } catch { /* on repart de zero */ }
  }
  return { version: 1, octets: 0, morceaux: 0, cartes: {}, mobs: {}, pistes: {}, objets: {} }
}

/**
 * Repare un fichier ecrit par une version qui lisait mal les noms.
 *
 * Elle gardait la premiere position livrant du texte, et les octets d'un
 * identifiant s'y lisaient parfois comme deux lettres — "if", "Xm". Ces noms-la
 * sont effaces au chargement : le prochain survol du monstre les remplacera par
 * le vrai, et en attendant le nom du client vaut mieux qu'une bribe.
 */
function nettoyer(state) {
  for (const mob of Object.values(state.mobs || {})) {
    if (mob.nomServeur && mob.nomServeur.length < NOM_MINIMUM) mob.nomServeur = null
  }
  return state
}

function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(state, null, 2))
}

/** Oracle du client : sans lui, on ne reconnait ni carte, ni monstre, ni objet. */
function loadOracle(dataDir) {
  const read = (name) => {
    const file = path.join(dataDir, name)
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
  }
  const mobTable = read('mobs.json')
  const mapTable = read('maps.json')
  return {
    items: new Set(Object.keys(read('items.json')).map(Number)),
    mobs: new Set(Object.keys(mobTable).map(Number)),
    mobNames: new Map(Object.entries(mobTable).map(([id, m]) => [Number(id), m?.nom || m?.name])),
    maps: new Set(Object.values(mapTable).map((m) => m?.id || m?.nom || m?.name).filter(Boolean)),
  }
}

/**
 * Lit un morceau de capture et en tire tout ce qui est verifiable.
 *
 * Rien n'est ecrit ici : la fonction rend ce qu'elle a compris, et c'est
 * l'appelant qui decide de le cumuler. C'est ce qui la rend testable sans
 * carte reseau ni fichier.
 */
export function observeStream(data, oracle) {
  const framed = frameStream(data)
  const entries = readEntries(framed.packets)
  const classe = inferClassOffset(entries, oracle.mobs)

  const out = {
    paquets: framed.packets.length,
    couverture: framed.coverage,
    carte: null,
    especes: new Map(),   // classe -> nombre d'apparitions
    noms: new Map(),      // classe -> nom localise
    morts: new Map(),     // classe -> nombre de disparitions
    drops: new Map(),     // classe -> Map(objet -> nombre)
    pistes: [],           // paquets a objets, a confirmer sur plusieurs morceaux
  }

  const changes = readMapChanges(framed.packets, oracle.maps)
  if (changes.length) out.carte = changes[changes.length - 1].map

  // Un monstre est identifie par l'identifiant de son apparition ; sa classe,
  // elle, ne figure que dans ce paquet-la. On garde donc la correspondance pour
  // rattacher plus loin les noms, les morts et les objets tombes.
  const classeDe = new Map()
  if (classe) {
    for (const e of entries) {
      if (e.kind !== 'monstre') continue
      const id = e.payload.readUInt16LE(classe.offset)
      classeDe.set(e.aid, id)
      out.especes.set(id, (out.especes.get(id) || 0) + 1)
    }
  }

  // Les noms se reconnaissent d'abord, se trient ensuite — et pas l'inverse :
  // c'est la repetition d'un meme paquet qui prouve que c'en est un, donc le
  // restreindre aux monstres avant de compter le priverait de sa preuve. Une
  // fois reconnus, on ne garde que ceux des monstres : les pseudonymes des
  // autres joueurs passent dans le flux et n'ont rien a faire dans la base.
  for (const r of readNameReplies(framed.packets)) {
    const cls = classeDe.get(r.id)
    if (cls) out.noms.set(cls, r.name)
  }

  const morts = readVanishings(framed.packets, new Set(classeDe.keys()))
  for (const m of morts) {
    const cls = classeDe.get(m.id)
    if (cls) out.morts.set(cls, (out.morts.get(cls) || 0) + 1)
  }

  // Objets tombes : on ne sait pas encore quel paquet les annonce, donc on
  // garde les pistes et on ne les croit qu'apres plusieurs morceaux.
  const pistes = inferItemPackets(framed.packets, oracle.items)
  for (const piste of pistes) {
    out.pistes.push({ opcode: piste.opcode, offset: piste.offset, size: piste.size })
  }

  // Rattachement d'un objet a l'espece morte juste avant : c'est la seule facon
  // d'obtenir un taux, faute que le serveur envoie jamais la moindre probabilite.
  const parOffset = [...morts].sort((a, b) => a.offset - b.offset)
  for (const piste of pistes) {
    for (const p of framed.packets) {
      if (p.opcode !== piste.opcode || p.payload.length < piste.offset + piste.size) continue
      const objet = piste.size === 2
        ? p.payload.readUInt16LE(piste.offset)
        : p.payload.readUInt32LE(piste.offset)
      if (!oracle.items.has(objet)) continue
      const mort = derniereMortAvant(parOffset, p.offset, framed.packets)
      const cls = mort && classeDe.get(mort.id)
      if (!cls) continue
      if (!out.drops.has(cls)) out.drops.set(cls, new Map())
      const table = out.drops.get(cls)
      table.set(objet, (table.get(objet) || 0) + 1)
    }
  }

  return out
}

/** La mort la plus proche avant cet octet, si elle est assez proche. */
function derniereMortAvant(morts, offset, packets) {
  let trouvee = null
  for (const m of morts) {
    if (m.offset >= offset) break
    trouvee = m
  }
  if (!trouvee) return null
  const entre = packets.filter((p) => p.offset > trouvee.offset && p.offset < offset).length
  return entre <= FENETRE_DROP ? trouvee : null
}

/** Verse une lecture dans l'etat cumule. */
export function mergeObservation(state, obs, oracle) {
  state.morceaux++
  const carte = obs.carte || state.derniereCarte || 'inconnue'
  if (obs.carte) state.derniereCarte = obs.carte
  if (!state.cartes[carte]) state.cartes[carte] = { especes: {} }

  for (const [cls, n] of obs.especes) {
    const key = String(cls)
    if (!state.mobs[key]) {
      state.mobs[key] = { nom: oracle.mobNames?.get(cls) || null, nomServeur: null, vues: 0, morts: 0, drops: {} }
    }
    state.mobs[key].vues += n
    state.cartes[carte].especes[key] = (state.cartes[carte].especes[key] || 0) + n
  }
  for (const [cls, nom] of obs.noms) {
    const key = String(cls)
    if (state.mobs[key]) state.mobs[key].nomServeur = nom
  }
  for (const [cls, n] of obs.morts) {
    const key = String(cls)
    if (state.mobs[key]) state.mobs[key].morts += n
  }
  for (const [cls, table] of obs.drops) {
    const key = String(cls)
    if (!state.mobs[key]) continue
    for (const [objet, n] of table) {
      state.mobs[key].drops[objet] = (state.mobs[key].drops[objet] || 0) + n
    }
  }
  for (const piste of obs.pistes) {
    const key = `0x${piste.opcode.toString(16)}+${piste.offset}/${piste.size}`
    state.pistes[key] = (state.pistes[key] || 0) + 1
  }
  return state
}

/** Ce qu'on affiche : uniquement ce qui repose sur assez d'observations. */
export function summarize(state) {
  const mobs = Object.entries(state.mobs).map(([id, m]) => ({
    id: Number(id),
    nom: m.nomServeur || m.nom || `monstre ${id}`,
    nomClient: m.nom,
    nomServeur: m.nomServeur,
    vues: m.vues,
    morts: m.morts,
    drops: Object.entries(m.drops).map(([objet, n]) => ({
      objet: Number(objet),
      fois: n,
      // Un taux observe sans morts derriere lui n'est pas un taux.
      taux: m.morts >= 1 ? n / m.morts : null,
    })).sort((a, b) => b.fois - a.fois),
  })).sort((a, b) => b.vues - a.vues)

  return {
    carte: state.derniereCarte || null,
    morceaux: state.morceaux,
    octets: state.octets,
    mobs,
    cartes: state.cartes,
    pistesConfirmees: Object.entries(state.pistes || {})
      .filter(([, n]) => n >= CONFIRMATIONS).map(([k]) => k),
  }
}

/** Serveur local : l'overlay lit ici, et rien ne sort de la machine. */
function serve(port, getState, dataDir) {
  const clients = new Set()
  const dist = path.join(ROOT, 'dist')

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`)
    // L'overlay peut aussi tourner sur le serveur de developpement de Vite,
    // sur un autre port : sans cet en-tete le navigateur refuserait de lire.
    const partage = { 'access-control-allow-origin': '*' }
    if (url.pathname === '/etat') {
      res.writeHead(200, { ...partage, 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(getState()))
      return
    }
    if (url.pathname === '/flux') {
      res.writeHead(200, {
        ...partage,
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(`data: ${JSON.stringify(getState())}\n\n`)
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }
    // Les donnees sont servies depuis leur dossier de travail, pas depuis la
    // copie figee dans dist/ : la boucle les met a jour pendant qu'on joue.
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    const racine = url.pathname.startsWith('/data/') ? path.dirname(dataDir) : dist
    const file = path.join(racine, rel)
    if (file.startsWith(racine) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }
      res.writeHead(200, {
        ...partage,
        'content-type': `${types[path.extname(file)] || 'application/octet-stream'}; charset=utf-8`,
      })
      res.end(fs.readFileSync(file))
      return
    }
    res.writeHead(404).end('rien ici')
  })

  server.listen(port)
  return {
    push: (state) => {
      const line = `data: ${JSON.stringify(state)}\n\n`
      for (const c of clients) c.write(line)
    },
    close: () => server.close(),
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { console.log(HELP); return }

  const dataDir = args.data || path.join(ROOT, 'public', 'data')
  const oracle = loadOracle(dataDir)
  if (!oracle.mobs.size) {
    console.error(`${dataDir}/mobs.json est vide : lance d'abord \`npm run extract\`.`)
    console.error('Sans la liste des monstres du client, rien dans le flux ne peut etre reconnu.')
    process.exit(1)
  }

  const tool = findCaptureTool()
  if (!tool) {
    console.error('Aucun outil de capture disponible.')
    console.error(process.platform === 'win32'
      ? 'pktmon est livre avec Windows : ouvre le terminal en administrateur.'
      : 'Installe tcpdump ou Wireshark.')
    process.exit(1)
  }

  let { host, gamePort: port } = args
  if (!host && !port) {
    const found = findGameConnection()
    if (found) { host = found.host; port = found.port }
  }

  const stateFile = path.join(dataDir, 'observations.json')
  const state = loadState(stateFile)
  state.octets = state.octets || 0

  console.log(`Outil   : ${tool.cmd}`)
  console.log(`Base    : ${stateFile}`)
  console.log(host ? `Jeu     : ${host}:${port}` : 'Jeu     : non detecte, tout le TCP sera lu')
  const site = args.serve ? serve(args.port, () => summarize(state), dataDir) : null
  if (site) console.log(`Overlay : http://localhost:${args.port}/#/overlay`)
  console.log(`\nMorceaux de ${args.chunk} s. Ctrl+C pour arreter.\n`)

  let stop = false
  process.on('SIGINT', () => {
    stop = true
    console.log('\nArret demande : le morceau en cours se termine, puis on enregistre.')
  })

  // Les morceaux vivent dans un dossier temporaire et disparaissent une fois
  // lus : une session de plusieurs heures remplirait le disque autrement. Mais
  // le flux du serveur, lui, peut etre conserve — c'est la seule matiere pour
  // comprendre un paquet qu'on ne sait pas encore lire.
  const tmp = args.garder || fs.mkdtempSync(path.join(os.tmpdir(), 'roz-watch-'))
  fs.mkdirSync(tmp, { recursive: true })
  if (args.brut) {
    fs.mkdirSync(path.dirname(args.brut), { recursive: true })
    console.log(`Flux brut : ${args.brut}`)
  }

  let n = 0
  while (!stop) {
    const out = path.join(tmp, `chunk-${n++}.pcapng`)
    try {
      if (tool.kind === 'pktmon') await capturePktmon({ host, port, out, duration: args.chunk })
      else await captureWireshark(tool, { host, port, out, duration: args.chunk })
    } catch (err) {
      console.error(`Capture interrompue : ${err.message}`)
      break
    }
    if (!fs.existsSync(out)) continue

    let flows = []
    try { flows = loadFlows(out) } catch (err) { console.error(`Lecture : ${err.message}`) }
    if (!args.garder) fs.rmSync(out, { force: true })

    for (const flow of flows) {
      if (flow.isServerToClient === false || looksTls(flow.data)) continue
      state.octets += flow.bytes
      // Les morceaux se suivent sans se raccorder : chacun commence au milieu
      // d'un paquet. Le decoupage sait s'y recaler, donc les mettre bout a bout
      // ne coute qu'un paquet perdu par morceau.
      if (args.brut) fs.appendFileSync(args.brut, flow.data)
      mergeObservation(state, observeStream(flow.data, oracle), oracle)
    }
    saveState(stateFile, state)

    const vue = summarize(state)
    const nommes = vue.mobs.filter((m) => m.nomServeur).length
    console.log(`  ${vue.carte || 'carte inconnue'} — ${vue.mobs.length} espece(s), ` +
      `${nommes} nommee(s), ${vue.mobs.reduce((s, m) => s + m.morts, 0)} mort(s), ` +
      `${(state.octets / 1024).toFixed(0)} ko lus`)
    site?.push(vue)
  }

  saveState(stateFile, state)
  site?.close()
  if (!args.garder) fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`\nEnregistre dans ${stateFile}`)
  if (args.brut && fs.existsSync(args.brut)) {
    console.log(`Flux brut  : ${args.brut} (${(fs.statSync(args.brut).size / 1024).toFixed(0)} ko)`)
    console.log(`Analyse    : npm run analyze -- "${args.brut}"`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
