/**
 * Lecture des fichiers .lub compiles : desassemblage puis execution.
 *
 * Les clients Ragnarok recents ne livrent plus aucune table en clair — tout est
 * du bytecode Lua 5.1. Un decompilateur redonnerait du source qu'il faudrait
 * reparser ; on va plus court en *executant* le chunk dans une petite machine
 * virtuelle et en recuperant les variables globales qu'il a definies. Ces
 * fichiers sont de la donnee : ils construisent des tables et s'arretent.
 *
 * Les chaines sont lues en latin1 pour rester fideles aux octets ; le decodage
 * (UTF-8, CP949) intervient a la conversion finale, quand on sait quel client
 * on lit.
 */

const SIGNATURE = Buffer.from([0x1b, 0x4c, 0x75, 0x61]) // "\27Lua"
const VERSION_51 = 0x51

export class LuaError extends Error {}

// --- desassemblage ---------------------------------------------------------

class Reader {
  constructor(buf) {
    this.buf = buf
    this.pos = 0
    this.sizeT = 4
    this.littleEndian = true
  }

  /** Tout acces borne : un .lub tronque doit dire qu'il est tronque. */
  need(n) {
    if (this.pos + n > this.buf.length) {
      throw new LuaError(`fichier tronque : ${n} octet(s) attendu(s) a ${this.pos}, ` +
        `il n'en reste que ${Math.max(0, this.buf.length - this.pos)}`)
    }
  }

  byte() {
    this.need(1)
    return this.buf[this.pos++]
  }

  int() {
    this.need(4)
    const v = this.littleEndian ? this.buf.readInt32LE(this.pos) : this.buf.readInt32BE(this.pos)
    this.pos += 4
    return v
  }

  size() {
    this.need(this.sizeT)
    if (this.sizeT === 8) {
      const v = this.littleEndian ? this.buf.readBigUInt64LE(this.pos) : this.buf.readBigUInt64BE(this.pos)
      this.pos += 8
      return Number(v)
    }
    const v = this.littleEndian ? this.buf.readUInt32LE(this.pos) : this.buf.readUInt32BE(this.pos)
    this.pos += 4
    return v
  }

  number() {
    this.need(8)
    const v = this.littleEndian ? this.buf.readDoubleLE(this.pos) : this.buf.readDoubleBE(this.pos)
    this.pos += 8
    return v
  }

  /** Chaine Lua : longueur (avec le \0 final), puis les octets. */
  string() {
    const len = this.size()
    if (len === 0) return null
    this.need(len)
    const raw = this.buf.subarray(this.pos, this.pos + len - 1)
    this.pos += len
    return raw.toString('latin1')
  }
}

const CONST_NIL = 0
const CONST_BOOLEAN = 1
const CONST_NUMBER = 3
const CONST_STRING = 4

function readFunction(r) {
  const proto = {
    source: r.string(),
    lineDefined: r.int(),
    lastLineDefined: r.int(),
    upvalCount: r.byte(),
    paramCount: r.byte(),
    isVararg: r.byte(),
    maxStack: r.byte(),
  }

  const codeLength = r.int()
  r.need(codeLength * 4)
  proto.code = new Uint32Array(codeLength)
  for (let i = 0; i < codeLength; i++) {
    proto.code[i] = r.littleEndian ? r.buf.readUInt32LE(r.pos) : r.buf.readUInt32BE(r.pos)
    r.pos += 4
  }

  const constCount = r.int()
  proto.constants = new Array(constCount)
  for (let i = 0; i < constCount; i++) {
    const type = r.byte()
    if (type === CONST_NIL) proto.constants[i] = null
    else if (type === CONST_BOOLEAN) proto.constants[i] = r.byte() !== 0
    else if (type === CONST_NUMBER) proto.constants[i] = r.number()
    else if (type === CONST_STRING) proto.constants[i] = r.string()
    else throw new LuaError(`type de constante inconnu : ${type}`)
  }

  const protoCount = r.int()
  proto.protos = new Array(protoCount)
  for (let i = 0; i < protoCount; i++) proto.protos[i] = readFunction(r)

  // Informations de debogage : presentes seulement si le chunk n'est pas strippe.
  const lineCount = r.int()
  r.need(lineCount * 4)
  r.pos += lineCount * 4
  const localCount = r.int()
  for (let i = 0; i < localCount; i++) { r.string(); r.int(); r.int() }
  const upvalNames = r.int()
  for (let i = 0; i < upvalNames; i++) r.string()

  return proto
}

