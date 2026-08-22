import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decryptBlock, unshuffleBlock, substitute, cycleFor, decryptEntry,
  initialPermutation, finalPermutation,
  FLAG_ENCRYPT_MIXED, FLAG_ENCRYPT_HEADER,
} from '../tools/des.mjs'

/**
 * Sans archive chiffree sous la main, on ne peut pas comparer a une sortie
 * attendue. On verifie donc ce qui est verifiable sans elle : les proprietes
 * mathematiques des transformations, et le choix des blocs traites.
 *
 * La validation reelle vient du fichier lui-meme : le contenu dechiffre est
 * decompresse juste apres, et zlib rejette bruyamment un dechiffrement faux.
 */

test('les permutations initiale et finale sont inverses l une de l autre', () => {
  // C'est la propriete qui valide les deux tables de 64 entrees : une erreur
  // sur l'une d'elles la casserait immediatement.
  for (let seed = 0; seed < 16; seed++) {
    const block = Uint8Array.from({ length: 8 }, (_, i) => (seed * 37 + i * 53) % 256)
    const before = Uint8Array.from(block)
    finalPermutation(initialPermutation(block))
    assert.deepEqual([...block], [...before], `graine ${seed}`)
  }
})

test('dechiffrer un bloc le change, et de facon deterministe', () => {
  const a = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])
  const b = Uint8Array.from(a)
  decryptBlock(a)
  decryptBlock(b)
  assert.deepEqual([...a], [...b])
  assert.notDeepEqual([...a], [1, 2, 3, 4, 5, 6, 7, 8])
})

test('la substitution du dernier octet est involutive', () => {
  for (const byte of [0x00, 0x2b, 0x6c, 0x80, 0x01, 0x68, 0x48, 0x77, 0x60, 0xff, 0xb9, 0xc0, 0xfe, 0xeb]) {
    assert.equal(substitute(substitute(byte)), byte, `octet 0x${byte.toString(16)}`)
  }
  assert.equal(substitute(0x42), 0x42) // hors table : inchange
})

test('le desembrouillage remet les octets dans l ordre attendu', () => {
  const block = Uint8Array.from([10, 11, 12, 13, 14, 15, 16, 0x00])
  unshuffleBlock(block)
  assert.deepEqual([...block], [13, 14, 16, 10, 11, 12, 15, 0x2b])
})

test('le cycle depend du nombre de chiffres de la taille compressee', () => {
  assert.equal(cycleFor(5), 1)          // 1 chiffre
  assert.equal(cycleFor(50), 1)         // 2 chiffres
  assert.equal(cycleFor(500), 4)        // 3 chiffres
  assert.equal(cycleFor(5000), 5)       // 4
  assert.equal(cycleFor(50_000), 14)    // 5
  assert.equal(cycleFor(500_000), 15)   // 6
  assert.equal(cycleFor(5_000_000), 22) // 7
})

test('en-tete seul : au-dela de vingt blocs, rien n est touche', () => {
  const data = Buffer.alloc(8 * 40)
  for (let i = 0; i < data.length; i++) data[i] = (i * 7) % 256
  const original = Buffer.from(data)

  decryptEntry(data, FLAG_ENCRYPT_HEADER, data.length)

  assert.notDeepEqual(data.subarray(0, 160), original.subarray(0, 160))
  assert.deepEqual(data.subarray(160), original.subarray(160))
})

test('chiffrement complet : les blocs au-dela de vingt sont traites', () => {
  const data = Buffer.alloc(8 * 60)
  for (let i = 0; i < data.length; i++) data[i] = (i * 7) % 256
  const original = Buffer.from(data)

  decryptEntry(data, FLAG_ENCRYPT_MIXED, 500) // cycle 4

  // Un bloc multiple du cycle est dechiffre ; ceux qui restent en clair le
  // demeurent, hormis un sur sept qui est desembrouille.
  assert.notDeepEqual(data.subarray(160, 168), original.subarray(160, 168)) // bloc 20, multiple de 4
  assert.deepEqual(data.subarray(168, 176), original.subarray(168, 176))    // bloc 21, intact
})
