import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir, makeFakeClient, makeStringsOnlyClient } from './helpers.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function runExtract(clientDir, outDir) {
  const stdout = execFileSync(
    process.execPath,
    [path.join(ROOT, 'tools', 'extract.mjs'), '--client', clientDir, '--out', outDir],
    { encoding: 'utf8' }
  )
  const read = (name) => JSON.parse(fs.readFileSync(path.join(outDir, name), 'utf8'))
  return { stdout, items: read('items.json'), mobs: read('mobs.json'), maps: read('maps.json'), meta: read('meta.json') }
}

test('extraction complete sur un client synthetique', () => {
  const client = makeFakeClient(tmpdir())
  const out = path.join(tmpdir(), 'data')
  const { items, mobs, maps, meta } = runExtract(client, out)

  // --- items : itemInfo.lub prioritaire, tables texte en complement --------
  assert.equal(items['501'].name, 'Red Potion')
  assert.equal(items['501'].res, 'red_potion')
  assert.equal(items['501'].slots, 0)
  assert.deepEqual(items['501'].desc, [
    'Une potion rouge qui rend',
    '^0000FF45^000000 points de vie.',
  ])
  assert.equal(items['1202'].slots, 3)
  assert.equal(items['4001'].name, 'Poring Card')

  // 2104 n'existe que dans les tables texte : il doit quand meme sortir.
  assert.equal(items['2104'].name, 'Guard')
  assert.equal(items['2104'].slots, 1)
  assert.deepEqual(items['2104'].desc, ['Un bouclier de base.', 'Defense +3.'])

  // --- mobs : nom localise du navi, sprite du jobname ----------------------
  assert.equal(mobs['1002'].sprite, 'PORING')
  assert.equal(mobs['1002'].level, 1)
  assert.equal(mobs['1039'].name, 'Baphomet FR')
  assert.equal(mobs['1039'].level, 81)

  // --- spawns : agreges par carte, tries par population --------------------
  const poringMaps = mobs['1002'].spawns.map((s) => s.map)
  assert.ok(poringMaps.includes('prt_fild08'))
  assert.ok(poringMaps.includes('pay_fild04'))
  assert.equal(mobs['1002'].spawns[0].map, 'prt_fild08') // 60, le plus peuple
  assert.equal(mobs['1002'].spawns[0].amount, 60)

  // --- cartes : nom lisible + mobs presents --------------------------------
  assert.equal(maps['prt_fild08'].name, 'Prontera Field 8')
  assert.deepEqual(
    maps['prt_fild08'].mobs.map((m) => m.id).sort((a, b) => a - b),
    [1002, 1063]
  )
  assert.equal(maps['prontera'].name, 'Prontera') // carte sans mob : conservee
  assert.deepEqual(maps['prontera'].mobs, [])

  // --- colonnes du navi deduites, pas supposees ----------------------------
  // Le client de test a trois langues de navigation : une seule doit compter,
  // sinon 60 deviendrait 180.
  assert.equal(meta.naviAvailable, 3)
  assert.match(meta.naviFile, /navi_mob_frfr/)
  assert.equal(mobs['1002'].name, 'Poring FR') // nom issu de la langue retenue

  assert.deepEqual(meta.naviColumns, { map: 0, id: 1, sprite: -1, name: 2, level: 3, amount: 4 })
  assert.ok(meta.naviConfidence.map > 0.9)
  assert.ok(meta.naviConfidence.id > 0.9)

  assert.equal(meta.counts.items, 5)
  assert.equal(meta.counts.mobs, 4)
  assert.ok(meta.counts.spawns >= 20)
  assert.deepEqual(meta.archives, ['data.grf'])
})

test('itemInfo compile : le bytecode est execute, pas contourne', () => {
  const client = makeFakeClient(tmpdir())
  // Les clients officiels recents ne livrent plus que du bytecode, et plus
  // aucune table texte : on ecrase donc les deux.
  fs.mkdirSync(path.join(client, 'System'), { recursive: true })
  fs.copyFileSync(
    path.join(ROOT, 'test', 'fixtures', 'iteminfo.lub'),
    path.join(client, 'System', 'itemInfo.lub')
  )

  const out = path.join(tmpdir(), 'data')
  const { items, meta } = runExtract(client, out)

  assert.equal(items['501'].name, 'Red Potion')
  assert.equal(items['501'].res, 'red_potion')
  assert.deepEqual(items['501'].desc, [
    'Une potion rouge qui rend',
    '^0000FF45^000000 points de vie.',
  ])
  assert.equal(items['1202'].slots, 3)
  assert.ok(!meta.warnings.some((w) => /bytecode/.test(w)), meta.warnings.join(' | '))
  assert.ok(meta.sources.some((src) => /itemInfo\.lub/.test(src)))
})