/** @returns {object} le prototype de la fonction principale */
export function undump(buf) {
  if (!buf.subarray(0, 4).equals(SIGNATURE)) throw new LuaError('ce n\'est pas un chunk Lua compile')

  const r = new Reader(buf)
  r.pos = 4
  const version = r.byte()
  if (version !== VERSION_51) {
    throw new LuaError(
      `bytecode Lua 0x${version.toString(16)} non gere (seul Lua 5.1 l'est). ` +
      `LuaJIT et Lua 5.2+ utilisent d'autres formats.`
    )
  }
  const format = r.byte()
  if (format !== 0) throw new LuaError(`format de bytecode non standard (${format})`)
  r.littleEndian = r.byte() === 1
  const sizeInt = r.byte()
  r.sizeT = r.byte()
  const sizeInstruction = r.byte()
  const sizeNumber = r.byte()
  const integral = r.byte()

  if (sizeInt !== 4 || sizeInstruction !== 4) {
    throw new LuaError(`tailles inattendues (int ${sizeInt}, instruction ${sizeInstruction})`)
  }
  if (integral !== 0 || sizeNumber !== 8) {
    throw new LuaError(`les nombres ne sont pas des doubles 64 bits (taille ${sizeNumber}, entier ${integral})`)
  }

  return readFunction(r)
}

// --- tables Lua ------------------------------------------------------------

export class LuaTable {
  constructor() {
    this.hash = new Map()
  }

  static key(k) {
    // En Lua, t[1] et t[1.0] designent la meme case.
    if (typeof k === 'number' && Number.isInteger(k)) return k
    return k
  }

  get(k) {
    const v = this.hash.get(LuaTable.key(k))
    return v === undefined ? null : v
  }

  set(k, v) {
    if (k === null) throw new LuaError('cle de table nulle')
    if (v === null) this.hash.delete(LuaTable.key(k))
    else this.hash.set(LuaTable.key(k), v)
  }

  /** Longueur au sens de Lua : la partie sequentielle depuis 1. */
  get length() {
    let n = 0
    while (this.hash.has(n + 1)) n++
    return n
  }
}

// --- machine virtuelle -----------------------------------------------------

const OP = {
  MOVE: 0, LOADK: 1, LOADBOOL: 2, LOADNIL: 3, GETUPVAL: 4, GETGLOBAL: 5, GETTABLE: 6,
  SETGLOBAL: 7, SETUPVAL: 8, SETTABLE: 9, NEWTABLE: 10, SELF: 11, ADD: 12, SUB: 13,
  MUL: 14, DIV: 15, MOD: 16, POW: 17, UNM: 18, NOT: 19, LEN: 20, CONCAT: 21, JMP: 22,
  EQ: 23, LT: 24, LE: 25, TEST: 26, TESTSET: 27, CALL: 28, TAILCALL: 29, RETURN: 30,
  FORLOOP: 31, FORPREP: 32, TFORLOOP: 33, SETLIST: 34, CLOSE: 35, CLOSURE: 36, VARARG: 37,
}

const FIELDS_PER_FLUSH = 50

const isFalse = (v) => v === null || v === false

function toNumber(v) {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = Number(v.trim())
    if (!Number.isNaN(n)) return n
  }
  throw new LuaError(`operation arithmetique sur ${typeName(v)}`)
}

function typeName(v) {
  if (v === null) return 'nil'
  if (typeof v === 'boolean') return 'boolean'
  if (typeof v === 'number') return 'number'
  if (typeof v === 'string') return 'string'
  if (v instanceof LuaTable) return 'table'
  return 'function'
}

/** Rendu Lua d'un nombre : 3 et non 3.0, comme le fait tostring(). */
function numberToString(n) {
  if (Number.isInteger(n)) return String(n)
  return String(n)
}

export function luaToString(v) {
  if (v === null) return 'nil'
  if (typeof v === 'number') return numberToString(v)
  if (typeof v === 'boolean') return String(v)
  if (typeof v === 'string') return v
  return typeName(v)
}

