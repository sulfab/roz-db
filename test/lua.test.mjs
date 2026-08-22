import test from 'node:test'
import assert from 'node:assert/strict'
import { parseLua, toArray, numericEntries, isCompiledLua } from '../tools/lua.mjs'

test('tables indexees, chaines, concatenation', () => {
  const { env, warnings } = parseLua(`
    -- commentaire de tete
    tbl = {
      [501] = {
        unidentifiedDisplayName = "Red Potion",
        slotCount = 0,
        ClassNum = 0,
        identifiedDescriptionName = { "Une potion.", "Rend ^0000FF45^000000 PV." },
      },
      [1202] = { unidentifiedDisplayName = "Knife" .. " [3]", slotCount = 3 },
    }
  `)
  assert.deepEqual(warnings, [])
  assert.equal(env.tbl['501'].unidentifiedDisplayName, 'Red Potion')
  assert.equal(env.tbl['501'].slotCount, 0)
  assert.equal(env.tbl['1202'].unidentifiedDisplayName, 'Knife [3]')
  assert.deepEqual(toArray(env.tbl['501'].identifiedDescriptionName), [
    'Une potion.',
    'Rend ^0000FF45^000000 PV.',
  ])
  assert.deepEqual(numericEntries(env.tbl).map(([k]) => k), [501, 1202])
})

test('constantes resolues depuis le meme fichier', () => {
  const { env } = parseLua(`
    jobtbl = { JT_PORING = 1002, JT_LUNATIC = 1063 }
    JobNameTable = {}
    JobNameTable[jobtbl.JT_PORING] = "PORING"
    JobNameTable[jobtbl.JT_LUNATIC] = "LUNATIC"
  `)
  assert.equal(env.JobNameTable['1002'], 'PORING')
  assert.equal(env.JobNameTable['1063'], 'LUNATIC')
})

test('constantes injectees via env', () => {
  const base = parseLua('jobtbl = { JT_PORING = 1002 }').env
  const { env } = parseLua('names = { [jobtbl.JT_PORING] = "Poring" }', { env: base })
  assert.equal(env.names['1002'], 'Poring')
})

test('fonctions et boucles sont sautees sans casser la suite', () => {
  const { env, warnings } = parseLua(`
    function main(a, b)
      for i = 1, 10 do
        if a then print(i) else print(b) end
      end
      while true do break end
      return b
    end

    local function helper() return 1 end

    Navi = { { "prt_fild08", 1002, "Poring", 1, 60 } }
  `)
  assert.deepEqual(warnings, [])
  assert.deepEqual(toArray(toArray(env.Navi)[0]), ['prt_fild08', 1002, 'Poring', 1, 60])
})

test('long strings et commentaires blocs', () => {
  const { env } = parseLua(`
    --[[ bloc
         sur plusieurs lignes ]]
    texte = [[ligne1
ligne2]]
    autre = [==[avec ]] dedans]==]
  `)
  assert.equal(env.texte, 'ligne1\nligne2')
  assert.equal(env.autre, 'avec ]] dedans')
})

test('appels de fonction en fin de fichier', () => {
  const { env } = parseLua(`
    data = { a = 1 }
    main()
    require("autre/fichier")
    after = 2
  `)
  assert.equal(env.data.a, 1)
  assert.equal(env.after, 2)
})

test('bytecode Lua compile est detecte', () => {
  assert.equal(isCompiledLua(Buffer.from([0x1b, 0x4c, 0x75, 0x61, 0x51, 0x00])), true)
  assert.equal(isCompiledLua(Buffer.from('tbl = {}', 'utf8')), false)
})

test('un fichier tronque ne fait pas boucler le parseur', () => {
  const { env, warnings } = parseLua('tbl = { [1] = { name = "x" ')
  assert.ok(warnings.length > 0)
  assert.equal(typeof env, 'object')
})
