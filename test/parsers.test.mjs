import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSimpleTable, parseDescTable, parseMapNameTable, stripColorCodes } from '../tools/parsers/tables.mjs'
import { inferColumns } from '../tools/parsers/navi.mjs'
import { prettifySprite, looksLikeMobId } from '../tools/parsers/mobs.mjs'
import { decodeBmp } from '../tools/icons.mjs'

test('table simple cle#valeur#', () => {
  const map = parseSimpleTable('501#Red Potion#\n909#Jellopy#\n\n// commentaire\n1202#Knife#')
  assert.equal(map.get('501'), 'Red Potion')
  assert.equal(map.get('1202'), 'Knife')
  assert.equal(map.size, 3)
})

test('une valeur contenant un # reste intacte', () => {
  const map = parseSimpleTable('123#Epee #1 du roi#')
  assert.equal(map.get('123'), 'Epee #1 du roi')
})

test('table de descriptions multilignes', () => {
  const map = parseDescTable([
    '501#',
    'Une potion rouge.',
    'Rend ^0000FF45^000000 PV.',
    '#',
    '909#',
    'Un morceau de gelee.',
    '#',
  ].join('\n'))
  assert.deepEqual(map.get('501'), ['Une potion rouge.', 'Rend ^0000FF45^000000 PV.'])
  assert.deepEqual(map.get('909'), ['Un morceau de gelee.'])
})

test('noms de cartes : extension retiree, id en minuscules', () => {
  const map = parseMapNameTable('prontera.rsw#Prontera#\nPRT_FILD08.rsw#Prontera Field 8#\n')
  assert.equal(map.get('prontera'), 'Prontera')
  assert.equal(map.get('prt_fild08'), 'Prontera Field 8')
})

test('codes couleur retires', () => {
  assert.equal(stripColorCodes('Rend ^0000FF45^000000 PV.'), 'Rend 45 PV.')
})

test('sprite -> nom lisible', () => {
  assert.equal(prettifySprite('PORING'), 'Poring')
  assert.equal(prettifySprite('BAPHOMET_'), 'Baphomet')
  assert.equal(prettifySprite('GOBLIN_ARCHER'), 'Goblin Archer')
})

test('plages d ids de mobs', () => {
  assert.equal(looksLikeMobId(1002), true)
  assert.equal(looksLikeMobId(20350), true)
  assert.equal(looksLikeMobId(7), false)   // classe de joueur
  assert.equal(looksLikeMobId(501), false) // item
})

test('deduction des colonnes : niveau vs nombre', () => {
  // Colonnes volontairement melangees : nombre, nom, carte, niveau, id.
  const rows = [
    [60, 'Poring', 'prt_fild08', 1, 1002],
    [25, 'Poring', 'pay_fild04', 1, 1002],
    [12, 'Poring', 'prt_fild01', 1, 1002],
    [40, 'Lunatic', 'prt_fild08', 3, 1063],
    [22, 'Lunatic', 'prt_fild03', 3, 1063],
    [35, 'Lunatic', 'prt_fild04', 3, 1063],
    [30, 'Poporing', 'pay_fild04', 14, 1031],
    [15, 'Poporing', 'gef_fild00', 14, 1031],
    [8, 'Poporing', 'prt_fild05', 14, 1031],
  ]
  const knownMaps = new Set(['prt_fild08', 'pay_fild04', 'prt_fild01', 'prt_fild03', 'prt_fild04', 'gef_fild00', 'prt_fild05'])
  const knownMobIds = new Set([1002, 1063, 1031])

  const { columns } = inferColumns(rows, { knownMaps, knownMobIds })
  assert.equal(columns.map, 2)
  assert.equal(columns.id, 4)
  assert.equal(columns.name, 1)
  // Le niveau est constant par mob, la population varie : c'est ce qui les separe.
  assert.equal(columns.level, 3)
  assert.equal(columns.amount, 0)
})

test('deduction des colonnes sans liste de cartes connues', () => {
  const rows = Array.from({ length: 12 }, (_, i) => [`map_${i}`, 1002 + (i % 3), `Mob ${i % 3}`, 5, i + 1])
  const { columns } = inferColumns(rows, {})
  assert.equal(columns.map, 0) // identifiant technique : minuscules + underscore
  assert.equal(columns.id, 1)
})

/** Construit un BMP 24 bits bottom-up de 2x2. */
function makeBmp(pixels) {
  const rowSize = Math.floor((24 * 2 + 31) / 32) * 4
  const data = Buffer.alloc(rowSize * 2)
  pixels.forEach(([r, g, b], i) => {
    const x = i % 2
    const y = i < 2 ? 1 : 0 // bottom-up
    const o = y * rowSize + x * 3
    data[o] = b; data[o + 1] = g; data[o + 2] = r
  })
  const header = Buffer.alloc(54)
  header.write('BM', 0, 'latin1')
  header.writeUInt32LE(54 + data.length, 2)
  header.writeUInt32LE(54, 0x0a)
  header.writeUInt32LE(40, 0x0e)
  header.writeInt32LE(2, 0x12)
  header.writeInt32LE(2, 0x16)
  header.writeUInt16LE(1, 0x1a)
  header.writeUInt16LE(24, 0x1c)
  return Buffer.concat([header, data])
}

test('BMP 24 bits : couleurs et magenta transparent', () => {
  const bmp = decodeBmp(makeBmp([
    [255, 0, 0], [0, 255, 0],      // ligne du haut
    [255, 0, 255], [0, 0, 255],    // ligne du bas, magenta = transparent
  ]))
  assert.equal(bmp.width, 2)
  assert.equal(bmp.height, 2)
  assert.deepEqual([...bmp.rgba.subarray(0, 4)], [255, 0, 0, 255])
  assert.deepEqual([...bmp.rgba.subarray(4, 8)], [0, 255, 0, 255])
  assert.deepEqual([...bmp.rgba.subarray(8, 12)], [255, 0, 255, 0]) // alpha 0
  assert.deepEqual([...bmp.rgba.subarray(12, 16)], [0, 0, 255, 255])
})

test('BMP invalide : null plutot qu une exception', () => {
  assert.equal(decodeBmp(Buffer.from('pas une image')), null)
})
