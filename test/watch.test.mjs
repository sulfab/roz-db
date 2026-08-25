import test from 'node:test'
import assert from 'node:assert/strict'
import { observeStream, mergeObservation, summarize } from '../tools/watch.mjs'
import { LONGUEURS, OPCODE_VANISH } from '../tools/packets.mjs'

/**
 * Un flux fabrique de toutes pieces, mais aux formes reelles : apparitions a
 * longueur variable avec la classe au meme endroit que dans le trafic observe,
 * disparitions, reponses de nom, objets au sol.
 */
const CLASSE_AT = 19          // decalage constate sur du trafic reel
const OPCODE_ENTRY = 0x09fd
const OPCODE_NOM = 0x0095
const OPCODE_DROP = 0x084b
const LONGUEUR_NOM = 30
const LONGUEUR_DROP = 20

function entree({ aid, classe, type = 5 }) {
  const body = Buffer.alloc(80)
  body[0] = type
  body.writeUInt32LE(aid, 1)
  body.writeUInt16LE(classe, CLASSE_AT)
  const head = Buffer.alloc(4)
  head.writeUInt16LE(OPCODE_ENTRY, 0)
  head.writeUInt16LE(4 + body.length, 2)
  return Buffer.concat([head, body])
}

function fixe(opcode, longueur, remplir) {
  const buf = Buffer.alloc(longueur)
  buf.writeUInt16LE(opcode, 0)
  remplir(buf.subarray(2))
  return buf
}

const disparition = (aid) => fixe(OPCODE_VANISH, LONGUEURS.get(OPCODE_VANISH), (b) => {
  b.writeUInt32LE(aid, 0)
  b[4] = 1
})

const nom = (aid, texte) => fixe(OPCODE_NOM, LONGUEUR_NOM, (b) => {
  b.writeUInt32LE(aid, 0)
  b.write(texte, 4, 'latin1')
})

/**
 * Objet pose au sol : identifiant propre, puis l'objet.
 *
 * Le ramassage renvoie le meme identifiant : c'est ce va-et-vient qui prouve
 * qu'on a affaire a un objet au sol, et non a un champ contenant par hasard un
 * nombre valide. Un jeu de test sans ramassage ne testerait donc rien.
 */
const OPCODE_RAMASSE = 0x00a1
const chute = (sol, objet) => fixe(OPCODE_DROP, LONGUEUR_DROP, (b) => {
  b.writeUInt32LE(sol, 0)
  b.writeUInt16LE(objet, 6)
})
const ramasse = (sol) => fixe(OPCODE_RAMASSE, 6, (b) => b.writeUInt32LE(sol, 0))

const carte = (nomCarte) => fixe(0x0091, 24, (b) => b.write(`${nomCarte}.gat`, 0, 'latin1'))

/** Oracle : des identifiants espaces, comme ceux d'un vrai client. */
const ORACLE = {
  items: new Set([501, 909, 1202, 4001, 7563, 12103]),
  mobs: new Set([1002, 1034, 1280]),
  mobNames: new Map([[1002, 'Poring'], [1034, 'Thief Bug Egg'], [1280, 'Steam Goblin']]),
  maps: new Set(['prt_fild08', 'prontera']),
}

test('un morceau de capture livre carte, especes et morts', () => {
  const flux = Buffer.concat([
    carte('prt_fild08'),
    entree({ aid: 5001, classe: 1002 }),
    entree({ aid: 5002, classe: 1002 }),
    entree({ aid: 5003, classe: 1280 }),
    disparition(5001),
  ])
  const obs = observeStream(flux, ORACLE)
  assert.equal(obs.carte, 'prt_fild08')
  assert.equal(obs.especes.get(1002), 2)
  assert.equal(obs.especes.get(1280), 1)
  assert.equal(obs.morts.get(1002), 1)
})

test('le nom envoye par le serveur est rattache a l espece', () => {
  const flux = Buffer.concat([
    entree({ aid: 5001, classe: 1280 }),
    entree({ aid: 5002, classe: 1002 }),
    nom(5001, 'Gobelin a vapeur'),
    nom(5002, 'Poring'),
  ])
  const obs = observeStream(flux, ORACLE)
  assert.equal(obs.noms.get(1280), 'Gobelin a vapeur')
})

