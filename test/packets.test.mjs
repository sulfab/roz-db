import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LONGUEURS, VARIABLES, frameStream, framePackets, inferLength,
  readEntries, inferClassOffset, inferItemPackets, trailingName,
  readNameReplies, readMapChanges, inferEncyclopedia, inferGroundItems,
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
  // Ce qui compte, c'est que les douze vrais paquets ressortent entiers. Que
  // les trois octets de tete soient lus comme un paquet de plus ou laisses de
  // cote est indecidable, et sans consequence.
  const vrais = r.packets.filter((p) => p.opcode === known[0] && p.length === known[1])
  assert.equal(vrais.length, 12)
  assert.equal(r.covered >= propre.length, true)
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

test('un passage indechiffrable ne coute pas le reste du flux', () => {
  const known = [...LONGUEURS.entries()][0]
  const paquet = () => build([{ opcode: known[0], body: Buffer.alloc(known[1] - 2) }])
  const bruit = Buffer.alloc(40)
  for (let i = 0; i < bruit.length; i++) bruit[i] = 0xf0 | (i % 16)
  const flux = Buffer.concat([
    ...Array.from({ length: 8 }, paquet), bruit, ...Array.from({ length: 8 }, paquet),
  ])
  const r = frameStream(flux)
  assert.equal(r.packets.length, 16)
  assert.equal(r.gaps.length, 1)
  assert.equal(r.skipped, bruit.length)
})

test('les octets sautes ne sont pas comptes comme lus', () => {
  const known = [...LONGUEURS.entries()][0]
  const paquet = () => build([{ opcode: known[0], body: Buffer.alloc(known[1] - 2) }])
  const bruit = Buffer.alloc(40, 0xff)
  const flux = Buffer.concat([
    ...Array.from({ length: 8 }, paquet), bruit, ...Array.from({ length: 8 }, paquet),
  ])
  const r = frameStream(flux)
  assert.equal(r.covered, 16 * known[1])
  assert.ok(r.coverage < 1)
})

test('les reponses de nom se reconnaissent a leur repetition', () => {
  const reponse = (id, nom) => {
    const body = Buffer.alloc(28)
    body.writeUInt32LE(id, 0)
    body.write(nom, 4, 'latin1')
    return { opcode: 0x0095, body }
  }
  const flux = build([reponse(527, 'Steam Goblin'), reponse(585, 'Poporing')])
  const { packets } = framePackets(flux, 0, new Map([[0x0095, 30]]))
  const replies = readNameReplies(packets)
  assert.deepEqual(replies.map((r) => [r.id, r.name]), [[527, 'Steam Goblin'], [585, 'Poporing']])
})

test('un paquet isole contenant du texte ne passe pas pour un nom', () => {
  const body = Buffer.alloc(28)
  body.writeUInt32LE(527, 0)
  body.write('Steam Goblin', 4, 'latin1')
  const { packets } = framePackets(build([{ opcode: 0x0095, body }]), 0, new Map([[0x0095, 30]]))
  assert.deepEqual(readNameReplies(packets), [])
})

test('le nom de carte est reconnu grace a la liste du client', () => {
  const body = Buffer.alloc(22)
  body.write('prt_fild08.gat', 0, 'latin1')
  const { packets } = framePackets(build([{ opcode: 0x0091, body }]), 0, new Map([[0x0091, 24]]))
  const changes = readMapChanges(packets, new Set(['prt_fild08', 'prontera']))
  assert.deepEqual(changes.map((c) => c.map), ['prt_fild08'])
})

test('une carte inconnue du client n est pas inventee', () => {
  const body = Buffer.alloc(22)
  body.write('nawak.gat', 0, 'latin1')
  const { packets } = framePackets(build([{ opcode: 0x0091, body }]), 0, new Map([[0x0091, 24]]))
  assert.deepEqual(readMapChanges(packets, new Set(['prontera'])), [])
})

test('un identifiant lisible par accident ne passe pas pour un nom', () => {
  // 0x...6669 se lit "if" : c'est exactement ce que produisait la version qui
  // gardait la premiere position livrant du texte. Ici le vrai nom est plus
  // loin, et c'est lui qui doit ressortir.
  const reponse = (aid, gid, nom) => {
    const body = Buffer.alloc(32)
    body.writeUInt32LE(aid, 0)
    body.writeUInt32LE(gid, 4)
    body.write(nom, 8, 'latin1')
    return { opcode: 0x0adf, body }
  }
  const flux = build([
    reponse(5001, 0x00006669, 'Megalodon'),
    reponse(5002, 0x00000001, 'Steam Goblin'),
    reponse(5003, 0x00006d58, 'Poring'),
  ])
  const { packets } = framePackets(flux, 0, new Map([[0x0adf, 34]]))
  const replies = readNameReplies(packets)
  assert.deepEqual(replies.map((r) => r.name), ['Megalodon', 'Steam Goblin', 'Poring'])
  assert.deepEqual([...new Set(replies.map((r) => r.offset))], [8])
})

