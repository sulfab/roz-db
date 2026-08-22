import { decode } from './encoding.mjs'
import { parseLua, isCompiledLua } from './lua.mjs'
import { runCompiled, toPlain, toPlainAll, LuaTable, makeEnv } from './luac.mjs'

/**
 * Point d'entree unique pour lire un fichier .lub, quel que soit son etat.
 *
 * Les clients livrent tantot du Lua source (anciens clients, repacks), tantot
 * du bytecode compile (clients officiels recents). Les deux donnent le meme
 * resultat ici : un objet JS des globales definies par le fichier. Les parseurs
 * n'ont donc pas a s'en soucier.
 */

/** Objet JS -> table Lua, pour reinjecter les constantes d'un fichier deja lu. */
function toLuaTable(plain, seen = new Map()) {
  if (plain === null || typeof plain !== 'object') return plain
  if (seen.has(plain)) return seen.get(plain)
  const table = new LuaTable()
  seen.set(plain, table)
  for (const [key, value] of Object.entries(plain)) {
    // Les cles numeriques redeviennent des nombres : en Lua t[1] n'est pas t["1"].
    const luaKey = /^-?\d+$/.test(key) ? Number(key) : key
    const luaValue = toLuaTable(value, seen)
    if (luaValue !== null && luaValue !== undefined) table.set(luaKey, luaValue)
  }
  return table
}

/**
 * @param {Buffer} buffer contenu brut du fichier
 * @param {{encoding?: string, env?: object, includeTables?: boolean}} options
 *   env : globales d'un fichier deja lu, a rendre visibles a celui-ci
 *   (npcidentity avant jobname). includeTables : rend aussi toutes les tables
 *   construites, y compris celles declarees en local.
 * @returns {{env: object, tables: object[], warnings: string[], compiled: boolean}}
 */
export function loadLua(buffer, { encoding = 'auto', env = null, includeTables = false } = {}) {
  if (!isCompiledLua(buffer)) {
    const result = parseLua(decode(buffer, encoding), env ? { env } : {})
    return { env: result.env, tables: [], warnings: result.warnings, compiled: false }
  }

  const runtime = makeEnv()
  const builtins = new Set(runtime.hash.keys())
  if (env) {
    for (const [key, value] of Object.entries(env)) {
      runtime.set(key, toLuaTable(value))
      builtins.delete(key)
    }
  }

  const { env: result, error, missing, tables } = runCompiled(buffer, { env: runtime })

  // La bibliotheque standard n'est pas une donnee du fichier : on la retire.
  for (const key of builtins) result.hash.delete(key)

  const decodeString = (s) => decode(Buffer.from(s, 'latin1'), encoding)
  const warnings = []
  if (error) warnings.push(`execution interrompue : ${error}`)
  return {
    env: toPlain(result, decodeString),
    tables: includeTables ? toPlainAll(tables, decodeString) : [],
    warnings,
    // Purement informatif : ces fonctions sont fournies par le client de jeu,
    // leur absence n'empeche pas de recuperer les tables.
    missing,
    compiled: true,
  }
}

/** Diagnostic pour l'inventaire : que vaut ce fichier ? */
export function describeLua(buffer) {
  if (!isCompiledLua(buffer)) return { compiled: false, readable: true, note: 'source Lua' }
  try {
    loadLua(buffer)
    return { compiled: true, readable: true, note: 'bytecode Lua 5.1 (execute)' }
  } catch (err) {
    return { compiled: true, readable: false, note: `bytecode illisible : ${err.message}` }
  }
}
