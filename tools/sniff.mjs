#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { ROOT } from './client-path.mjs'

/**
 * Capture passive du trafic du jeu.
 *
 * Passive au sens strict : on lit ce qui passe sur la carte reseau, sans jamais
 * toucher au processus du jeu, sans rien injecter ni modifier. Rien n'est
 * envoye nulle part — le fichier reste sur la machine, et l'analyse se fait
 * ensuite, hors ligne, avec `npm run analyze`.
 *
 * Deux outils possibles, dans cet ordre :
 *  - pktmon, livre avec Windows 10 et 11 : rien a installer
 *  - dumpcap / tshark (Wireshark), ou tcpdump ailleurs
 */

const HELP = `
Capture le trafic du jeu vers un fichier, a analyser ensuite.

  npm run sniff                     # detecte l'outil et la connexion du jeu
  npm run sniff -- --list           # liste les interfaces reseau
  npm run sniff -- --tool wireshark # impose l'outil (pktmon | wireshark)

Options
  -i, --interface <n>   interface de capture (Wireshark uniquement)
  -p, --port <n>        port du serveur de jeu
  -H, --host <ip>       adresse du serveur de jeu
  -o, --out <fichier>   defaut : captures/roz-<horodatage>.pcapng
  -d, --duration <s>    arret automatique apres n secondes
      --tool <nom>      pktmon | wireshark | tcpdump
      --list            liste les interfaces puis quitte

Marche a suivre
  1. Ouvre un terminal en administrateur et lance cette commande AVANT le jeu.
     Une capture demarree apres la connexion rate l'essentiel du trafic.
  2. Lance le jeu et connecte-toi.
  3. Traverse la carte : chaque monstre croise donne son espece.
     Survole ou cible les monstres : c'est a ce moment-la, et pas avant, que le
     serveur envoie leur nom.
  4. Ctrl+C pour arreter, puis :  npm run analyze -- <fichier>
`

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--interface' || a === '-i') args.interface = argv[++i]
    else if (a === '--port' || a === '-p') args.port = Number(argv[++i])
    else if (a === '--host' || a === '-H') args.host = argv[++i]
    else if (a === '--out' || a === '-o') args.out = path.resolve(argv[++i])
    else if (a === '--duration' || a === '-d') args.duration = Number(argv[++i])
    else if (a === '--tool') args.tool = argv[++i]
    else if (a === '--list') args.list = true
    else if (a === '--help' || a === '-h') args.help = true
  }
  return args
}

const run = (cmd, cmdArgs) => spawnSync(cmd, cmdArgs, { encoding: 'utf8' })
const works = (cmd, cmdArgs) => {
  const r = run(cmd, cmdArgs)
  return !r.error && r.status === 0
}

/**
 * pktmon d'abord : il est deja la sur toute machine Windows recente, alors que
 * Wireshark demande une installation et un pilote de capture.
 */
export function findCaptureTool(preferred) {
  const candidates = []
  if (process.platform === 'win32') {
    candidates.push({ kind: 'pktmon', cmd: 'pktmon', probe: ['help'] })
  }
  candidates.push(
    { kind: 'wireshark', cmd: 'dumpcap', probe: ['-v'] },
    { kind: 'wireshark', cmd: 'tshark', probe: ['-v'] },
    { kind: 'wireshark', cmd: 'C:\\Program Files\\Wireshark\\dumpcap.exe', probe: ['-v'] },
    { kind: 'tcpdump', cmd: 'tcpdump', probe: ['--version'] },
  )

  const wanted = preferred
    ? candidates.filter((c) => c.kind === preferred || c.cmd === preferred)
    : candidates
  return wanted.find((c) => works(c.cmd, c.probe)) || null
}

