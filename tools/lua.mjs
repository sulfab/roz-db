/**
 * Parseur Lua tolerant, taille pour les fichiers de donnees du client RO.
 *
 * Il n'execute pas du Lua : il lit les affectations de haut niveau et evalue
 * les expressions litterales (tables, chaines, nombres, concatenations,
 * references a des constantes deja definies). Tout ce qu'il ne comprend pas
 * (fonctions, boucles, conditions) est saute proprement au lieu de faire
 * echouer le fichier entier.
 *
 * Les tables Lua deviennent des objets JS dont les cles sont des chaines ;
 * la partie tableau utilise les cles "1", "2", ... comme en Lua.
 */

const KEYWORDS = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function',
  'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then',
  'true', 'until', 'while',
])

const OPERATORS = [
  '...', '..', '==', '~=', '<=', '>=', '::',
  '+', '-', '*', '/', '%', '^', '#', '<', '>', '=', '(', ')', '{', '}',
  '[', ']', ';', ':', ',', '.',
]

// Les identifiants des fichiers coreens contiennent parfois des octets hauts.
const NAME_START = /[A-Za-z_-￿]/
const NAME_PART = /[A-Za-z0-9_-￿]/

export class LuaParseError extends Error {}

/** Le client livre parfois du bytecode Lua 5.1 compile : illisible sans decompilateur. */
export function isCompiledLua(buf) {
  return buf.length > 4 && buf[0] === 0x1b && buf[1] === 0x4c && buf[2] === 0x75 && buf[3] === 0x61
}

function tokenize(src) {
  const tokens = []
  let i = 0
  let line = 1
  const n = src.length

  const longBracket = (start) => {
    // [=*[ ... ]=*]  -> renvoie {content, end} ou null
    let p = start
    if (src[p] !== '[') return null
    p++
    let level = 0
    while (src[p] === '=') { level++; p++ }
    if (src[p] !== '[') return null
    p++
    if (src[p] === '\n') { line++; p++ }
    const close = ']' + '='.repeat(level) + ']'
    const end = src.indexOf(close, p)
    if (end < 0) throw new LuaParseError(`long bracket non ferme ligne ${line}`)
    const content = src.slice(p, end)
    for (const c of content) if (c === '\n') line++
    return { content, end: end + close.length }
  }

  while (i < n) {
    const c = src[i]
    if (c === '\n') { line++; i++; continue }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue }

    if (c === '-' && src[i + 1] === '-') {
      i += 2
      const lb = src[i] === '[' ? longBracket(i) : null
      if (lb) { i = lb.end; continue }
      while (i < n && src[i] !== '\n') i++
      continue
    }

    if (c === '"' || c === "'") {
      const quote = c
      i++
      let out = ''
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') {
          const e = src[i + 1]
          i += 2
          if (e === 'n') out += '\n'
          else if (e === 't') out += '\t'
          else if (e === 'r') out += '\r'
          else if (e === 'a') out += '\x07'
          else if (e === 'b') out += '\b'
          else if (e === 'f') out += '\f'
          else if (e === 'v') out += '\v'
          else if (e === '\n') { out += '\n'; line++ }
          else if (e >= '0' && e <= '9') {
            let digits = e
            while (digits.length < 3 && src[i] >= '0' && src[i] <= '9') digits += src[i++]
            out += String.fromCharCode(parseInt(digits, 10))
          } else out += e
        } else {
          if (src[i] === '\n') line++
          out += src[i++]
        }
      }
      i++
      tokens.push({ t: 'str', v: out, line })
      continue
    }

    if (c === '[' && (src[i + 1] === '[' || src[i + 1] === '=')) {
      const lb = longBracket(i)
      if (lb) { tokens.push({ t: 'str', v: lb.content, line }); i = lb.end; continue }
    }

    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const rest = src.slice(i)
      const m = /^0[xX][0-9a-fA-F]+|^[0-9]*\.?[0-9]+([eE][+-]?[0-9]+)?|^[0-9]+\./.exec(rest)
      const text = m[0]
      i += text.length
      tokens.push({ t: 'num', v: Number(text), line })
      continue
    }

    if (NAME_START.test(c)) {
      let j = i
      while (j < n && NAME_PART.test(src[j])) j++
      const word = src.slice(i, j)
      i = j
      tokens.push({ t: KEYWORDS.has(word) ? word : 'name', v: word, line })
      continue
    }

    const op = OPERATORS.find((o) => src.startsWith(o, i))
    if (op) { tokens.push({ t: op, v: op, line }); i += op.length; continue }

    i++ // caractere inconnu : on l'ignore plutot que d'abandonner le fichier
  }
  tokens.push({ t: 'eof', v: null, line })
  return tokens
}

