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