/** Retrouve la connexion du jeu : le processus Ragnarok et son pair distant. */
export function findGameConnection() {
  try {
    if (process.platform === 'win32') {
      const tasks = run('tasklist', ['/FO', 'CSV', '/NH']).stdout || ''
      const pids = tasks.split(/\r?\n/)
        .filter((line) => /rag(exe|narok)|roz/i.test(line))
        .map((line) => Number((line.split('","')[1] || '').replace(/"/g, '')))
        .filter(Boolean)
      if (!pids.length) return null

      const netstat = run('netstat', ['-ano']).stdout || ''
      for (const line of netstat.split(/\r?\n/)) {
        const m = /^\s*TCP\s+(\S+)\s+(\S+)\s+ESTABLISHED\s+(\d+)/.exec(line)
        if (!m || !pids.includes(Number(m[3]))) continue
        const at = m[2].lastIndexOf(':')
        return { host: m[2].slice(0, at), port: Number(m[2].slice(at + 1)) }
      }
      return null
    }
    const out = run('ss', ['-tnp']).stdout || ''
    for (const line of out.split('\n')) {
      if (!/rag|roz/i.test(line)) continue
      const m = /ESTAB.*?\s(\S+):(\d+)\s*$/.exec(line.split(/\s+users:/)[0])
      if (m) return { host: m[1], port: Number(m[2]) }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Attend Ctrl+C, ou la duree demandee.
 *
 * Le minuteur n'est pas seulement la pour afficher la progression : un
 * gestionnaire de signal ne suffit pas a retenir Node, qui rend la main des que
 * sa boucle d'evenements est vide. Sans lui, la capture s'arretait aussitot.
 */
export function waitForStop(duration, onTick) {
  return new Promise((resolve) => {
    let done = false
    const tick = setInterval(() => onTick?.(), 2000)
    const finish = () => {
      if (done) return
      done = true
      clearInterval(tick)
      if (timer) clearTimeout(timer)
      resolve()
    }
    const timer = duration ? setTimeout(finish, duration * 1000) : null
    process.on('SIGINT', finish)
  })
}

/** Progression pendant la capture : sans elle, on ne sait pas si ca marche. */
function progressReporter(file) {
  let last = -1
  return () => {
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0
    if (size === last) return
    last = size
    process.stdout.write(`\r  ${(size / 1024).toFixed(0)} ko captures...   `)
  }
}

/**
 * pktmon ecrit un .etl, format propre a Windows, qu'il convertit lui-meme en
 * pcapng. Les options ont change entre les versions de Windows : on essaie la
 * forme recente puis l'ancienne plutot que d'exiger une version precise.
 */
export async function capturePktmon({ port, out, duration }) {
  const etl = out.replace(/\.pcapng$/i, '.etl')
  fs.mkdirSync(path.dirname(out), { recursive: true })

  run('pktmon', ['stop'])
  run('pktmon', ['filter', 'remove'])
  if (port) {
    const added = works('pktmon', ['filter', 'add', 'roz', '-t', 'TCP', '-p', String(port)]) ||
      works('pktmon', ['filter', 'add', '-t', 'TCP', '-p', String(port)])
    console.log(added
      ? `Filtre  : TCP port ${port}`
      : 'Filtre  : aucun (pktmon l\'a refuse) — tout le trafic est capture.')
  }

  const started =
    works('pktmon', ['start', '--capture', '--pkt-size', '0', '--file-name', etl, '--file-size', '512']) ||
    works('pktmon', ['start', '--etw', '-c', '-p', '0', '-f', etl, '-s', '512'])

  if (!started) {
    console.error('pktmon n\'a pas demarre. Ouvre le terminal en administrateur.')
    process.exit(1)
  }

  console.log(`Sortie  : ${out}`)
  console.log('\nCapture en cours. Lance le jeu, traverse la carte et survole les monstres')
  console.log('(le serveur n\'envoie leur nom que quand le client le demande), puis Ctrl+C.\n')

  await waitForStop(duration, progressReporter(etl))

  console.log('\n\nArret de la capture...')
  run('pktmon', ['stop'])
  run('pktmon', ['filter', 'remove'])

  const converted = works('pktmon', ['etl2pcap', etl, '-o', out]) ||
    works('pktmon', ['pcapng', etl, '-o', out])
  if (!converted || !fs.existsSync(out)) {
    console.error(`Conversion en pcapng impossible. La capture brute est dans ${etl}.`)
    console.error('Convertis-la avec :  pktmon etl2pcap "' + etl + '" -o "' + out + '"')
    process.exit(1)
  }
  fs.rmSync(etl, { force: true })
  return out
}

/** dumpcap, tshark et tcpdump partagent les memes options utiles. */
export async function captureWireshark(tool, { host, port, out, duration, iface }) {
  const filter = host && port ? `host ${host} and tcp port ${port}`
    : port ? `tcp port ${port}`
    : host ? `host ${host}`
    : 'tcp'

  fs.mkdirSync(path.dirname(out), { recursive: true })
  const cmdArgs = ['-f', filter, '-w', out]
  if (iface) cmdArgs.unshift('-i', String(iface))
  // `-a duration:` est une option de dumpcap et tshark ; tcpdump ne la connait
  // pas, on l'arrete par signal a la place.
  if (duration && tool.kind === 'wireshark') cmdArgs.push('-a', `duration:${duration}`)

  console.log(`Filtre  : ${filter}`)
  console.log(`Sortie  : ${out}`)
  console.log('\nCapture en cours. Ctrl+C pour arreter.\n')

  const child = spawn(tool.cmd, cmdArgs, { stdio: ['ignore', 'inherit', 'inherit'] })
  const stop = () => { try { child.kill('SIGINT') } catch { /* deja arrete */ } }
  process.on('SIGINT', stop)

  const tick = setInterval(progressReporter(out), 2000)
  const timer = duration ? setTimeout(stop, duration * 1000) : null

  await new Promise((resolve) => child.on('exit', resolve))
  clearInterval(tick)
  if (timer) clearTimeout(timer)
  console.log('')
  return out
}

function listInterfaces(tool) {
  if (tool.kind === 'pktmon') {
    const out = run('pktmon', ['list']).stdout || run('pktmon', ['component', 'list']).stdout
    console.log(out || 'pktmon capture toutes les interfaces : aucun choix a faire.')
    return
  }
  const r = run(tool.cmd, ['-D'])
  if (r.status !== 0) {
    console.error('Impossible de lister les interfaces. Sous Windows, Npcap doit etre installe.')
    return
  }
  console.log('Interfaces disponibles\n')
  console.log((r.stdout || '').trim())
  console.log('\nRelance avec  npm run sniff -- -i <numero>')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { console.log(HELP); return }

  const tool = findCaptureTool(args.tool)
  if (!tool) {
    console.error('Aucun outil de capture disponible.')
    console.error('')
    if (process.platform === 'win32') {
      console.error('pktmon est livre avec Windows 10 et 11 : ouvre simplement le terminal')
      console.error('en administrateur. Sinon, installe Wireshark (avec Npcap).')
    } else {
      console.error('Installe tcpdump ou Wireshark.')
    }
    process.exit(1)
  }
  console.log(`Outil   : ${tool.cmd}${tool.kind === 'pktmon' ? ' (fourni avec Windows)' : ''}`)

  if (args.list) { listInterfaces(tool); return }

  let { host, port } = args
  if (!host && !port) {
    const found = findGameConnection()
    if (found) {
      host = found.host
      port = found.port
      console.log(`Connexion du jeu detectee : ${host}:${port}`)
    } else {
      console.log('Connexion du jeu non detectee — tout le trafic TCP sera capture.')
      console.log('Lance le jeu et connecte-toi avant, ou impose --host et --port.')
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const out = args.out || path.join(ROOT, 'captures', `roz-${stamp}.pcapng`)

  const file = tool.kind === 'pktmon'
    ? await capturePktmon({ host, port, out, duration: args.duration })
    : await captureWireshark(tool, { host, port, out, duration: args.duration, iface: args.interface })

  const size = fs.existsSync(file) ? fs.statSync(file).size : 0
  if (!size) {
    console.error('\nCapture vide. Verifie que le terminal est ouvert en administrateur.')
    process.exit(1)
  }
  console.log(`\nCapture terminee : ${(size / 1024).toFixed(0)} ko`)
  console.log(`Analyse :  npm run analyze -- "${file}"`)
}

// argv[1] est absent quand le module est importe, notamment par npm run watch.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