/** Marqueur pour une reference non resolue (constante definie ailleurs). */
export function isRef(v) {
  return v !== null && typeof v === 'object' && typeof v.__ref === 'string'
}

class Parser {
  constructor(tokens, env) {
    this.k = tokens
    this.i = 0
    this.env = env
    this.warnings = []
  }

  peek(offset = 0) { return this.k[this.i + offset] }
  next() { return this.k[this.i++] }
  at(type) { return this.k[this.i].t === type }
  accept(type) { return this.at(type) ? (this.i++, true) : false }
  expect(type) {
    if (!this.at(type)) {
      throw new LuaParseError(`attendu "${type}", trouve "${this.peek().t}" ligne ${this.peek().line}`)
    }
    return this.next()
  }

  // ---- expressions -------------------------------------------------------

  parseExpr() { return this.parseBinary(0) }

  static PRECEDENCE = [
    ['or'], ['and'], ['==', '~=', '<', '>', '<=', '>='], ['..'],
    ['+', '-'], ['*', '/', '%'],
  ]

  parseBinary(level) {
    if (level >= Parser.PRECEDENCE.length) return this.parseUnary()
    let left = this.parseBinary(level + 1)
    for (;;) {
      const op = this.peek().t
      if (!Parser.PRECEDENCE[level].includes(op)) return left
      this.next()
      const right = this.parseBinary(level + 1)
      left = applyBinary(op, left, right)
    }
  }

  parseUnary() {
    if (this.at('-')) { this.next(); const v = this.parseUnary(); return typeof v === 'number' ? -v : null }
    if (this.at('not')) { this.next(); const v = this.parseUnary(); return !v }
    if (this.at('#')) { this.next(); const v = this.parseUnary(); return v && typeof v === 'object' ? Object.keys(v).length : 0 }
    return this.parsePrimary()
  }

  parsePrimary() {
    const tok = this.peek()
    switch (tok.t) {
      case 'nil': this.next(); return null
      case 'true': this.next(); return true
      case 'false': this.next(); return false
      case 'num': this.next(); return tok.v
      case 'str': this.next(); return tok.v
      case '{': return this.parseTable()
      case 'function': this.skipBlock(); return null
      case '...': this.next(); return null
      default: return this.parseSuffixed()
    }
  }

  parseSuffixed() {
    let value
    let path = null
    if (this.accept('(')) {
      value = this.parseExpr()
      this.expect(')')
    } else if (this.at('name')) {
      const name = this.next().v
      path = name
      value = Object.prototype.hasOwnProperty.call(this.env, name) ? this.env[name] : { __ref: name }
    } else {
      this.next()
      return null
    }

    for (;;) {
      if (this.accept('.')) {
        const key = this.expect('name').v
        path = path ? `${path}.${key}` : key
        value = index(value, key, path)
      } else if (this.accept('[')) {
        const key = this.parseExpr()
        this.expect(']')
        path = path ? `${path}[${JSON.stringify(key)}]` : null
        value = index(value, key, path)
      } else if (this.at('(') || this.at('{') || this.at('str')) {
        this.skipCallArgs()
        value = null // appel de fonction : non evaluable
      } else if (this.accept(':')) {
        this.expect('name')
        this.skipCallArgs()
        value = null
      } else {
        return value
      }
    }
  }

  parseTable() {
    this.expect('{')
    const table = {}
    let arrayIndex = 1
    while (!this.at('}') && !this.at('eof')) {
      if (this.accept('[')) {
        const key = this.parseExpr()
        this.expect(']')
        this.expect('=')
        table[keyOf(key)] = this.parseExpr()
      } else if (this.at('name') && this.peek(1).t === '=') {
        const key = this.next().v
        this.next()
        table[key] = this.parseExpr()
      } else {
        table[String(arrayIndex++)] = this.parseExpr()
      }
      if (!this.accept(',') && !this.accept(';')) break
    }
    this.expect('}')
    return table
  }

  skipCallArgs() {
    if (this.at('str')) { this.next(); return }
    if (this.at('{')) { this.parseTable(); return }
    this.expect('(')
    let depth = 1
    while (depth > 0 && !this.at('eof')) {
      const t = this.next().t
      if (t === '(') depth++
      else if (t === ')') depth--
    }
  }

  /** Saute un bloc structure (function/if/for/while/do/repeat) jusqu'a son end. */
  skipBlock() {
    let depth = 0
    let swallowDo = false
    for (;;) {
      const tok = this.next()
      if (tok.t === 'eof') return
      switch (tok.t) {
        case 'function': case 'if': case 'repeat': depth++; break
        case 'for': case 'while': depth++; swallowDo = true; break
        case 'do': if (swallowDo) swallowDo = false; else depth++; break
        case 'end': case 'until':
          depth--
          if (depth <= 0) return
          break
      }
    }
  }

  // ---- instructions ------------------------------------------------------