class Closure {
  constructor(proto, upvals) {
    this.proto = proto
    this.upvals = upvals
  }
}

/**
 * Interprete un prototype Lua 5.1.
 *
 * Simplification assumee : les upvalues restent ouvertes (elles pointent vers
 * le tableau de registres de l'appel qui les a creees, maintenu en vie par le
 * ramasse-miettes de JS). CLOSE est donc sans effet. Les fichiers de donnees
 * n'exploitent pas la difference ; un vrai interprete Lua devrait la traiter.
 */
class Vm {
  constructor(env, { maxSteps = 50_000_000 } = {}) {
    this.env = env
    this.steps = 0
    this.maxSteps = maxSteps
    /** Fonctions attendues du client de jeu et absentes ici. */
    this.missing = new Set()
    // Toutes les tables construites pendant l'execution. Les fichiers de
    // donnees declarent parfois leur table en local : elle n'apparait alors
    // dans aucune globale, alors qu'elle contient tout ce qu'on cherche.
    this.tables = []
  }

  call(fn, args, name) {
    if (typeof fn === 'function') return fn(...args) ?? [null]
    if (fn instanceof Closure) return this.execute(fn, args)
    // Les fichiers de donnees appellent des fonctions fournies par le client
    // (itemInfo.lub finit par main(), qui appelle AddItem). Les rendre fatales
    // ferait perdre la table deja construite : on les note et on continue.
    if (fn === null) {
      this.missing.add(name || 'fonction inconnue')
      return [null]
    }
    throw new LuaError(`tentative d'appel sur ${typeName(fn)}`)
  }

