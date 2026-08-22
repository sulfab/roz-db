import { toArray } from '../lua.mjs'
import { loadLua } from '../luadata.mjs'

/**
 * Fichiers de navigation (data/luafiles514/lua files/navigation/navi_mob_*.lub).
 *
 * C'est la seule source *cliente* qui relie un mob a une carte : le client s'en
 * sert pour la boussole "aller au monstre". Chaque ligne est un tuple positionnel
 * du genre { carte, idMob, nom, niveau, nombre, ... } — mais l'ordre des colonnes
 * change selon les versions et les serveurs. Plutot que de le supposer, on le
 * deduit des donnees, et on rend compte de ce qu'on a deduit.
 */

/** Trouve les fichiers navi_mob_* presents dans le client. */
export function findNaviMobFiles(vfs) {
  return vfs
    .list((key) => /navi_mob[^/]*\.(lub|lua)$/.test(key))
    .map((e) => e.name)
}

/**
 * Le client livre le meme jeu de spawns en 19 langues. Les lire tous
 * multiplierait chaque population par 19 : on n'en garde qu'un, celui dont les
 * noms de mobs seront lisibles.
 *
 * @param {string[]} files
 * @param {string} language suffixe prefere (frfr, enus, kokr...)
 * @returns {{file: string|null, alternatives: string[]}}
 */
export function pickNaviFile(files, language = 'frfr') {
  if (!files.length) return { file: null, alternatives: [] }

  const suffix = (name) => {
    const m = /navi_mob(?:_([a-z]+))?\.(?:lub|lua)$/i.exec(name.replace(/\\/g, '/'))
    return m ? (m[1] || '') : null
  }

  // Ordre de preference : la langue demandee, puis l'anglais, puis le fichier
  // sans suffixe (le defaut du client), puis le coreen d'origine.
  const preference = [language, 'enus', '', 'krpri', 'kokr']
  for (const wanted of preference) {
    const found = files.find((f) => suffix(f) === wanted)
    if (found) return { file: found, alternatives: files.filter((f) => f !== found) }
  }
  return { file: files[0], alternatives: files.slice(1) }
}

const isInt = (v) => typeof v === 'number' && Number.isInteger(v)

/**
 * Deduit le role de chaque colonne a partir de l'ensemble des lignes.
 *
 * - carte   : la colonne texte qui matche le plus les cartes connues
 * - idMob   : la colonne entiere qui matche le plus les ids de mobs connus
 * - sprite  : la colonne texte qui matche les sprites connus (jobname.lub) ;
 *             c'est elle qui donne l'identifiant du mob quand le fichier n'en
 *             contient pas, ce qui est le cas des fichiers de chaines
 * - nom     : la colonne texte restante la plus riche
 * - niveau  : parmi les colonnes entieres restantes, celle dont la valeur est
 *             *stable pour un meme mob* (le niveau ne change pas d'une carte a
 *             l'autre, le nombre de spawns si)
 * - nombre  : l'autre
 */
