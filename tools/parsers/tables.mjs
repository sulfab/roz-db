/**
 * Tables texte du client (data/*.txt).
 *
 * Deux formats seulement, mais utilises partout :
 *   - simple      "501#Red Potion#"
 *   - multilignes "501#\nligne 1\nligne 2\n#"
 */

/** "cle#valeur#" -> Map<string, string>. Le premier # separe, le dernier ferme. */
export function parseSimpleTable(text) {
  const out = new Map()
  if (!text) return out
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('//')) continue
    const sep = line.indexOf('#')
    if (sep <= 0) continue
    const key = line.slice(0, sep).trim()
    let value = line.slice(sep + 1)
    if (value.endsWith('#')) value = value.slice(0, -1)
    out.set(key, value)
  }
  return out
}

/**
 * Table de descriptions : un identifiant, puis les lignes, puis un "#" seul.
 * @returns {Map<string, string[]>}
 */
export function parseDescTable(text) {
  const out = new Map()
  if (!text) return out
  const lines = text.split(/\r?\n/)
  let key = null
  let buffer = []
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '')
    if (key === null) {
      const m = /^([^#]+)#\s*$/.exec(line.trim())
      if (m) { key = m[1].trim(); buffer = [] }
      continue
    }
    if (line.trim() === '#') {
      out.set(key, buffer)
      key = null
      continue
    }
    buffer.push(line)
  }
  if (key !== null && buffer.length) out.set(key, buffer)
  return out
}

/** mapnametable.txt : "prontera.rsw#Prontera#" -> Map<"prontera", "Prontera"> */
export function parseMapNameTable(text) {
  const out = new Map()
  for (const [key, value] of parseSimpleTable(text)) {
    const id = key.replace(/\.(rsw|gnd|gat)$/i, '').toLowerCase()
    const name = value.trim()
    if (id && name) out.set(id, name)
  }
  return out
}

/** msgstringtable.txt : une chaine par ligne, indexee a partir de 0. */
export function parseMsgStringTable(text) {
  if (!text) return []
  return text.split(/\r?\n/).map((l) => l.replace(/#$/, ''))
}

/** Retire les codes couleur RO (^RRGGBB) d'un texte. */
export function stripColorCodes(text) {
  return text.replace(/\^[0-9a-fA-F]{6}/g, '')
}