  execute(closure, args) {
    const { proto } = closure
    const code = proto.code
    const K = proto.constants
    const R = new Array(Math.max(proto.maxStack, 2) + 1).fill(null)

    for (let i = 0; i < proto.paramCount; i++) R[i] = args[i] ?? null
    const varargs = proto.isVararg ? args.slice(proto.paramCount) : []

    let pc = 0
    let top = proto.paramCount

    const RK = (x) => (x >= 256 ? K[x - 256] : R[x])

    for (;;) {
      if (++this.steps > this.maxSteps) throw new LuaError('trop d\'instructions : boucle probable')
      const ins = code[pc++]
      if (ins === undefined) return []
      const op = ins & 0x3f
      const a = (ins >>> 6) & 0xff
      const b = (ins >>> 23) & 0x1ff
      const c = (ins >>> 14) & 0x1ff
      const bx = (ins >>> 14) & 0x3ffff
      const sbx = bx - 131071

      switch (op) {
        case OP.MOVE: R[a] = R[b]; break
        case OP.LOADK: R[a] = K[bx]; break
        case OP.LOADBOOL: R[a] = b !== 0; if (c !== 0) pc++; break
        case OP.LOADNIL: for (let i = a; i <= b; i++) R[i] = null; break
        case OP.GETUPVAL: R[a] = closure.upvals[b].get(); break
        case OP.SETUPVAL: closure.upvals[b].set(R[a]); break
        case OP.GETGLOBAL: R[a] = this.env.get(K[bx]); break
        case OP.SETGLOBAL: this.env.set(K[bx], R[a]); break

        case OP.GETTABLE: {
          const t = R[b]
          if (!(t instanceof LuaTable)) throw new LuaError(`indexation de ${typeName(t)}`)
          R[a] = t.get(RK(c))
          break
        }
        case OP.SETTABLE: {
          const t = R[a]
          if (!(t instanceof LuaTable)) throw new LuaError(`affectation dans ${typeName(t)}`)
          t.set(RK(b), RK(c))
          break
        }
        case OP.NEWTABLE: R[a] = new LuaTable(); this.tables.push(R[a]); break
        case OP.SELF: {
          const t = R[b]
          R[a + 1] = t
          if (!(t instanceof LuaTable)) throw new LuaError(`appel de methode sur ${typeName(t)}`)
          R[a] = t.get(RK(c))
          break
        }

        case OP.ADD: R[a] = toNumber(RK(b)) + toNumber(RK(c)); break
        case OP.SUB: R[a] = toNumber(RK(b)) - toNumber(RK(c)); break
        case OP.MUL: R[a] = toNumber(RK(b)) * toNumber(RK(c)); break
        case OP.DIV: R[a] = toNumber(RK(b)) / toNumber(RK(c)); break
        case OP.MOD: {
          const x = toNumber(RK(b))
          const y = toNumber(RK(c))
          R[a] = x - Math.floor(x / y) * y // semantique Lua, pas celle de C
          break
        }
        case OP.POW: R[a] = Math.pow(toNumber(RK(b)), toNumber(RK(c))); break
        case OP.UNM: R[a] = -toNumber(R[b]); break
        case OP.NOT: R[a] = isFalse(R[b]); break
        case OP.LEN: {
          const v = R[b]
          if (typeof v === 'string') R[a] = v.length
          else if (v instanceof LuaTable) R[a] = v.length
          else throw new LuaError(`longueur de ${typeName(v)}`)
          break
        }
        case OP.CONCAT: {
          let out = ''
          for (let i = b; i <= c; i++) {
            const v = R[i]
            if (typeof v !== 'string' && typeof v !== 'number') {
              throw new LuaError(`concatenation avec ${typeName(v)}`)
            }
            out += luaToString(v)
          }
          R[a] = out
          break
        }

        case OP.JMP: pc += sbx; break
        case OP.EQ: {
          const cond = luaEquals(RK(b), RK(c))
          if (cond === (a !== 0)) pc += (code[pc] >>> 14 & 0x3ffff) - 131071
          pc++
          break
        }
        case OP.LT: {
          const cond = luaLess(RK(b), RK(c))
          if (cond === (a !== 0)) pc += (code[pc] >>> 14 & 0x3ffff) - 131071
          pc++
          break
        }
        case OP.LE: {
          const cond = luaLess(RK(b), RK(c)) || luaEquals(RK(b), RK(c))
          if (cond === (a !== 0)) pc += (code[pc] >>> 14 & 0x3ffff) - 131071
          pc++
          break
        }
        case OP.TEST: {
          if (isFalse(R[a]) !== (c !== 0)) pc += (code[pc] >>> 14 & 0x3ffff) - 131071
          pc++
          break
        }
        case OP.TESTSET: {
          if (isFalse(R[b]) !== (c !== 0)) {
            R[a] = R[b]
            pc += (code[pc] >>> 14 & 0x3ffff) - 131071
          }
          pc++
          break
        }

        case OP.CALL: case OP.TAILCALL: {
          const argCount = b === 0 ? top - a - 1 : b - 1
          const callArgs = R.slice(a + 1, a + 1 + argCount)
          const results = this.call(R[a], callArgs, calleeName(code, pc - 2, K)) || []
          const wanted = c - 1
          if (op === OP.TAILCALL) return results
          if (wanted === -1) {
            for (let i = 0; i < results.length; i++) R[a + i] = results[i]
            top = a + results.length
          } else {
            for (let i = 0; i < wanted; i++) R[a + i] = results[i] ?? null
          }
          break
        }
        case OP.RETURN: {
          const count = b === 0 ? top - a : b - 1
          return R.slice(a, a + count)
        }

        case OP.FORPREP: R[a] = toNumber(R[a]) - toNumber(R[a + 2]); pc += sbx; break
        case OP.FORLOOP: {
          const step = toNumber(R[a + 2])
          const idx = toNumber(R[a]) + step
          R[a] = idx
          const limit = toNumber(R[a + 1])
          if (step > 0 ? idx <= limit : idx >= limit) { pc += sbx; R[a + 3] = idx }
          break
        }
        case OP.TFORLOOP: {
          const results = this.call(R[a], [R[a + 1], R[a + 2]]) || []
          for (let i = 0; i < c; i++) R[a + 3 + i] = results[i] ?? null
          if (R[a + 3] !== null) R[a + 2] = R[a + 3]
          else pc++
          break
        }

        case OP.SETLIST: {
          const t = R[a]
          if (!(t instanceof LuaTable)) throw new LuaError('SETLIST hors table')
          let count = b
          let batch = c
          if (batch === 0) batch = code[pc++] // le lot est stocke dans l'instruction suivante
          if (count === 0) count = top - a - 1
          for (let i = 1; i <= count; i++) t.set((batch - 1) * FIELDS_PER_FLUSH + i, R[a + i])
          break
        }
        case OP.CLOSE: break // upvalues laissees ouvertes, cf. commentaire de classe

        case OP.CLOSURE: {
          const child = proto.protos[bx]
          const upvals = []
          for (let i = 0; i < child.upvalCount; i++) {
            const pseudo = code[pc++]
            const pseudoOp = pseudo & 0x3f
            const pseudoB = (pseudo >>> 23) & 0x1ff
            if (pseudoOp === OP.MOVE) {
              const index = pseudoB
              upvals.push({ get: () => R[index], set: (v) => { R[index] = v } })
            } else {
              upvals.push(closure.upvals[pseudoB])
            }
          }
          R[a] = new Closure(child, upvals)
          break
        }

        case OP.VARARG: {
          const wanted = b - 1
          if (wanted === -1) {
            for (let i = 0; i < varargs.length; i++) R[a + i] = varargs[i]
            top = a + varargs.length
          } else {
            for (let i = 0; i < wanted; i++) R[a + i] = varargs[i] ?? null
          }
          break
        }

        default:
          throw new LuaError(`opcode inconnu : ${op}`)
      }
    }
  }
}

