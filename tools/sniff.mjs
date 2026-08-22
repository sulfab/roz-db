#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { ROOT } from './client-path.mjs'

/**
 * Capture passive du trafic du jeu.
 *
 * Passive au sens strict : on lit ce qui passe sur la carte reseau, sans jamais
 * toucher au processus du jeu, sans rien injecter ni modifier. L'outil ne fait
 * que piloter tshark ou dumpcap (Wireshark) et ecrire un fichier de capture ;
 * l'analyse se fait ensuite, hors ligne, avec `npm run analyze`.
 *
 * Rien n'est envoye nulle part : la capture reste sur ta machine.
 */

const HELP = `
Capture le trafic du jeu vers un fichier, a analyser ensuite.

  npm run sniff                     # detecte la connexion du jeu et capture
  npm run sniff -- --list           # liste les interfaces reseau
  npm run sniff -- -i 5 --port 6900 # interface et port imposes

Options
  -i, --interface <n>   interface de capture (numero ou nom, voir --list)
  -p, --port <n>        port du serveur de jeu
  -H, --host <ip>       adresse du serveur de jeu
  -o, --out <fichier>   defaut : captures/roz-<horodatage>.pcapng
  -d, --duration <s>    arret automatique apres n secondes
      --list            liste les interfaces puis quitte

Marche a suivre
  1. Lance le jeu et connecte-toi.
  2. Lance cette commande : elle detecte la connexion et capture.
  3. Dans le jeu, ouvre les fiches de monstres qui t'interessent.
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
    else if (a === '--list') args.list = true
    else if (a === '--help' || a === '-h') args.help = true
  }
  return args
}

/** tshark et dumpcap sont livres avec Wireshark ; dumpcap suffit pour capturer. */
function findCaptureTool() {
  const candidates = process.platform === 'win32'
    ? [
        'dumpcap', 'tshark',
        'C:\\Program Files\\Wireshark\\dumpcap.exe',
        'C:\\Program Files\\Wireshark\\tshark.exe',
        'C:\\Program Files (x86)\\Wireshark\\dumpcap.exe',
      ]
    : ['dumpcap', 'tshark', 'tcpdump']

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['-v'], { stdio: 'ignore' })
      return candidate
    } catch {
      // outil absent : on essaie le suivant
    }
  }
  return null
}

/**
 * Retrouve la connexion du jeu : le processus Ragnarok et son pair distant.
 * Evite d'avoir a deviner le port, qui change d'un serveur a l'autre.
 */
function findGameConnection() {
  try {
    if (process.platform === 'win32') {
      const tasks = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' })
      const pids = tasks.split(/\r?\n/)
        .filter((line) => /rag(exe|narok)|roz/i.test(line))
        .map((line) => Number((line.split('","')[1] || '').replace(/"/g, '')))
        .filter(Boolean)
      if (!pids.length) return null

      const netstat = execFileSync('netstat', ['-ano'], { encoding: 'utf8' })
      for (const line of netstat.split(/\r?\n/)) {
        const m = /^\s*TCP\s+(\S+)\s+(\S+)\s+ESTABLISHED\s+(\d+)/.exec(line)
        if (!m || !pids.includes(Number(m[3]))) continue
        const remote = m[2]
        const at = remote.lastIndexOf(':')
        return { host: remote.slice(0, at), port: Number(remote.slice(at + 1)) }
      }
      return null
    }

    const out = execFileSync('ss', ['-tnp'], { encoding: 'utf8' })
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

function listInterfaces(tool) {
  try {
    const out = execFileSync(tool, ['-D'], { encoding: 'utf8' })
    console.log('Interfaces disponibles\n')
    console.log(out.trim())
    console.log('\nRelance avec  npm run sniff -- -i <numero>')
  } catch (err) {
    console.error(`Impossible de lister les interfaces : ${err.message}`)
    console.error('Sous Windows, Npcap doit etre installe (il vient avec Wireshark).')
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { console.log(HELP); return }

  const tool = findCaptureTool()
  if (!tool) {
    console.error('Aucun outil de capture trouve (dumpcap, tshark, tcpdump).')
    console.error('')
    console.error('Sous Windows : installe Wireshark (https://www.wireshark.org/download.html),')
    console.error('en gardant Npcap coche pendant l\'installation. dumpcap sera alors disponible.')
    process.exit(1)
  }
  console.log(`Outil de capture : ${tool}`)

  if (args.list) { listInterfaces(tool); return }

  let { host, port } = args
  if (!host && !port) {
    const found = findGameConnection()
    if (found) {
      host = found.host
      port = found.port
      console.log(`Connexion du jeu detectee : ${host}:${port}`)
    } else {
      console.log('Connexion du jeu non detectee — capture de tout le trafic TCP.')
      console.log('Lance le jeu et connecte-toi avant, ou impose --host et --port.')
    }
  }

  const filter = host && port ? `host ${host} and tcp port ${port}`
    : port ? `tcp port ${port}`
    : host ? `host ${host}`
    : 'tcp'

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const out = args.out || path.join(ROOT, 'captures', `roz-${stamp}.pcapng`)
  fs.mkdirSync(path.dirname(out), { recursive: true })

  const cmd = ['-f', filter, '-w', out]
  if (args.interface) cmd.unshift('-i', String(args.interface))
  if (args.duration) cmd.push('-a', `duration:${args.duration}`)

  console.log(`Filtre  : ${filter}`)
  console.log(`Sortie  : ${out}`)
  console.log('')
  console.log('Capture en cours. Dans le jeu, ouvre les fiches des monstres qui t\'interessent,')
  console.log('puis Ctrl+C pour arreter.')
  console.log('')

  const child = spawn(tool, cmd, { stdio: ['ignore', 'inherit', 'inherit'] })

  const stop = () => { try { child.kill('SIGINT') } catch { /* deja arrete */ } }
  process.on('SIGINT', stop)

  child.on('exit', (code) => {
    const size = fs.existsSync(out) ? fs.statSync(out).size : 0
    if (!size) {
      console.error('\nCapture vide.')
      console.error('Verifie l\'interface (npm run sniff -- --list) et les droits :')
      console.error(process.platform === 'win32'
        ? '  lance le terminal en administrateur.'
        : '  sudo, ou setcap sur dumpcap.')
      process.exit(code || 1)
    }
    console.log(`\nCapture terminee : ${(size / 1024).toFixed(0)} ko`)
    console.log(`Analyse :  npm run analyze -- "${out}"`)
  })
}

if (os.platform() === 'darwin' && process.getuid && process.getuid() !== 0) {
  console.error('Sous macOS, la capture demande les droits administrateur (sudo).')
}

main()
