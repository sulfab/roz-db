import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { readCapture, reassemble, loadFlows, looksTls } from '../tools/pcap.mjs'
import { findDropTables, guessScale } from '../tools/analyze-capture.mjs'

/**
 * capture.pcap est un vrai fichier ecrit par tcpdump (voir
 * test/make-capture-fixture.mjs). Tester le lecteur contre un pcap que
 * j'aurais ecrit moi-meme ne prouverait rien.
 */
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const CAPTURE = path.join(FIXTURES, 'capture.pcap')

test('lecture d une capture ecrite par tcpdump', () => {
  const capture = readCapture(CAPTURE)
  assert.equal(capture.linkType, 1) // Ethernet
  assert.ok(capture.packets.length >= 10, `${capture.packets.length} paquets`)
  assert.ok(capture.packets[0].time > 1_600_000_000, 'horodatage absurde')
})

test('reassemblage : sens du flux et octets dans l ordre', () => {
  const flows = reassemble(readCapture(CAPTURE))
  assert.ok(flows.length >= 2, 'les deux sens devraient apparaitre')

  const serverToClient = flows.find((f) => f.sport === 15121)
  const clientToServer = flows.find((f) => f.dport === 15121)

  assert.ok(serverToClient, 'flux serveur -> client absent')
  assert.equal(serverToClient.isServerToClient, true)
  assert.equal(clientToServer.isServerToClient, false)
  assert.equal(serverToClient.gaps, 0)
  assert.equal(clientToServer.data.toString(), 'bonjour serveur')
  assert.ok(serverToClient.bytes > 100)
  assert.equal(looksTls(serverToClient.data), false)
})

test('les tables de drop sont retrouvees sans connaitre le format du paquet', () => {
  const flow = loadFlows(CAPTURE).find((f) => f.sport === 15121)
  const oracle = {
    items: new Set([909, 501, 4001, 1202, 2104]),
    mobs: new Set([1002, 1063, 1031]),
  }

  const tables = findDropTables(flow.data, oracle)
  // Exactement deux : le dedoublonnage evite de compter deux fois la meme
  // table lue en 16 puis en 32 bits.
  assert.equal(tables.length, 2, JSON.stringify(tables.map((t) => t.mobId)))

  const poring = tables.find((t) => t.mobId === 1002)
  assert.ok(poring, 'table du mob 1002 introuvable')
  assert.equal(poring.count, 3)
  assert.equal(poring.stride, 8)      // deduit, pas suppose
  assert.equal(poring.itemWidth, 4)
  assert.equal(poring.rateOffset, 4)
  assert.equal(poring.rateWidth, 4)
  assert.deepEqual(poring.entries, [
    { item: 909, rate: 7000 },
    { item: 501, rate: 150 },
    { item: 4001, rate: 10 },
  ])

  const lunatic = tables.find((t) => t.mobId === 1063)
  assert.ok(lunatic, 'table du mob 1063 introuvable')
  assert.deepEqual(lunatic.entries.map((e) => e.item), [909, 501, 1202])
  assert.deepEqual(lunatic.entries.map((e) => e.rate), [4500, 300, 25])

  assert.deepEqual(guessScale(poring.entries), {
    base: 10_000,
    note: '1/10000, echelle serveur habituelle',
  })
})

test('un oracle vide ne fabrique pas de fausses tables', () => {
  const flow = loadFlows(CAPTURE).find((f) => f.sport === 15121)
  const tables = findDropTables(flow.data, { items: new Set(), mobs: new Set() })
  assert.deepEqual(tables, [])
})

test('du bruit seul ne produit rien', () => {
  const noise = Buffer.alloc(4096)
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 37) % 256
  const oracle = { items: new Set([909, 501, 4001]), mobs: new Set([1002]) }
  const tables = findDropTables(noise, oracle, { minRun: 3 })
  // Aucune table credible : pas d'item a intervalle regulier avec un mob devant.
  assert.equal(tables.filter((t) => t.mobId !== null).length, 0)
})

test('trafic TLS reconnu comme illisible', () => {
  const handshake = Buffer.concat([Buffer.from([0x16, 0x03, 0x01, 0x02, 0x00]), Buffer.alloc(512)])
  assert.equal(looksTls(handshake), true)
  assert.equal(looksTls(Buffer.from('du texte en clair')), false)
})

test('capture illisible : erreur explicite', () => {
  const bad = path.join(FIXTURES, 'pas-une-capture.bin')
  fs.writeFileSync(bad, Buffer.from('ceci n est pas un pcap'))
  assert.throws(() => readCapture(bad), /format de capture inconnu/)
  fs.unlinkSync(bad)
})

test('les outils en ligne de commande demarrent vraiment', () => {
  // Le garde d'entree comparait une URL file:// a un chemin brut. Sous Windows,
  // process.argv[1] vaut C:\chemin\outil.mjs, jamais egal a file:///C:/chemin/... :
  // main() n'etait donc jamais appele et la commande ne produisait rien.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  for (const tool of ['analyze-capture.mjs', 'icons.mjs']) {
    const r = spawnSync(process.execPath, [path.join(root, 'tools', tool), '--help'], {
      encoding: 'utf8',
    })
    const output = (r.stdout || '') + (r.stderr || '')
    assert.ok(output.trim().length > 0, `${tool} n'a rien affiche`)
  }
})