/**
 * Nom de la fonction appelee, retrouve dans l'instruction qui l'a chargee.
 * Sert uniquement aux messages : sans lui, "appel sur nil" n'aide personne.
 */
function calleeName(code, from, K) {
  for (let i = from; i >= 0 && i > from - 6; i--) {
    const ins = code[i]
    if (ins === undefined) continue
    if ((ins & 0x3f) === OP.GETGLOBAL) {
      const k = K[(ins >>> 14) & 0x3ffff]
      if (typeof k === 'string') return k
    }
  }
  return null
}

function luaEquals(x, y) {
  if (x === null && y === null) return true
  return x === y
}

function luaLess(x, y) {
  if (typeof x === 'number' && typeof y === 'number') return x < y
  if (typeof x === 'string' && typeof y === 'string') return x < y
  throw new LuaError(`comparaison entre ${typeName(x)} et ${typeName(y)}`)
}

// --- environnement minimal -------------------------------------------------

/**
 * Bibliotheque standard reduite a ce que des fichiers de donnees utilisent.
 * Tout ce qui manque remonte comme une erreur explicite plutot que de produire
 * silencieusement des donnees fausses.
 */
function makeEnv() {
  const env = new LuaTable()
  const table = new LuaTable()
  const string = new LuaTable()
  const math = new LuaTable()

  table.set('insert', (t, a, b) => {
    if (b === undefined) t.set(t.length + 1, a)
    else {
      for (let i = t.length; i >= a; i--) t.set(i + 1, t.get(i))
      t.set(a, b)
    }
    return [null]
  })
  table.set('getn', (t) => [t.length])
  table.set('remove', (t, pos) => {
    const n = t.length
    const index = pos === undefined ? n : pos
    const removed = t.get(index)
    for (let i = index; i < n; i++) t.set(i, t.get(i + 1))
    t.set(n, null)
    return [removed]
  })
  table.set('concat', (t, sep) => {
    const parts = []
    for (let i = 1; i <= t.length; i++) parts.push(luaToString(t.get(i)))
    return [parts.join(sep === undefined || sep === null ? '' : sep)]
  })

  string.set('format', (fmt, ...args) => {
    let i = 0
    return [String(fmt).replace(/%[-0-9.]*([sdifg%])/g, (m, kind) => {
      if (kind === '%') return '%'
      const v = args[i++]
      if (kind === 's') return luaToString(v)
      if (kind === 'd' || kind === 'i') return String(Math.floor(toNumber(v)))
      return String(toNumber(v))
    })]
  })
  string.set('sub', (s, from, to) => {
    const str = String(s)
    const start = from < 0 ? str.length + from : from - 1
    const end = to === undefined || to === null ? str.length : (to < 0 ? str.length + to + 1 : to)
    return [str.slice(Math.max(0, start), end)]
  })
  string.set('len', (s) => [String(s).length])
  string.set('upper', (s) => [String(s).toUpperCase()])
  string.set('lower', (s) => [String(s).toLowerCase()])
  string.set('rep', (s, n) => [String(s).repeat(Math.max(0, Math.floor(toNumber(n))))])

  math.set('floor', (x) => [Math.floor(toNumber(x))])
  math.set('ceil', (x) => [Math.ceil(toNumber(x))])
  math.set('max', (...xs) => [Math.max(...xs.map(toNumber))])
  math.set('min', (...xs) => [Math.min(...xs.map(toNumber))])
  math.set('abs', (x) => [Math.abs(toNumber(x))])
  math.set('huge', Infinity)

  env.set('table', table)
  env.set('string', string)
  env.set('math', math)

  env.set('type', (v) => [typeName(v)])
  env.set('tostring', (v) => [luaToString(v)])
  env.set('tonumber', (v) => {
    if (typeof v === 'number') return [v]
    const n = Number(String(v).trim())
    return [Number.isNaN(n) ? null : n]
  })
  env.set('rawget', (t, k) => [t.get(k)])
  env.set('rawset', (t, k, v) => { t.set(k, v); return [t] })
  env.set('rawequal', (x, y) => [luaEquals(x, y)])
  env.set('setmetatable', (t) => [t]) // les metatables ne portent pas de donnees ici
  env.set('getmetatable', () => [null])
  env.set('print', () => [null])
  env.set('require', () => [null]) // les dependances sont chargees separement
  env.set('assert', (v) => [v])
  env.set('unpack', (t) => {
    const out = []
    for (let i = 1; i <= t.length; i++) out.push(t.get(i))
    return out
  })

  const iterate = (t, control, keys) => {
    const index = keys.indexOf(control) + 1
    if (index >= keys.length) return [null]
    const key = keys[index]
    return [key, t.get(key)]
  }
  env.set('pairs', (t) => {
    const keys = [...t.hash.keys()]
    return [(tbl, control) => iterate(tbl, control, keys), t, null]
  })
  env.set('ipairs', (t) => [
    (tbl, i) => {
      const next = (i ?? 0) + 1
      const v = tbl.get(next)
      return v === null ? [null] : [next, v]
    },
    t,
    0,
  ])
  env.set('next', (t, control) => iterate(t, control ?? null, [null, ...t.hash.keys()]))

  return env
}

