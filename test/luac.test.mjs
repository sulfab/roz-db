import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCompiled, toPlain, undump, LuaError } from '../tools/luac.mjs'
import { decode } from '../tools/encoding.mjs'

/**
 * Les fixtures sont du bytecode produit par le vrai luac 5.1 (leurs sources
 * .lua sont a cote). Tester contre un bytecode que j'aurais assemble moi-meme
 * ne prouverait rien : l'erreur serait des deux cotes.
 */
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

function load(name) {
  const buf = fs.readFileSync(path.join(FIXTURES, name))
  const { env, error } = runCompiled(buf)
  assert.equal(error, null, `execution interrompue : ${error}`)
  return toPlain(env, (s) => decode(Buffer.from(s, 'latin1'), 'auto'))
}

test('tables indexees, chaines, concatenation', () => {
  for (const name of ['simple.lub', 'simple.debug.lub']) {
    const g = load(name)
    assert.equal(g.tbl['501'].name, 'Red Potion', name)
    assert.equal(g.tbl['501'].slots, 0)
    assert.deepEqual(g.tbl['501'].desc, { 1: 'Une potion.', 2: 'Rend 45 PV.' })
    assert.equal(g.tbl['1202'].name, 'Knife [3]') // concatenation evaluee
    assert.equal(g.tbl['1202'].slots, 3)
  }
})

test('constantes croisees entre tables', () => {
  const g = load('constants.lub')
  assert.equal(g.jobtbl.JT_PORING, 1002)
  assert.equal(g.JobNameTable['1002'], 'PORING')
  assert.equal(g.JobNameTable['1063'], 'LUNATIC')
  assert.equal(g.JobNameTable['1031'], 'POPORING')
})

test('boucles, fonctions et bibliotheque standard', () => {
  const g = load('loops.lub')
  // 3 cartes x 2 mobs, construits par table.insert dans une double boucle
  assert.equal(Object.keys(g.rows).length, 6)
  assert.deepEqual(g.rows['1'], { 1: 'prt_fild08', 2: 1001, 3: 'Mob 1', 4: 3, 5: 11 })
  assert.deepEqual(g.rows['6'], { 1: 'gef_fild00', 2: 1002, 3: 'Mob 2', 4: 6, 5: 32 })
  assert.equal(g.biggest, 42) // appel de fonction avec branchement
  assert.deepEqual(g.counts, { prt_fild08: 2, pay_fild04: 2, gef_fild00: 2 }) // ipairs
})

test('tableaux longs : plusieurs SETLIST', () => {
  const g = load('bigarray.lub')
  assert.equal(Object.keys(g.list).length, 137)
  assert.equal(g.list['1'], 'e1')
  assert.equal(g.list['50'], 'e50')   // frontiere du premier lot
  assert.equal(g.list['51'], 'e51')
  assert.equal(g.list['137'], 'e137')
})

test('parties tableau et hachage melangees, nombres', () => {
  const g = load('bigarray.lub')
  assert.equal(g.mixed['1'], 1)
  assert.equal(g.mixed['4'], -4.5)
  assert.equal(g.mixed['5'], 'fin')
  assert.equal(g.mixed.nomme, 'oui')
  assert.equal(g.mixed['100'], 'cent')
  assert.deepEqual(g.nombres, { entier: 42, negatif: -17, flottant: 0.125, grand: 1000000 })
})

test('chaines accentuees : les octets sont preserves puis decodes', () => {
  const g = load('accents.lub')
  assert.equal(g.textes.fr, 'Épée légendaire')
  assert.equal(g.textes.desc, 'Rend ^0000FF45^000000 PV.')
})

test('un chunk tronque laisse les globales deja construites', () => {
  const buf = fs.readFileSync(path.join(FIXTURES, 'simple.lub'))
  assert.throws(() => undump(buf.subarray(0, 40)), LuaError)
})

test('refus explicite des bytecodes non Lua 5.1', () => {
  const fake = Buffer.from([0x1b, 0x4c, 0x75, 0x61, 0x52, 0, 1, 4, 4, 4, 8, 0])
  assert.throws(() => undump(fake), /Lua 5\.1/)
})

test('ce n est pas un chunk compile', () => {
  assert.throws(() => undump(Buffer.from('tbl = {}', 'utf8')), /pas un chunk Lua compile/)
})

test('table declaree en local : retrouvee parmi les tables construites', async () => {
  const { loadLua } = await import('../tools/luadata.mjs')
  const buf = fs.readFileSync(path.join(FIXTURES, 'iteminfo_local.lub'))
  const { env, tables } = loadLua(buf, { includeTables: true })

  // Rien dans les globales : c'est tout le probleme que ce repli resout.
  assert.equal(env.tbl, undefined)

  const itemTable = tables.find((t) => t && t['501'] && t['501'].identifiedDisplayName)
  assert.ok(itemTable, 'table d items introuvable parmi les tables construites')
  assert.equal(itemTable['501'].identifiedDisplayName, 'Red Potion')
  assert.equal(itemTable['1202'].slotCount, 3)
  assert.equal(itemTable['2104'].identifiedResourceName, 'guard')
})