test('un champ de nom doit etre complete par des zeros', () => {
  // Du texte suivi d'autre chose n'est pas un champ de nom : c'est du hasard.
  const body = Buffer.alloc(32, 0x41)
  body.writeUInt32LE(5001, 0)
  const flux = build([{ opcode: 0x0adf, body }, { opcode: 0x0adf, body }])
  const { packets } = framePackets(flux, 0, new Map([[0x0adf, 34]]))
  assert.deepEqual(readNameReplies(packets), [])
})

test('un paquet de degats ne passe pas pour un objet au sol', () => {
  // Les degats partagent leurs identifiants avec les disparitions — ce sont les
  // memes creatures — et leur champ suivant peut tomber sur un objet valide.
  // Ce qui les trahit : ces identifiants sont ceux d'entites apparues.
  const oracle = new Set([546, 908, 959])
  const degat = (source, valeur) => {
    const body = Buffer.alloc(30)
    body.writeUInt32LE(source, 0)
    body.writeUInt16LE(valeur, 4)
    return { opcode: 0x08c8, body }
  }
  const dispar = (id) => {
    const body = Buffer.alloc(5)
    body.writeUInt32LE(id, 0)
    return { opcode: 0x0080, body }
  }
  const flux = build([
    degat(3001, 546), degat(3002, 908), degat(3001, 959),
    dispar(3001), dispar(3002),
  ])
  const { packets } = framePackets(flux, 0, new Map([[0x08c8, 32], [0x0080, 7]]))
  assert.ok(inferGroundItems(packets, oracle).length, 'sans oracle d entites, rien ne les separe')
  assert.deepEqual(inferGroundItems(packets, oracle, { entityIds: new Set([3001, 3002]) }), [])
})

test('un objet au sol survit au meme filtre', () => {
  const oracle = new Set([908, 959])
  const chute = (sol, objet) => {
    const body = Buffer.alloc(13)
    body.writeUInt32LE(sol, 0)
    body.writeUInt32LE(objet, 4)
    return { opcode: 0x009d, body }
  }
  const ramasse = (sol) => {
    const body = Buffer.alloc(4)
    body.writeUInt32LE(sol, 0)
    return { opcode: 0x00a1, body }
  }
  const flux = build([
    chute(40595, 908), chute(41774, 959), chute(43140, 908),
    ramasse(40595), ramasse(41774),
  ])
  const { packets } = framePackets(flux, 0, new Map([[0x009d, 15], [0x00a1, 6]]))
  const found = inferGroundItems(packets, oracle, { entityIds: new Set([3001, 3002]) })
  assert.equal(found.length, 1)
  assert.equal(found[0].opcode, 0x009d)
  assert.equal(found[0].offset, 4)
})

test('une fiche d encyclopedie se reconnait a sa forme', () => {
  // Monstre, puis des objets a pas constant, chacun suivi de son taux.
  const oracle = { mobs: new Set([1002]), items: new Set([909, 501, 4001, 1202]) }
  const body = Buffer.alloc(40)
  body.writeUInt16LE(1002, 0)
  const drops = [[909, 7000], [501, 1000], [4001, 1], [1202, 500]]
  drops.forEach(([item, taux], i) => {
    body.writeUInt16LE(item, 2 + i * 4)
    body.writeUInt16LE(taux, 4 + i * 4)
  })
  const { packets } = framePackets(build([{ opcode: 0x0b6a, body }]), 0, new Map([[0x0b6a, 42]]))
  const fiches = inferEncyclopedia(packets, oracle)
  assert.ok(fiches.length, 'aucune fiche reconnue')
  const fiche = fiches.find((f) => f.lignes.length === 4)
  assert.ok(fiche, 'les quatre lignes doivent ressortir')
  assert.equal(fiche.mob, 1002)
  assert.deepEqual(fiche.lignes.map((l) => l.item), [909, 501, 4001, 1202])
  assert.deepEqual(fiche.taux.valeurs, [7000, 1000, 1, 500])
})

test('sans oracle, aucune fiche n est inventee', () => {
  const body = Buffer.alloc(40, 7)
  const { packets } = framePackets(build([{ opcode: 0x0b6a, body }]), 0, new Map([[0x0b6a, 42]]))
  assert.deepEqual(inferEncyclopedia(packets, { items: new Set(), mobs: new Set() }), [])
})