  parseChunk() {
    while (!this.at('eof')) {
      const before = this.i
      try {
        this.parseStatement()
      } catch (err) {
        if (!(err instanceof LuaParseError)) throw err
        this.warnings.push(err.message)
        this.recover()
      }
      if (this.i === before) this.i++ // garde-fou anti-boucle infinie
    }
    return { env: this.env, warnings: this.warnings }
  }

  /** En cas d'erreur : on saute jusqu'a la prochaine affectation plausible. */
  recover() {
    while (!this.at('eof')) {
      this.i++
      if (this.at('name') && (this.peek(1).t === '=' || this.peek(1).t === '.' || this.peek(1).t === '[')) return
    }
  }

  parseStatement() {
    if (this.accept(';')) return
    const t = this.peek().t

    if (t === 'local') {
      this.next()
      if (this.at('function')) { this.skipBlock(); return }
      return this.parseAssignment()
    }
    if (t === 'function') { this.skipBlock(); return }
    if (t === 'if' || t === 'for' || t === 'while' || t === 'do' || t === 'repeat') {
      this.skipBlock()
      return
    }
    if (t === 'return') { this.next(); if (!this.at('eof') && !this.at('end')) this.parseExpr(); return }
    if (t === 'break' || t === 'end' || t === 'until' || t === 'else' || t === 'elseif' || t === 'then') { this.next(); return }
    if (t === 'name') return this.parseAssignment()
    this.next()
  }

  parseAssignment() {
    const targets = [this.parseTarget()]
    while (this.accept(',')) targets.push(this.parseTarget())

    if (!this.accept('=')) return // appel de fonction isole, deja consomme

    const values = [this.parseExpr()]
    while (this.accept(',')) values.push(this.parseExpr())

    targets.forEach((target, idx) => {
      if (target) assign(this.env, target, values[idx] === undefined ? null : values[idx])
    })
  }

  /** @returns {string[]|null} chemin d'affectation, ou null si ce n'est pas une cible. */
  parseTarget() {
    if (!this.at('name')) { this.parseExpr(); return null }
    const path = [this.next().v]
    for (;;) {
      if (this.accept('.')) path.push(this.expect('name').v)
      else if (this.accept('[')) { path.push(keyOf(this.parseExpr())); this.expect(']') }
      else if (this.at('(') || this.at('{') || this.at('str')) { this.skipCallArgs(); return null }
      else if (this.accept(':')) { this.expect('name'); this.skipCallArgs(); return null }
      else return path
    }
  }
}

function keyOf(value) {
  if (isRef(value)) return value.__ref
  if (value === null || value === undefined) return 'nil'
  return String(value)
}

function index(value, key, path) {
  if (value && typeof value === 'object' && !isRef(value)) {
    const k = keyOf(key)
    return Object.prototype.hasOwnProperty.call(value, k) ? value[k] : null
  }
  return path ? { __ref: path } : null
}

function assign(env, path, value) {
  let node = env
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i]
    if (!node[k] || typeof node[k] !== 'object') node[k] = {}
    node = node[k]
  }
  node[path[path.length - 1]] = value
}

function applyBinary(op, a, b) {
  switch (op) {
    case '..': {
      if (a === null || b === null || typeof a === 'object' || typeof b === 'object') return null
      return `${a}${b}`
    }
    case '+': return num(a) + num(b)
    case '-': return num(a) - num(b)
    case '*': return num(a) * num(b)
    case '/': return num(a) / num(b)
    case '%': return num(a) % num(b)
    case 'and': return a && b
    case 'or': return a || b
    case '==': return a === b
    case '~=': return a !== b
    case '<': return a < b
    case '>': return a > b
    case '<=': return a <= b
    case '>=': return a >= b
    default: return null
  }
}

function num(v) { return typeof v === 'number' ? v : 0 }

/**
 * @param {string} source
 * @param {{env?: object}} [options] env : constantes deja connues (fichiers deja lus)
 * @returns {{env: object, warnings: string[]}}
 */
export function parseLua(source, options = {}) {
  const tokens = tokenize(source)
  return new Parser(tokens, options.env ? { ...options.env } : {}).parseChunk()
}

/** Table Lua -> tableau JS via sa partie sequentielle (cles 1..n). */
export function toArray(table) {
  if (!table || typeof table !== 'object') return []
  const out = []
  for (let i = 1; ; i++) {
    const v = table[String(i)]
    if (v === undefined) break
    out.push(v)
  }
  return out
}

/** Toutes les entrees dont la cle est un entier (ordre croissant). */
export function numericEntries(table) {
  if (!table || typeof table !== 'object') return []
  return Object.entries(table)
    .filter(([k]) => /^-?\d+$/.test(k))
    .map(([k, v]) => [Number(k), v])
    .sort((a, b) => a[0] - b[0])
}
