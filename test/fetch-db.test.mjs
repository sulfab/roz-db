import test from 'node:test'
import assert from 'node:assert/strict'
import { buildUrl, resterAFaire, masquerCle } from '../tools/fetch-db.mjs'

test('le gabarit doit dire ou mettre l identifiant', () => {
  assert.equal(buildUrl('https://x/api/Monster/{id}?k=1', 1002), 'https://x/api/Monster/1002?k=1')
  assert.throws(() => buildUrl('https://x/api/Monster', 1002), /\{id\}/)
})

test('reprendre ne redemande que ce qui manque', () => {
  const deja = [{ id: 1002 }, { id: 1034 }]
  assert.deepEqual(resterAFaire([1002, 1034, 1113], deja), [1113])
})

test('la cle d API n apparait jamais dans ce qu on affiche', () => {
  // Elle finirait sinon dans un log colle sur un forum, ou dans un depot.
  assert.equal(masquerCle('https://x/api/M/1?apiKey=secret'), 'https://x/api/M/1?apiKey=***')
  assert.equal(masquerCle('https://x/api/M/1?a=1&token=secret&b=2'), 'https://x/api/M/1?a=1&token=***&b=2')
  assert.equal(masquerCle('https://x/api/M/1'), 'https://x/api/M/1')
})

const ORACLE = { mobs: new Set([1002, 1034, 1280]), items: new Set([909, 501, 4001, 7563]) }
const OBSERVATIONS = {
  derniereCarte: 'prt_fild08',
  mobs: { 1002: {}, 1034: {}, 1280: {} },
  cartes: { prt_fild08: { especes: { 1002: 4, 1280: 2 } }, prontera: { especes: { 1034: 1 } } },
}

test('par defaut on ne demande que les especes de la carte ou l on est', async () => {
  // C'est ce qui fait tenir la chose dans un quota journalier : quelques
  // dizaines d'appels au lieu de plusieurs centaines.
  const { collecterIds } = await import('../tools/fetch-db.mjs')
  assert.deepEqual(collecterIds(undefined, ORACLE, { observations: OBSERVATIONS }), [1002, 1280])
})

test('on peut elargir a tout ce qu on a croise, ou a tout le client', async () => {
  const { collecterIds } = await import('../tools/fetch-db.mjs')
  assert.deepEqual(collecterIds('vus', ORACLE, { observations: OBSERVATIONS }), [1002, 1034, 1280])
  assert.deepEqual(collecterIds('mobs', ORACLE), [1002, 1034, 1280])
  assert.deepEqual(collecterIds('objets', ORACLE), [501, 909, 4001, 7563])
})

test('sans rien d observe, la liste est vide plutot que fausse', async () => {
  const { collecterIds } = await import('../tools/fetch-db.mjs')
  assert.deepEqual(collecterIds('carte', ORACLE, { observations: null }), [])
})

test('depuis une table de drop, on ne demande que les objets qui y figurent', async () => {
  const { collecterIds } = await import('../tools/fetch-db.mjs')
  const drops = { mobs: { 1002: [{ item: 909, chance: 70 }, { item: 501, chance: 8 }] } }
  assert.deepEqual(
    collecterIds('drops.json', ORACLE, { type: 'objets', lire: () => drops }),
    [501, 909],
  )
})

test('un identifiant inconnu du client n est pas demande', async () => {
  const { collecterIds } = await import('../tools/fetch-db.mjs')
  assert.deepEqual(
    collecterIds('x.json', ORACLE, { type: 'objets', lire: () => ({ a: [909, 99999] }) }),
    [909],
  )
})
