/**
 * Dechiffrement des entrees chiffrees d'une archive GRF.
 *
 * Certaines entrees — sur Ragnarok Zero, la base d'items de 3,3 Mo — sont
 * chiffrees avec une variante de DES : permutations initiale et finale
 * standard, mais un seul tour de fonction et aucune cle. Selon le drapeau de
 * l'entree, tout le fichier est traite ou seulement son en-tete.
 *
 * L'algorithme et les tables suivent le format GRF tel qu'implemente par
 * rAthena (src/common/des.cpp et grfio.cpp) ; les permutations et les boites S
 * sont celles du DES standard.
 *
 * Verification : le contenu dechiffre est ensuite decompresse. Un
 * dechiffrement faux ne passe donc pas inapercu — zlib le rejette.
 */

const IP_TABLE = [
  58, 50, 42, 34, 26, 18, 10, 2,
  60, 52, 44, 36, 28, 20, 12, 4,
  62, 54, 46, 38, 30, 22, 14, 6,
  64, 56, 48, 40, 32, 24, 16, 8,
  57, 49, 41, 33, 25, 17, 9, 1,
  59, 51, 43, 35, 27, 19, 11, 3,
  61, 53, 45, 37, 29, 21, 13, 5,
  63, 55, 47, 39, 31, 23, 15, 7,
]

const FP_TABLE = [
  40, 8, 48, 16, 56, 24, 64, 32,
  39, 7, 47, 15, 55, 23, 63, 31,
  38, 6, 46, 14, 54, 22, 62, 30,
  37, 5, 45, 13, 53, 21, 61, 29,
  36, 4, 44, 12, 52, 20, 60, 28,
  35, 3, 43, 11, 51, 19, 59, 27,
  34, 2, 42, 10, 50, 18, 58, 26,
  33, 1, 41, 9, 49, 17, 57, 25,
]

const TP_TABLE = [
  16, 7, 20, 21,
  29, 12, 28, 17,
  1, 15, 23, 26,
  5, 18, 31, 10,
  2, 8, 24, 14,
  32, 27, 3, 9,
  19, 13, 30, 6,
  22, 11, 4, 25,
]