test('itemInfo dont la table est locale : les items sortent quand meme', () => {
  const client = makeFakeClient(tmpdir())
  fs.mkdirSync(path.join(client, 'System'), { recursive: true })
  fs.copyFileSync(
    path.join(ROOT, 'test', 'fixtures', 'iteminfo_local.lub'),
    path.join(client, 'System', 'itemInfo.lub')
  )
  // Aucune table texte : le .lub est la seule source, comme sur un vrai client.
  const out = path.join(tmpdir(), 'data')
  const { items, meta } = runExtract(client, out)

  assert.equal(items['501'].name, 'Red Potion')
  assert.equal(items['2104'].name, 'Guard')
  assert.equal(items['1202'].slots, 3)
  assert.ok(!meta.warnings.some((w) => /aucune table d'items/.test(w)), meta.warnings.join(' | '))
})

test('bytecode corrompu : avertissement, et le reste de l extraction tient', () => {
  const client = makeFakeClient(tmpdir())
  fs.mkdirSync(path.join(client, 'System'), { recursive: true })
  const truncated = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'iteminfo.lub')).subarray(0, 60)
  fs.writeFileSync(path.join(client, 'System', 'itemInfo.lub'), truncated)

  const out = path.join(tmpdir(), 'data')
  const { items, mobs, meta } = runExtract(client, out)

  // itemInfo est perdu, mais les tables texte du client de test prennent le relais
  assert.equal(items['501'].name, 'Red Potion')
  assert.equal(mobs['1002'].name, 'Poring FR')
  assert.ok(meta.warnings.some((w) => /tronque/.test(w)), meta.warnings.join(' | '))
})

test('client sans fichier de navigation : extraction partielle, pas d echec', () => {
  const dir = tmpdir()
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'data', 'idnum2itemdisplaynametable.txt'), '501#Red Potion#\n')
  fs.writeFileSync(path.join(dir, 'data', 'mapnametable.txt'), 'prontera.rsw#Prontera#\n')

  const out = path.join(tmpdir(), 'data')
  const { items, mobs, meta } = runExtract(dir, out)

  assert.equal(items['501'].name, 'Red Potion')
  assert.deepEqual(mobs, {})
  assert.ok(meta.warnings.some((w) => /navi_mob/.test(w)))
})

test('drops.json est cree vide et jamais ecrase par une extraction', () => {
  const client = makeFakeClient(tmpdir())
  const out = path.join(tmpdir(), 'data')
  runExtract(client, out)

  const dropsFile = path.join(out, 'drops.json')
  assert.deepEqual(JSON.parse(fs.readFileSync(dropsFile, 'utf8')).mobs, {})

  const csv = path.join(out, 'drops.csv')
  fs.writeFileSync(csv, 'mobId,itemId,chance\n1002,909,7000\n1002,4001,10\n1063,909,5000\n')
  execFileSync(process.execPath, [
    path.join(ROOT, 'tools', 'import-drops.mjs'), csv,
    '--out', dropsFile, '--base', '10000', '--source', 'test',
  ], { encoding: 'utf8' })

  const drops = JSON.parse(fs.readFileSync(dropsFile, 'utf8'))
  assert.equal(drops.meta.source, 'test')
  assert.deepEqual(drops.mobs['1002'], [
    { item: 909, chance: 70 },
    { item: 4001, chance: 0.1 },
  ])

  // Une nouvelle extraction ne doit pas effacer les drops importes.
  runExtract(client, out)
  assert.deepEqual(JSON.parse(fs.readFileSync(dropsFile, 'utf8')).mobs['1002'].length, 2)
})

test('navigation reduite aux chaines : le mob est retrouve par son sprite', () => {
  // Forme reelle de Ragnarok Zero : { carte, nom localise, sprite }, sans
  // identifiant de mob, sans niveau, sans population.
  const client = makeStringsOnlyClient(tmpdir())
  const out = path.join(tmpdir(), 'data')
  const { mobs, maps, meta } = runExtract(client, out)

  // La jointure passe par jobname.lub : PORING -> 1002.
  assert.ok(mobs['1002'].spawns, 'aucune zone pour Poring')
  const poringMaps = mobs['1002'].spawns.map((s) => s.map)
  assert.ok(poringMaps.includes('prt_fild08'))
  assert.ok(poringMaps.includes('pay_fild04'))
  assert.equal(mobs['1039'].spawns.length, 2) // Baphomet, deux cartes

  assert.deepEqual(
    maps['prt_fild08'].mobs.map((m) => m.id).sort((a, b) => a - b),
    [1002, 1063]
  )

  // Sans colonne de population, on n'invente pas de nombre.
  assert.equal(meta.hasPopulations, false)
  assert.equal(mobs['1002'].spawns[0].amount, null)
  assert.ok(meta.warnings.some((w) => /presence/.test(w)), meta.warnings.join(' | '))

  // Le sprite inconnu de jobname.lub est compte, pas silencieusement perdu.
  assert.ok(meta.warnings.some((w) => /sans mob identifiable/.test(w)), meta.warnings.join(' | '))

  // Le nom vient du sprite : lisible, la ou le fichier ne donne que du coreen.
  // Le nom d'origine reste disponible pour la recherche.
  assert.equal(mobs['1002'].name, 'Poring')
  assert.equal(mobs['1002'].nameLocal, '포링')
  assert.ok(meta.warnings.some((w) => /nom non latin/.test(w)), meta.warnings.join(' | '))
})
