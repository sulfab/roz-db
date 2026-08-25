import test from 'node:test'
import assert from 'node:assert/strict'
import { inferShape, inferRateField, inferScale, buildTable } from '../tools/import-external.mjs'

/** Oracle du client : c'est lui qui juge, pas des noms de champs codes en dur. */
const ORACLE = {
  mobs: new Set([1002, 1034, 1113, 1280, 1515]),
  items: new Set([909, 501, 4001, 1202, 7563, 12103]),
  mobNames: new Map([[1002, 'Poring'], [1034, 'Thief Bug Egg']]),
  itemNames: new Map([[909, 'Jellopy'], [501, 'Red Potion']]),
}

/** Cinq monstres au moins : en dessous, ce n'est pas une table. */
const base = (mobField, listField, itemField, rateField) =>
  [1002, 1034, 1113, 1280, 1515].map((id, i) => ({
    [mobField]: id,
    [listField]: [
      { [itemField]: 909, [rateField]: 7000 - i * 100 },
      { [itemField]: 501, [rateField]: 800 + i * 10 },
      { [itemField]: 4001, [rateField]: 20 + i },
    ],
  }))

test('les noms de champs se lisent dans le fichier, ils ne sont pas supposes', () => {
  const forme = inferShape(base('Id', 'Drops', 'Item', 'Rate'), ORACLE)
  assert.equal(forme.mob, 'Id')
  assert.equal(forme.liste, 'Drops')
  assert.equal(forme.item, 'Item')
  assert.equal(forme.taux.cle, 'Rate')
})

test('des noms tout autres donnent le meme resultat', () => {
  // C'est tout l'interet : une autre base, d'autres conventions, meme lecture.
  const forme = inferShape(base('monster_id', 'loot', 'item_id', 'chance'), ORACLE)
  assert.equal(forme.mob, 'monster_id')
  assert.equal(forme.liste, 'loot')
  assert.equal(forme.item, 'item_id')
  assert.equal(forme.taux.cle, 'chance')
})

test('une table enfouie dans le fichier est trouvee quand meme', () => {
  const fichier = { meta: { version: 3 }, data: { monsters: base('Id', 'Drops', 'Item', 'Rate') } }
  const forme = inferShape(fichier, ORACLE)
  assert.equal(forme.mob, 'Id')
  assert.equal(forme.noeuds, 5)
})

test('un fichier sans monstres connus ne donne rien', () => {
  const forme = inferShape(base('Id', 'Drops', 'Item', 'Rate').map((m) => ({ ...m, Id: m.Id + 50000 })), ORACLE)
  assert.equal(forme, null)
})

test('une liste qui ne contient pas surtout des objets connus est ecartee', () => {
  const fichier = [1002, 1034, 1113, 1280, 1515].map((id) => ({
    Id: id,
    Skills: [{ Item: 909 }, { Item: 99001 }, { Item: 99002 }, { Item: 99003 }],
  }))
  assert.equal(inferShape(fichier, ORACLE), null)
})

test('un second identifiant d objet ne passe pas pour un taux', () => {
  const noeuds = [{ Drops: [{ Item: 909, Alt: 501, Rate: 7000 }, { Item: 4001, Alt: 1202, Rate: 20 }] }]
  const taux = inferRateField(noeuds, { liste: 'Drops', item: 'Item' }, ORACLE)
  assert.equal(taux.cle, 'Rate')
})

test('un champ constant ne passe pas pour un taux', () => {
  const noeuds = [{ Drops: [{ Item: 909, Flag: 1, Rate: 7000 }, { Item: 4001, Flag: 1, Rate: 20 }] }]
  const taux = inferRateField(noeuds, { liste: 'Drops', item: 'Item' }, ORACLE)
  assert.equal(taux.cle, 'Rate')
})

test('l echelle se deduit de l ordre de grandeur des taux', () => {
  assert.equal(inferScale(7000).base, 10000)
  assert.equal(inferScale(85).base, 100)
  assert.equal(inferScale(650000).base, 1000000)
})

test('les taux sont convertis en pourcentage', () => {
  const { table, echelle } = buildTable(base('Id', 'Drops', 'Item', 'Rate'), ORACLE, { source: 'essai' })
  assert.equal(echelle.base, 10000)
  const poring = table.mobs['1002']
  assert.equal(poring[0].item, 909)
  assert.equal(poring[0].chance, 70)          // 7000 / 10000 = 70 %
  assert.equal(poring[2].chance, 0.2)         // 20 / 10000 = 0,2 %
})

test('les objets inconnus du client sont comptes, pas importes', () => {
  const fichier = base('Id', 'Drops', 'Item', 'Rate')
  fichier[0].Drops.push({ Item: 99999, Rate: 500 })
  const { table, inconnus } = buildTable(fichier, ORACLE, {})
  assert.equal(inconnus, 1)
  assert.equal(table.mobs['1002'].some((d) => d.item === 99999), false)
})

test('les identifiants ecrits en texte sont acceptes', () => {
  const fichier = base('Id', 'Drops', 'Item', 'Rate').map((m) => ({
    ...m, Id: String(m.Id), Drops: m.Drops.map((d) => ({ ...d, Item: String(d.Item) })),
  }))
  const { table } = buildTable(fichier, ORACLE, {})
  assert.equal(table.meta.mobs, 5)
})

test('la table produite porte sa source et son echelle', () => {
  const { table } = buildTable(base('Id', 'Drops', 'Item', 'Rate'), ORACLE, { source: 'TW RO Zero' })
  assert.equal(table.meta.source, 'TW RO Zero')
  assert.equal(table.meta.base, 10000)
  assert.equal(table.meta.entries, 15)
})