const S_TABLE = [
  [
    0xef, 0x03, 0x41, 0xfd, 0xd8, 0x74, 0x1e, 0x47,
    0x26, 0xef, 0xfb, 0x22, 0xb3, 0xd8, 0x84, 0x1e,
    0x39, 0xac, 0xa7, 0x60, 0x62, 0xc1, 0xcd, 0xba,
    0x5c, 0x96, 0x90, 0x59, 0x05, 0x3b, 0x7a, 0x85,
    0x40, 0xfd, 0x1e, 0xc8, 0xe7, 0x8a, 0x8b, 0x21,
    0xda, 0x43, 0x64, 0x9f, 0x2d, 0x14, 0xb1, 0x72,
    0xf5, 0x5b, 0xc8, 0xb6, 0x9c, 0x37, 0x76, 0xec,
    0x39, 0xa0, 0xa3, 0x05, 0x52, 0x6e, 0x0f, 0xd9,
  ],
  [
    0xa7, 0xdd, 0x0d, 0x78, 0x9e, 0x0b, 0xe3, 0x95,
    0x60, 0x36, 0x36, 0x4f, 0xf9, 0x60, 0x5a, 0xa3,
    0x11, 0x24, 0xd2, 0x87, 0xc8, 0x52, 0x75, 0xec,
    0xbb, 0xc1, 0x4c, 0xba, 0x24, 0xfe, 0x8f, 0x19,
    0xda, 0x13, 0x66, 0xaf, 0x49, 0xd0, 0x90, 0x06,
    0x8c, 0x6a, 0xfb, 0x91, 0x37, 0x8d, 0x0d, 0x78,
    0xbf, 0x49, 0x11, 0xf4, 0x23, 0xe5, 0xce, 0x3b,
    0x55, 0xbc, 0xa2, 0x57, 0xe8, 0x22, 0x74, 0xce,
  ],
  [
    0x2c, 0xea, 0xc1, 0xbf, 0x4a, 0x24, 0x1f, 0xc2,
    0x79, 0x47, 0xa2, 0x7c, 0xb6, 0xd9, 0x68, 0x15,
    0x80, 0x56, 0x5d, 0x01, 0x33, 0xfd, 0xf4, 0xae,
    0xde, 0x30, 0x07, 0x9b, 0xe5, 0x83, 0x9b, 0x68,
    0x49, 0xb4, 0x2e, 0x83, 0x1f, 0xc2, 0xb5, 0x7c,
    0xa2, 0x19, 0xd8, 0xe5, 0x7c, 0x2f, 0x83, 0xda,
    0xf7, 0x6b, 0x90, 0xfe, 0xc4, 0x01, 0x5a, 0x97,
    0x61, 0xa6, 0x3d, 0x40, 0x0b, 0x58, 0xe6, 0x3d,
  ],
  [
    0x4d, 0xd1, 0xb2, 0x0f, 0x28, 0xbd, 0xe4, 0x78,
    0xf6, 0x4a, 0x0f, 0x93, 0x8b, 0x17, 0xd1, 0xa4,
    0x3a, 0xec, 0xc9, 0x35, 0x93, 0x56, 0x7e, 0xcb,
    0x55, 0x20, 0xa0, 0xfe, 0x6c, 0x89, 0x17, 0x62,
    0x17, 0x62, 0x4b, 0xb1, 0xb4, 0xde, 0xd1, 0x87,
    0xc9, 0x14, 0x3c, 0x4a, 0x7e, 0xa8, 0xe2, 0x7d,
    0xa0, 0x9f, 0xf6, 0x5c, 0x6a, 0x09, 0x8d, 0xf0,
    0x0f, 0xe3, 0x53, 0x25, 0x95, 0x36, 0x28, 0xcb,
  ],
]

/** Bit de poids fort en premier, comme dans la specification. */
const MASK = [0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01]

function permute(block, table, srcBase, dstBase) {
  const out = new Uint8Array(8)
  for (let i = 0; i < table.length; i++) {
    const j = table[i] - 1
    if (block[((j >> 3) & 7) + srcBase] & MASK[j & 7]) {
      out[((i >> 3) & 7) + dstBase] |= MASK[i & 7]
    }
  }
  return out
}

/** Permutation initiale. Exportee pour que les tests verifient qu'elle et la
 * permutation finale sont bien inverses l'une de l'autre. */
export function initialPermutation(block) {
  block.set(permute(block, IP_TABLE, 0, 0))
  return block
}

/** Permutation finale, inverse de la precedente. */
export function finalPermutation(block) {
  block.set(permute(block, FP_TABLE, 0, 0))
  return block
}

/**
 * Expansion : la moitie haute (32 bits) devient huit groupes de 6 bits.
 * Ecrit sous forme d'operations directes plutot qu'en parcourant une table,
 * comme le fait l'implementation de reference.
 */
function expand(block) {
  const out = new Uint8Array(8)
  out[0] = ((block[7] << 5) | (block[4] >> 3)) & 0x3f
  out[1] = ((block[4] << 1) | (block[5] >> 7)) & 0x3f
  out[2] = ((block[4] << 5) | (block[5] >> 3)) & 0x3f
  out[3] = ((block[5] << 1) | (block[6] >> 7)) & 0x3f
  out[4] = ((block[5] << 5) | (block[6] >> 3)) & 0x3f
  out[5] = ((block[6] << 1) | (block[7] >> 7)) & 0x3f
  out[6] = ((block[6] << 5) | (block[7] >> 3)) & 0x3f
  out[7] = ((block[7] << 1) | (block[4] >> 7)) & 0x3f
  block.set(out)
}

