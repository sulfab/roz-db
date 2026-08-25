import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LONGUEURS, VARIABLES, frameStream, framePackets, inferLength,
  readEntries, inferClassOffset, inferItemPackets, trailingName,
} from '../tools/packets.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// Extrait d'une capture reelle de Ragnarok Zero Global : c'est la seule preuve
// qui vaille que le protocole est en clair. Seuls les deux pseudonymes ont ete
// remplaces, caractere pour caractere, donc le decoupage est intact.
const STREAM = fs.readFileSync(path.join(HERE, 'fixtures', 'stream.bin'))

/** Construit un flux a partir de paquets decrits, pour tester sans deviner. */
function build(packets) {
  const parts = []
  for (const { opcode, body, variable } of packets) {
    const head = Buffer.alloc(variable ? 4 : 2)
    head.writeUInt16LE(opcode, 0)
    if (variable) head.writeUInt16LE(4 + body.length, 2)
    parts.push(head, body)
  }
  return Buffer.concat(parts)
}

test('le trafic reel du jeu se decoupe en paquets, donc il est en clair', () => {
  const r = frameStream(STREAM)
  // Un flux chiffre ne se decoupe pas : chaque numero de paquet tomberait au
  // hasard et la chaine casserait au bout de deux ou trois.
  assert.ok(r.packets.length > 40, `${r.packets.length} paquets seulement`)
  assert.ok(r.coverage > 0.8, `${(r.coverage * 100).toFixed(1)} % couverts`)
  assert.equal(r.start, 0)
})

test('presque toutes les longueurs viennent de la table, pas d une invention', () => {
  const r = frameStream(STREAM)
  const inventes = r.packets.filter((p) => r.learned.has(p.opcode)).length
  assert.ok(inventes <= 2, `${inventes} paquets decoupes a l aveugle`)
})

test('le nom du personnage tombe en queue des paquets d apparition', () => {
  // C'est la verification qui distingue un vrai decoupage d'une coincidence :
  // rien dans l'algorithme ne cherche de nom, et pourtant il y en a un, entier,
  // exactement a la fin de ces paquets-la.
  const entries = readEntries(frameStream(STREAM).packets)
  const noms = entries.filter((e) => e.kind === 'joueur').map((e) => trailingName(e.payload))
  assert.deepEqual([...new Set(noms)].sort(), ['Aaaaa', 'Bbbbb'])
})

test('les apparitions distinguent les monstres des joueurs', () => {
  const entries = readEntries(frameStream(STREAM).packets)
  assert.ok(entries.some((e) => e.kind === 'monstre'))
  assert.ok(entries.some((e) => e.kind === 'joueur'))
})

test('la position de la classe du monstre est deduite, pas supposee', () => {
  const entries = readEntries(frameStream(STREAM).packets)
  const found = inferClassOffset(entries, new Set([1034]))
  assert.ok(found, 'aucun decalage ne correspond a un monstre connu')
  assert.equal(entries.filter((e) => e.kind === 'monstre')
    .every((e) => e.payload.readUInt16LE(found.offset) === 1034), true)
})

test('sans oracle, on ne pretend pas connaitre la classe du monstre', () => {
  const entries = readEntries(frameStream(STREAM).packets)
  assert.equal(inferClassOffset(entries, new Set()), null)
  assert.equal(inferClassOffset([], new Set([1034])), null)
})

test('une longueur inconnue se deduit du flux qui la suit', () => {
  // 0x0333 n'est dans aucune table : sa longueur ne peut venir que du fait
  // qu'apres onze octets, on retombe sur des paquets connus.
  const known = [...LONGUEURS.entries()][0]
  const flux = Buffer.concat([
    build([{ opcode: 0x0333, body: Buffer.alloc(9) }]),
    ...Array.from({ length: 6 }, () => build([{ opcode: known[0], body: Buffer.alloc(known[1] - 2) }])),
  ])
  assert.equal(inferLength(flux, 0, new Map(LONGUEURS)), 11)
})

test('une longueur indecidable n est pas inventee', () => {
  // Deux octets, rien derriere : aucune longueur ne se distingue.
  assert.equal(inferLength(Buffer.from([0x33, 0x03]), 0, new Map(LONGUEURS)), null)
})