export function inferColumns(rows, {
  knownMaps = new Set(), knownMobIds = new Set(), knownSprites = new Set(),
} = {}) {
  const width = Math.max(...rows.map((r) => r.length))
  const stats = []

  for (let c = 0; c < width; c++) {
    const values = rows.map((r) => r[c])
    const strings = values.filter((v) => typeof v === 'string')
    const ints = values.filter(isInt)
    stats.push({
      index: c,
      strings: strings.length / rows.length,
      ints: ints.length / rows.length,
      mapHits: strings.filter((v) => knownMaps.has(v.toLowerCase())).length / rows.length,
      mobHits: ints.filter((v) => knownMobIds.has(v)).length / rows.length,
      spriteHits: strings.filter((v) => knownSprites.has(v.toUpperCase())).length / rows.length,
      distinctStrings: new Set(strings).size,
      min: ints.length ? Math.min(...ints) : null,
      max: ints.length ? Math.max(...ints) : null,
    })
  }

  const columns = { map: -1, id: -1, sprite: -1, name: -1, level: -1, amount: -1 }
  const confidence = {}

  // Carte : matching avec mapnametable, sinon la colonne texte qui ressemble a
  // un identifiant technique (minuscules, chiffres, underscore).
  const mapCandidate = stats.filter((s) => s.strings > 0.8).sort((a, b) => b.mapHits - a.mapHits)[0]
  if (mapCandidate && mapCandidate.mapHits > 0.5) {
    columns.map = mapCandidate.index
    confidence.map = mapCandidate.mapHits
  } else {
    const technical = stats
      .filter((s) => s.strings > 0.8)
      .map((s) => ({
        s,
        ratio: rows.filter((r) => typeof r[s.index] === 'string' && /^[a-z0-9_@-]+$/.test(r[s.index])).length / rows.length,
      }))
      .sort((a, b) => b.ratio - a.ratio)[0]
    if (technical && technical.ratio > 0.8) {
      columns.map = technical.s.index
      confidence.map = technical.ratio
    }
  }

  // Id du mob : matching avec npcidentity, sinon un entier >= 1000 partout.
  const idCandidate = stats.filter((s) => s.ints > 0.9).sort((a, b) => b.mobHits - a.mobHits)[0]
  if (idCandidate && idCandidate.mobHits > 0.5) {
    columns.id = idCandidate.index
    confidence.id = idCandidate.mobHits
  } else {
    const big = stats.filter((s) => s.ints > 0.9 && s.min >= 1000 && s.max < 100000)
      .sort((a, b) => a.index - b.index)[0]
    if (big) { columns.id = big.index; confidence.id = 0.4 }
  }

  // Sprite : la colonne texte qui correspond aux sprites connus du client.
  const spriteCandidate = stats
    .filter((s) => s.strings > 0.8 && s.index !== columns.map)
    .sort((a, b) => b.spriteHits - a.spriteHits)[0]
  if (spriteCandidate && spriteCandidate.spriteHits > 0.5) {
    columns.sprite = spriteCandidate.index
    confidence.sprite = spriteCandidate.spriteHits
  }

  // Nom : la colonne texte restante avec le plus de valeurs distinctes.
  const nameCandidate = stats
    .filter((s) => s.strings > 0.8 && s.index !== columns.map && s.index !== columns.sprite)
    .sort((a, b) => b.distinctStrings - a.distinctStrings)[0]
  if (nameCandidate) {
    columns.name = nameCandidate.index
    confidence.name = 1
  }

  // Niveau vs nombre : le niveau est constant pour un mob donne.
  const numeric = stats.filter(
    (s) => s.ints > 0.9 && s.index !== columns.id && s.min !== null && s.min >= 0 && s.max <= 1000
  )
  if (columns.id >= 0 && numeric.length) {
    const scored = numeric.map((s) => ({ s, stability: stabilityPerMob(rows, columns.id, s.index) }))
    scored.sort((a, b) => b.stability - a.stability)
    const level = scored[0]
    if (level && level.stability > 0.9) {
      columns.level = level.s.index
      confidence.level = level.stability
      const rest = scored.slice(1).filter((x) => x.s.max >= 1)
      if (rest.length) {
        columns.amount = rest[0].s.index
        confidence.amount = 1 - rest[0].stability
      }
    } else if (numeric.length) {
      columns.amount = numeric[0].index
      confidence.amount = 0.3
    }
  }

  return { columns, confidence, width }
}

/** Part des mobs pour lesquels la colonne prend toujours la meme valeur. */
function stabilityPerMob(rows, idIndex, valueIndex) {
  const seen = new Map()
  for (const row of rows) {
    const id = row[idIndex]
    const value = row[valueIndex]
    if (!isInt(id) || !isInt(value)) continue
    if (!seen.has(id)) seen.set(id, new Set())
    seen.get(id).add(value)
  }
  if (!seen.size) return 0
  let stable = 0
  for (const values of seen.values()) if (values.size === 1) stable++
  return stable / seen.size
}

/** Recupere toutes les listes de tuples plats d'un environnement Lua. */
function collectRows(env) {
  const rows = []
  const visit = (value, depth) => {
    if (depth > 3 || !value || typeof value !== 'object') return
    const items = toArray(value)
    if (items.length > 20 && items.every((v) => v && typeof v === 'object')) {
      for (const item of items) {
        const tuple = toArray(item)
        if (tuple.length >= 2 && tuple.every((v) => v === null || typeof v !== 'object')) rows.push(tuple)
      }
      if (rows.length) return
    }
    for (const child of Object.values(value)) visit(child, depth + 1)
  }
  visit(env, 0)
  return rows
}

/**
 * @returns {{spawns: Array<{map: string, mobId: number, name?: string, level?: number, amount: number}>,
 *            columns: object, confidence: object, warnings: string[], files: string[]}}
 */
