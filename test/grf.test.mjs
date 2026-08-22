import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { openGrf } from '../tools/grf.mjs'
import { openClient } from '../tools/vfs.mjs'
import { writeGrf, tmpdir } from './helpers.mjs'

test('lecture d une archive GRF 0x200', () => {
  const dir = tmpdir()
  const grfPath = path.join(dir, 'data.grf')
  writeGrf(grfPath, {
    'data/idnum2itemdisplaynametable.txt': '501#Red Potion#\n',
    'data/mapnametable.txt': 'prontera.rsw#Prontera#\n',
  })

  const grf = openGrf(grfPath)
  assert.equal(grf.version, 0x200)
  assert.equal(grf.entries.size, 2)
  assert.equal(grf.has('data/idnum2itemdisplaynametable.txt'), true)
  assert.equal(grf.has('data\\idnum2itemdisplaynametable.txt'), true)
  assert.equal(grf.has('DATA/IDNUM2ITEMDISPLAYNAMETABLE.TXT'), true)
  assert.equal(grf.read('data/mapnametable.txt').toString(), 'prontera.rsw#Prontera#\n')
  assert.equal(grf.read('data/absent.txt'), null)
  grf.close()
})

test('noms de fichiers coreens (CP949)', () => {
  const dir = tmpdir()
  const grfPath = path.join(dir, 'data.grf')
  const korean = 'data/texture/유저인터페이스/item/red_potion.bmp'
  writeGrf(grfPath, { [korean]: Buffer.from([0x42, 0x4d, 0x01]) })

  const grf = openGrf(grfPath)
  assert.equal(grf.has(korean), true)
  assert.equal(grf.read(korean).length, 3)
  grf.close()
})

test('priorite dossier data/ puis ordre DATA.INI', () => {
  const dir = tmpdir()
  writeGrf(path.join(dir, 'data.grf'), {
    'data/mapnametable.txt': 'depuis data.grf',
    'data/only-in-data.txt': 'x',
  })
  writeGrf(path.join(dir, 'rdata.grf'), {
    'data/mapnametable.txt': 'depuis rdata.grf',
    'data/only-in-rdata.txt': 'y',
  })
  fs.writeFileSync(path.join(dir, 'DATA.INI'), '[Data]\n0=rdata.grf\n1=data.grf\n')

  const vfs = openClient(dir)
  assert.deepEqual(vfs.grfs.map((g) => g.name), ['rdata.grf', 'data.grf'])
  assert.equal(vfs.readText('data/mapnametable.txt'), 'depuis rdata.grf')
  assert.equal(vfs.readText('data/only-in-data.txt'), 'x')
  assert.equal(vfs.readText('data/only-in-rdata.txt'), 'y')

  // Un fichier en clair dans data/ prend le pas sur toutes les archives.
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'data', 'mapnametable.txt'), 'patch en clair')
  const patched = openClient(dir)
  assert.equal(patched.readText('data/mapnametable.txt'), 'patch en clair')
  assert.equal(patched.exists('data/mapnametable.txt'), true)
  assert.ok(patched.list((k) => k.endsWith('.txt')).length >= 3)
  patched.close()
  vfs.close()
})

test('une archive illisible ne fait pas tomber le reste', () => {
  const dir = tmpdir()
  writeGrf(path.join(dir, 'data.grf'), { 'data/ok.txt': 'ok' })
  fs.writeFileSync(path.join(dir, 'casse.grf'), Buffer.from('pas un grf du tout'))

  const vfs = openClient(dir)
  assert.equal(vfs.readText('data/ok.txt'), 'ok')
  assert.equal(vfs.errors.length, 1)
  assert.match(vfs.errors[0], /casse\.grf/)
  vfs.close()
})

test('signature non standard : l archive reste lisible', () => {
  const dir = tmpdir()
  const grfPath = path.join(dir, 'data.grf')
  writeGrf(grfPath, { 'data/mapnametable.txt': 'prontera.rsw#Prontera#\n' })

  // Ragnarok Zero annonce "Event Horizon" au lieu de "Master of Magic".
  // Le format ne change pas pour autant : on valide sur la structure.
  const fd = fs.openSync(grfPath, 'r+')
  fs.writeSync(fd, Buffer.from('Event Horizon\0\0', 'latin1'), 0, 15, 0)
  fs.closeSync(fd)

  const grf = openGrf(grfPath)
  assert.equal(grf.signature, 'Event Horizon')
  assert.equal(grf.customSignature, true)
  assert.equal(grf.read('data/mapnametable.txt').toString(), 'prontera.rsw#Prontera#\n')
  grf.close()
})

test('archive chiffree : message clair, pas de plantage obscur', () => {
  const dir = tmpdir()
  const grfPath = path.join(dir, 'data.grf')
  writeGrf(grfPath, { 'data/mapnametable.txt': 'prontera.rsw#Prontera#\n' })

  // On brouille le flux de la table : en-tete intact, contenu illisible.
  const raw = fs.readFileSync(grfPath)
  const tableOffset = 0x2e + raw.readUInt32LE(0x1e) + 8
  raw.fill(0xab, tableOffset, tableOffset + 16)
  fs.writeFileSync(grfPath, raw)

  assert.throws(() => openGrf(grfPath), /chiffree|illisible/)
})

test('offset de table aberrant : refus explicite', () => {
  const dir = tmpdir()
  const grfPath = path.join(dir, 'data.grf')
  writeGrf(grfPath, { 'data/ok.txt': 'ok' })
  const raw = fs.readFileSync(grfPath)
  raw.writeUInt32LE(0x7fffffff, 0x1e)
  fs.writeFileSync(grfPath, raw)

  assert.throws(() => openGrf(grfPath), /hors limites/)
})