test('un flux chiffre ne se laisse pas decouper', () => {
  // Du bruit : les numeros de paquet tombent au hasard, la chaine casse vite.
  const bruit = Buffer.alloc(4096)
  for (let i = 0; i < bruit.length; i++) bruit[i] = (i * 167 + 91) % 256
  const r = frameStream(bruit)
  assert.ok(r.coverage < 0.5, `${(r.coverage * 100).toFixed(1)} % couverts sur du bruit`)
})

test('un flux pris en cours de route retrouve le bon alignement', () => {
  const known = [...LONGUEURS.entries()][0]
  const propre = Buffer.concat(
    Array.from({ length: 12 }, () => build([{ opcode: known[0], body: Buffer.alloc(known[1] - 2) }])),
  )
  const tronque = Buffer.concat([Buffer.from([0xaa, 0x00, 0xbb]), propre])
  const r = frameStream(tronque)
  assert.equal(r.start, 3)
  assert.equal(r.packets.length, 12)
})

test('le paquet a longueur variable est lu a sa longueur annoncee', () => {
  const opcode = [...VARIABLES][0]
  const flux = build([
    { opcode, body: Buffer.concat([Buffer.from([0]), Buffer.alloc(40)]), variable: true },
    { opcode, body: Buffer.concat([Buffer.from([5]), Buffer.alloc(50)]), variable: true },
  ])
  const { packets } = framePackets(flux, 0, new Map(LONGUEURS))
  assert.deepEqual(packets.map((p) => p.length), [45, 55])
})

test('trailingName ne retient que du texte entier', () => {
  assert.equal(trailingName(Buffer.concat([Buffer.from([0x01, 0x02]), Buffer.from('Nom', 'latin1')])), 'Nom')
  assert.equal(trailingName(Buffer.from([0x01, 0x02, 0x03])), null)
  assert.equal(trailingName(Buffer.from('ab', 'latin1')), null)
})

test('le paquet qui annonce un objet au sol se reconnait a son contenu', () => {
  const oracle = new Set([501, 909, 4001, 1202])
  const drops = [501, 909, 4001].map((id) => {
    const body = Buffer.alloc(16)
    body.writeUInt16LE(7777, 0)   // un identifiant d'entite, pas un objet
    body.writeUInt16LE(id, 6)
    return { opcode: 0x084b, body }
  })
  const flux = build(drops)
  const { packets } = framePackets(flux, 0, new Map([[0x084b, 18]]))
  const found = inferItemPackets(packets, oracle)
  assert.equal(found.length, 1)
  assert.equal(found[0].offset, 6)
  assert.equal(found[0].size, 2)
  assert.deepEqual(found[0].items.sort((a, b) => a - b), [501, 909, 4001])
})

test('un champ constant n est pas pris pour un objet', () => {
  const oracle = new Set([501])
  const flux = build(Array.from({ length: 5 }, () => {
    const body = Buffer.alloc(12)
    body.writeUInt16LE(501, 4)
    return { opcode: 0x084b, body }
  }))
  const { packets } = framePackets(flux, 0, new Map([[0x084b, 14]]))
  assert.deepEqual(inferItemPackets(packets, oracle), [])
})

test('un oracle dense ne fabrique pas de paquets d objets', () => {
  // 9646 identifiants d'affilee : "c'est un objet connu" ne veut plus rien dire
  // dans cette plage, et aucun champ ne doit ressortir sur cette seule base.
  const dense = new Set(Array.from({ length: 9646 }, (_, i) => 500 + i))
  const flux = build(Array.from({ length: 7 }, (_, i) => {
    const body = Buffer.alloc(20)
    for (let at = 0; at + 2 <= body.length; at += 2) body.writeUInt16LE(600 + i * 37 + at, at)
    return { opcode: 0x02e1, body }
  }))
  const { packets } = framePackets(flux, 0, new Map([[0x02e1, 22]]))
  assert.deepEqual(inferItemPackets(packets, dense), [])
})

test('la position de la classe est signalee comme fragile quand elle l est', () => {
  const entries = readEntries(frameStream(STREAM).packets)
  const large = new Set(Array.from({ length: 585 }, (_, i) => 1000 + i))
  const found = inferClassOffset(entries, large)
  // Une seule espece croisee : le hasard suffit a expliquer la correspondance.
  assert.ok(found.expectedByChance > 0.01, `${found.expectedByChance}`)
  assert.equal(found.solid, false)
})
