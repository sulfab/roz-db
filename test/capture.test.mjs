import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { readCapture, reassemble, loadFlows, looksTls } from '../tools/pcap.mjs'
import { findDropTables, guessScale, minimumRun, oracleDensity } from '../tools/analyze-capture.mjs'

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

test('un oracle dense ne fabrique plus de tables a partir de bruit', () => {
  // Le cas reel : 9646 items occupent 15 % des valeurs 16 bits. Avec un seuil
  // fixe a 3 entrees, quelques kilo-octets de trafic quelconque produisaient
  // 85 "tables" — toutes fausses.
  const items = new Set(Array.from({ length: 9646 }, (_, i) => 500 + i))
  const mobs = new Set(Array.from({ length: 585 }, (_, i) => 1000 + i))

  const noise = Buffer.alloc(3000)
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) % 256

  const tables = findDropTables(noise, { items, mobs })
  assert.equal(tables.length, 0, JSON.stringify(tables.slice(0, 3), null, 2))
})

test('le seuil suit la densite de l oracle', () => {
  const dense = new Set(Array.from({ length: 9646 }, (_, i) => 500 + i))
  const sparse = new Set([909, 501, 4001])

  // Sur 16 bits un oracle dense exige beaucoup d'entrees consecutives.
  assert.ok(minimumRun(3000, oracleDensity(dense, 2)) >= 7)
  // Sur 32 bits l'espace est si grand que trois entrees suffisent.
  assert.equal(minimumRun(3000, oracleDensity(dense, 4)), 3)
  assert.equal(minimumRun(3000, oracleDensity(sparse, 4)), 3)
})

test('en ligne de commande, le seuil calcule est bien celui applique', () => {
  // Le calcul existait, mais la valeur par defaut de --min-run l'ecrasait : la
  // commande retombait sur trois entrees et annoncait des dizaines de tables
  // sur du trafic quelconque.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-'))

  const items = {}
  for (let i = 0; i < 9646; i++) items[500 + i] = { id: 500 + i, name: `objet ${i}` }
  const mobs = {}
  for (let i = 0; i < 585; i++) mobs[1000 + i] = { id: 1000 + i, name: `mob ${i}` }
  fs.writeFileSync(path.join(dataDir, 'items.json'), JSON.stringify(items))
  fs.writeFileSync(path.join(dataDir, 'mobs.json'), JSON.stringify(mobs))

  const r = spawnSync(process.execPath, [
    path.join(root, 'tools', 'analyze-capture.mjs'), CAPTURE,
    '--data', dataDir, '--out', path.join(dataDir, 'drops.csv'),
  ], { encoding: 'utf8' })

  // La capture contient deux vraies tables, sur 32 bits : elles doivent
  // ressortir. Ce qui ne doit plus arriver, c'est la nuee de fausses tables
  // 16 bits que produisait le seuil fige a trois.
  const output = (r.stdout || '') + (r.stderr || '')
  const count = Number(/(\d+) table\(s\) candidate\(s\)/.exec(output)?.[1] ?? -1)
  assert.equal(count, 2, output)
  assert.match(output, /Seuil retenu : (?:[3-9]|\d\d)/, output)
})

test('une table Lua qui rattache un monstre a des objets est reconnue', async () => {
  const { huntLuaTables } = await import('../tools/hunt-drops.mjs')
  const oracle = { mobs: new Set([1002, 1280]), items: new Set([909, 501, 4001, 1202]) }
  // La forme compte, pas le nom : une cle qui est un monstre, une valeur qui
  // contient plusieurs objets.
  const table = { Drops: { 1002: [{ id: 909 }, { id: 501 }, { id: 4001 }] } }
  const hits = huntLuaTables(table, oracle)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].mob, 1002)
  assert.deepEqual(hits[0].objets.sort((a, b) => a - b), [501, 909, 4001])
})

test('un monstre avec un seul objet ne fait pas une table de drop', async () => {
  const { huntLuaTables } = await import('../tools/hunt-drops.mjs')
  const oracle = { mobs: new Set([1002]), items: new Set([909]) }
  assert.deepEqual(huntLuaTables({ 1002: [909] }, oracle), [])
})

test('une ligne de texte type mob_db est reconnue', async () => {
  const { huntTextLines } = await import('../tools/hunt-drops.mjs')
  const oracle = { mobs: new Set([1002]), items: new Set([909, 501, 4001]) }
  const hits = huntTextLines('1002,PORING,Poring,1,50,0,909,7000,501,800,4001,20\n', oracle)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].mob, 1002)
  assert.deepEqual(hits[0].objets.sort((a, b) => a - b), [501, 909, 4001])
})

test('une ligne sans monstre connu n est pas retenue', async () => {
  const { huntTextLines } = await import('../tools/hunt-drops.mjs')
  const oracle = { mobs: new Set([1002]), items: new Set([909, 501, 4001]) }
  assert.deepEqual(huntTextLines('9999,X,Y,1,50,0,909,7000,501,800,4001,20\n', oracle), [])
})

test('une suite croissante a petits pas n est pas une table de drop', async () => {
  const { looksLikeCounter } = await import('../tools/analyze-capture.mjs')
  // Ce que les fichiers de geometrie contiennent a foison : des compteurs.
  assert.equal(looksLikeCounter([4001, 4002, 4003, 4004, 4005, 4007, 4008, 4010]), true)
  assert.equal(looksLikeCounter([7001, 7002, 7003, 7005, 7007, 7009, 7011, 7013]), true)
})

test('des objets pris un peu partout restent une table possible', async () => {
  const { looksLikeCounter } = await import('../tools/analyze-capture.mjs')
  assert.equal(looksLikeCounter([909, 501, 4001, 1202]), false)
  // Meme triee, une vraie table garde de grands ecarts.
  assert.equal(looksLikeCounter([501, 909, 1202, 4001, 7563]), false)
})