/** Boites de substitution : deux quartets traites d'un coup. */
function sbox(block) {
  const out = new Uint8Array(8)
  for (let i = 0; i < S_TABLE.length; i++) {
    out[i] = (S_TABLE[i][block[i * 2]] & 0xf0) | (S_TABLE[i][block[i * 2 + 1]] & 0x0f)
  }
  block.set(out)
}

/** Transposition : les 32 bits bas sont reordonnes vers la moitie haute. */
function transpose(block) {
  block.set(permute(block, TP_TABLE, 0, 4))
}

/** Un tour : la moitie basse est melangee a la haute transformee. */
function roundFunction(block) {
  const tmp = Uint8Array.from(block)
  expand(tmp)
  sbox(tmp)
  transpose(tmp)
  for (let i = 0; i < 4; i++) block[i] ^= tmp[i + 4]
}

export function decryptBlock(block) {
  initialPermutation(block)
  roundFunction(block)
  finalPermutation(block)
  return block
}

/** Substitution appliquee au dernier octet d'un bloc melange. Involutive. */
const SUBSTITUTION = new Map([
  [0x00, 0x2b], [0x2b, 0x00], [0x6c, 0x80], [0x80, 0x6c],
  [0x01, 0x68], [0x68, 0x01], [0x48, 0x77], [0x77, 0x48],
  [0x60, 0xff], [0xff, 0x60], [0xb9, 0xc0], [0xc0, 0xb9],
  [0xfe, 0xeb], [0xeb, 0xfe],
])

export function substitute(byte) {
  return SUBSTITUTION.get(byte) ?? byte
}

/** Remise en ordre d'un bloc brouille, sans chiffrement. */
export function unshuffleBlock(block) {
  const out = Uint8Array.from([
    block[3], block[4], block[6], block[0],
    block[1], block[2], block[5], substitute(block[7]),
  ])
  block.set(out)
  return block
}

const HEADER_BLOCKS = 20
const SHUFFLE_CYCLE = 7

/**
 * Ecart entre deux blocs chiffres, deduit du nombre de chiffres de la taille
 * compressee de l'entree.
 *   chiffres :  1  2  3  4  5  6  7  8 ...
 *   cycle    :  1  1  4  5 14 15 22 23 ...
 */
export function cycleFor(packedLength) {
  let digits = 1
  for (let i = 10; i <= packedLength; i *= 10) digits++
  if (digits < 3) return 1
  if (digits < 5) return digits + 1
  if (digits < 7) return digits + 9
  return digits + 15
}

/**
 * Dechiffre une entree, en place.
 *
 * @param {Buffer} data contenu brut, tel qu'il est stocke dans l'archive
 * @param {number} flags drapeaux de l'entree
 * @param {number} packedLength taille compressee declaree (pilote le cycle)
 */
export function decryptEntry(data, flags, packedLength) {
  const blocks = Math.floor(data.length / 8)
  const view = (i) => data.subarray(i * 8, i * 8 + 8)

  // Les vingt premiers blocs sont toujours chiffres, quel que soit le mode.
  for (let i = 0; i < Math.min(HEADER_BLOCKS, blocks); i++) {
    const block = Uint8Array.from(view(i))
    decryptBlock(block)
    view(i).set(block)
  }

  if (!(flags & FLAG_ENCRYPT_MIXED)) return data // en-tete seul : le reste est en clair

  // Au-dela, un bloc sur `cycle` est chiffre ; parmi les autres, un sur sept
  // est simplement brouille.
  const cycle = cycleFor(packedLength)
  let plain = -1
  for (let i = HEADER_BLOCKS; i < blocks; i++) {
    if (i % cycle === 0) {
      const block = Uint8Array.from(view(i))
      decryptBlock(block)
      view(i).set(block)
      continue
    }
    plain++
    if (plain % SHUFFLE_CYCLE === 0 && plain !== 0) {
      const block = Uint8Array.from(view(i))
      unshuffleBlock(block)
      view(i).set(block)
    }
  }
  return data
}

export const FLAG_ENCRYPT_MIXED = 0x02
export const FLAG_ENCRYPT_HEADER = 0x04