// --- API -------------------------------------------------------------------

/**
 * Execute un chunk compile et renvoie les globales qu'il a definies.
 *
 * @param {Buffer} buf
 * @param {{env?: LuaTable, maxSteps?: number}} options
 * @returns {{env: LuaTable, error: string|null, missing: string[], tables: LuaTable[]}}
 *   `error` non nul signale une execution interrompue : les globales deja posees
 *   restent exploitables. `missing` liste les fonctions du client appelees en
 *   vain. `tables` contient toutes les tables construites, y compris locales.
 */
export function runCompiled(buf, { env = makeEnv(), maxSteps } = {}) {
  const proto = undump(buf)
  const vm = new Vm(env, { maxSteps })
  try {
    vm.call(new Closure(proto, []), [])
    return { env, error: null, missing: [...vm.missing], tables: vm.tables }
  } catch (err) {
    if (err instanceof LuaError || err instanceof RangeError || err instanceof TypeError) {
      return { env, error: err.message, missing: [...vm.missing], tables: vm.tables }
    }
    throw err
  }
}

export { makeEnv }

/**
 * Convertit une valeur Lua en valeur JS ordinaire, dans la forme attendue par
 * les parseurs : les tables deviennent des objets aux cles textuelles.
 *
 * @param {(s: string) => string} decodeString applique aux chaines, pour
 *   traduire les octets bruts (UTF-8 ou CP949 selon le client).
 */
export function toPlain(value, decodeString = (s) => s, seen = new Map()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return decodeString(value)
  if (value instanceof LuaTable) {
    if (seen.has(value)) return seen.get(value)
    const out = {}
    seen.set(value, out)
    for (const [k, v] of value.hash) {
      const key = typeof k === 'string' ? decodeString(k) : String(k)
      out[key] = toPlain(v, decodeString, seen)
    }
    return out
  }
  return null // fonctions : sans interet pour l'extraction
}

/**
 * Convertit plusieurs tables en partageant la memoisation : les sous-tables
 * communes ne sont converties qu'une fois, et les references restent partagees
 * cote JS comme elles l'etaient cote Lua.
 */
export function toPlainAll(tables, decodeString = (s) => s) {
  const seen = new Map()
  return tables.map((t) => toPlain(t, decodeString, seen))
}
