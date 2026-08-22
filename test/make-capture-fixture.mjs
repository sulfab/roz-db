/**
 * Fabrique test/fixtures/capture.pcap avec un vrai tcpdump.
 *
 * Le lecteur pcap doit etre teste contre un fichier ecrit par libpcap, pas par
 * moi : sinon une erreur de comprehension du format serait des deux cotes et le
 * test passerait quand meme. Le fichier produit est commite ; ce script ne sert
 * qu'a le regenerer (il demande tcpdump et les droits root).
 *
 *   node test/make-capture-fixture.mjs
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const PORT = 15121
const OUT = path.join(FIXTURES, 'capture.pcap')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Charge utile inspiree d'une table de drop : un identifiant de mob, un nombre
 * d'entrees, puis des enregistrements de taille fixe (item, taux).
 */
function dropPacket(mobId, entries) {
  const body = Buffer.alloc(8 + entries.length * 8)
  body.writeUInt32LE(mobId, 0)
  body.writeUInt16LE(entries.length, 4)
  body.writeUInt16LE(0, 6)
  entries.forEach(([item, rate], i) => {
    body.writeUInt32LE(item, 8 + i * 8)
    body.writeUInt32LE(rate, 12 + i * 8)
  })
  const header = Buffer.alloc(4)
  header.writeUInt16LE(0x0af0, 0)
  header.writeUInt16LE(body.length + 4, 2)
  return Buffer.concat([header, body])
}

/** Du trafic quelconque autour, pour que l'analyseur ait a faire le tri. */
function noise(size, seed) {
  const buf = Buffer.alloc(size)
  for (let i = 0; i < size; i++) buf[i] = (seed * 31 + i * 17) % 251
  return buf
}

async function main() {
  fs.mkdirSync(FIXTURES, { recursive: true })
  if (fs.existsSync(OUT)) fs.unlinkSync(OUT)

  const tcpdump = spawn('tcpdump', ['-i', 'lo', '-w', OUT, '-U', `tcp port ${PORT}`], {
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  await delay(1500) // laisse tcpdump ouvrir l'interface

  const server = net.createServer((socket) => {
    socket.on('data', () => {})
    socket.write(noise(64, 3))
    socket.write(dropPacket(1002, [[909, 7000], [501, 150], [4001, 10]]))
    socket.write(noise(48, 7))
    socket.write(dropPacket(1063, [[909, 4500], [501, 300], [1202, 25]]))
    socket.write(noise(32, 11))
    setTimeout(() => socket.end(), 200)
  })

  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve))

  await new Promise((resolve, reject) => {
    const client = net.connect(PORT, '127.0.0.1', () => client.write(Buffer.from('bonjour serveur')))
    client.on('data', () => {})
    client.on('end', resolve)
    client.on('error', reject)
  })

  server.close()
  await delay(1000)
  tcpdump.kill('SIGINT')
  await delay(500)

  const size = fs.statSync(OUT).size
  console.log(`${OUT} : ${size} octets`)
  if (size < 100) {
    console.error('Capture vide : tcpdump a-t-il les droits necessaires ?')
    process.exit(1)
  }
}

main()