test('les pseudonymes des joueurs ne rentrent pas dans la base', () => {
  const flux = Buffer.concat([
    entree({ aid: 7001, classe: 4, type: 0 }),
    entree({ aid: 5001, classe: 1280 }),
    nom(7001, 'Inari'),
    nom(5001, 'Gobelin a vapeur'),
  ])
  const obs = observeStream(flux, ORACLE)
  assert.deepEqual([...obs.noms.values()], ['Gobelin a vapeur'])
})

test('un objet tombe juste apres une mort est rattache a l espece', () => {
  const flux = Buffer.concat([
    entree({ aid: 5001, classe: 1280 }),
    disparition(5001),
    chute(9001, 909), chute(9002, 501), chute(9003, 4001),
    ramasse(9001), ramasse(9002), ramasse(9003),
  ])
  const obs = observeStream(flux, ORACLE)
  assert.deepEqual([...obs.drops.get(1280).keys()].sort((a, b) => a - b), [501, 909, 4001])
})

test('un objet tombe avant toute mort n est rattache a personne', () => {
  const flux = Buffer.concat([
    chute(9001, 909), chute(9002, 501), chute(9003, 4001),
    ramasse(9001), ramasse(9002), ramasse(9003),
    entree({ aid: 5001, classe: 1280 }),
  ])
  assert.equal(observeStream(flux, ORACLE).drops.size, 0)
})

test('le cumul additionne les morceaux au lieu de les remplacer', () => {
  const morceau = Buffer.concat([
    carte('prt_fild08'),
    entree({ aid: 5001, classe: 1280 }),
    disparition(5001),
    chute(9001, 909), chute(9002, 501), chute(9003, 4001),
    ramasse(9001), ramasse(9002), ramasse(9003),
  ])
  const state = { version: 1, octets: 0, morceaux: 0, cartes: {}, mobs: {}, pistes: {}, objets: {} }
  mergeObservation(state, observeStream(morceau, ORACLE), ORACLE)
  mergeObservation(state, observeStream(morceau, ORACLE), ORACLE)

  const vue = summarize(state)
  assert.equal(vue.morceaux, 2)
  const gobelin = vue.mobs.find((m) => m.id === 1280)
  assert.equal(gobelin.vues, 2)
  assert.equal(gobelin.morts, 2)
  assert.equal(gobelin.drops.find((d) => d.objet === 909).fois, 2)
})

test('un taux observe n est donne qu avec le nombre de morts derriere lui', () => {
  const state = {
    version: 1, octets: 0, morceaux: 1, cartes: {}, pistes: {}, objets: {},
    mobs: { 1280: { nom: 'Steam Goblin', nomServeur: null, vues: 3, morts: 4, drops: { 909: 1 } } },
  }
  const gobelin = summarize(state).mobs[0]
  assert.equal(gobelin.morts, 4)
  assert.equal(gobelin.drops[0].taux, 0.25)
})

test('sans mort observee, aucun taux n est annonce', () => {
  const state = {
    version: 1, octets: 0, morceaux: 1, cartes: {}, pistes: {}, objets: {},
    mobs: { 1280: { nom: 'Steam Goblin', nomServeur: null, vues: 3, morts: 0, drops: { 909: 1 } } },
  }
  assert.equal(summarize(state).mobs[0].drops[0].taux, null)
})

test('le nom du serveur passe devant celui du client', () => {
  const state = {
    version: 1, octets: 0, morceaux: 1, cartes: {}, pistes: {}, objets: {},
    mobs: { 1280: { nom: 'Steam Goblin', nomServeur: 'Gobelin a vapeur', vues: 1, morts: 0, drops: {} } },
  }
  const vu = summarize(state).mobs[0]
  assert.equal(vu.nom, 'Gobelin a vapeur')
  assert.equal(vu.nomClient, 'Steam Goblin')
})