export function extractSpawns(vfs, {
  encoding = 'auto', knownMaps = new Set(), knownMobIds = new Set(),
  knownSprites = new Map(), language = 'frfr',
} = {}) {
  const warnings = []
  const available = findNaviMobFiles(vfs)
  const spawns = []

  if (!available.length) {
    warnings.push(
      'Aucun fichier navi_mob_*.lub dans le client : pas de lien mob -> carte. ' +
      'Les zones resteront vides tant qu\'une autre source ne les fournit pas.'
    )
    return { spawns, columns: null, confidence: null, warnings, files: [], available, hasAmounts: false }
  }

  // Les fichiers de langue ne portent que des chaines (Navi_Mob_strings) ; la
  // structure complete, quand elle existe, est dans le fichier sans suffixe.
  // On ne suppose pas lequel est le bon : on lit les candidats et on garde le
  // plus riche.
  const spriteSet = new Set([...knownSprites.keys()].map((k) => k.toUpperCase()))
  const candidates = [...new Set([
    pickNaviFile(available, language).file,
    available.find((f) => /navi_mob\.(lub|lua)$/i.test(f.replace(/\\/g, '/'))),
    available.find((f) => /navi_mob_data\.(lub|lua)$/i.test(f.replace(/\\/g, '/'))),
  ].filter(Boolean))]

  let best = null
  for (const file of candidates) {
    const buf = vfs.read(file)
    if (!buf) continue
    let env
    try {
      const result = loadLua(buf, { encoding })
      for (const w of result.warnings) warnings.push(`${file} : ${w}`)
      env = result.env
    } catch (err) {
      warnings.push(`${file} : ${err.message}`)
      continue
    }

    const rows = collectRows(env)
    if (rows.length < 10) {
      warnings.push(`${file} : structure inattendue (${rows.length} lignes exploitables)`)
      continue
    }

    const inferred = inferColumns(rows, { knownMaps, knownMobIds, knownSprites: spriteSet })
    const c = inferred.columns
    // Un fichier vaut par ce qu'il permet. Identifier le mob compte une fois :
    // par son id ou par son sprite, c'est le meme service rendu, et les
    // cumuler ferait passer un fichier sans noms devant un fichier complet.
    const identifies = c.id >= 0 || c.sprite >= 0 ? 4 : 0
    const score = identifies + (c.map >= 0 ? 3 : 0) + (c.name >= 0 ? 2 : 0) +
      (c.amount >= 0 ? 2 : 0) + (c.level >= 0 ? 1 : 0)
    if (!best || score > best.score) best = { file, rows, ...inferred, score }
  }

  if (!best || best.columns.map < 0 || (best.columns.id < 0 && best.columns.sprite < 0)) {
    const sample = best ? best.rows.slice(0, 3).map((r) => JSON.stringify(r)).join(' ') : ''
    warnings.push(
      `Aucun fichier de navigation exploitable parmi ${candidates.length} candidat(s)` +
      (sample ? ` (exemples : ${sample})` : '') +
      `. Lance \`npm run dump\` sur l'un d'eux et envoie la sortie.`
    )
    return { spawns, columns: best ? best.columns : null, confidence: null, warnings, files: [], available, hasAmounts: false }
  }

  const { columns, rows, file } = best
  let unresolved = 0

  for (const row of rows) {
    const map = row[columns.map]
    if (typeof map !== 'string') continue

    let mobId = columns.id >= 0 && isInt(row[columns.id]) ? row[columns.id] : null
    if (mobId === null && columns.sprite >= 0) {
      const sprite = row[columns.sprite]
      if (typeof sprite === 'string') mobId = knownSprites.get(sprite.toUpperCase()) ?? null
    }
    if (mobId === null) { unresolved++; continue }

    spawns.push({
      map: map.toLowerCase(),
      mobId,
      name: columns.name >= 0 && typeof row[columns.name] === 'string' ? row[columns.name] : undefined,
      level: columns.level >= 0 && isInt(row[columns.level]) ? row[columns.level] : undefined,
      // Sans colonne de population, on ne connait que la presence : ne pas
      // inventer un nombre qui serait pris pour une mesure.
      amount: columns.amount >= 0 && isInt(row[columns.amount]) ? row[columns.amount] : null,
    })
  }

  if (unresolved) {
    warnings.push(
      `${file} : ${unresolved} ligne(s) sur ${rows.length} sans mob identifiable ` +
      `(sprite absent de jobname.lub).`
    )
  }
  if (columns.amount < 0) {
    warnings.push(
      `${file} ne contient pas de population : les zones indiquent la presence ` +
      `d'un monstre, pas son nombre.`
    )
  }

  return {
    spawns,
    columns,
    confidence: best.confidence,
    warnings,
    files: [file],
    available,
    hasAmounts: columns.amount >= 0,
  }
}
