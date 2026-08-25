/**
 * Lecture des paquets du jeu.
 *
 * Constat qui change tout : le trafic de Ragnarok Zero n'est ni chiffre ni
 * compresse. C'est une suite de paquets bruts, chacun precede d'un numero sur
 * deux octets. On l'a etabli, pas suppose : sur une capture reelle, vingt-neuf
 * paquets s'enchainent sans trou, et le nom du personnage tombe exactement en
 * queue des paquets d'apparition — trois fois de suite, a des endroits que
 * personne n'a choisis.
 *
 * Reste la difficulte connue de ce protocole : la longueur d'un paquet depend
 * de son numero, et la table qui les relie n'est pas publique. Deux reponses,
 * dans cet ordre :
 *  - LONGUEURS contient ce qu'on a verifie sur du trafic reel ;
 *  - inferLength deduit le reste de la capture elle-meme.
 */

/** Au-dela, ce n'est plus un numero de paquet : le protocole n'y monte pas. */
export const MAX_OPCODE = 0x0bff
/** Un paquet ne fait jamais moins que son seul numero. */
const MIN_LENGTH = 2
/** Plafond des longueurs fixes essayees a l'aveugle. */
const MAX_FIXED = 96
/** Profondeur de la verification d'une longueur candidate, en paquets. */
const LOOKAHEAD = 24
/** Ou peut commencer le premier paquet entier d'un flux pris en cours de route. */
const MAX_START = 256

/**
 * Longueurs verifiees sur des captures reelles de Ragnarok Zero Global.
 *
 * Aucune n'est reprise d'une documentation : chacune est celle qui fait tomber
 * le paquet suivant sur un numero valide, de bout en bout de la capture.
 */
export const LONGUEURS = new Map([
  [0x007f, 6],   // horloge du serveur
  [0x0080, 7],   // disparition d'une entite
  [0x0087, 12],  // deplacement du joueur
  [0x0088, 10],  // deplacement d'une entite
  [0x00b0, 8],   // changement d'une caracteristique
  [0x02e1, 33],  // coup porte
  [0x08c8, 34],  // coup porte (forme longue)
  [0x0a36, 7],   // points de vie d'une entite
  [0x0acb, 12],  // gain d'experience
  [0x0acc, 18],  // gain d'experience (avec l'entite)
  [0x0adf, 58],  // reponse a une demande de nom
])

/**
 * Paquets dont la longueur est ecrite a l'octet 2.
 *
 * On ne l'a pas decrete : 0x09fd apparait dans la meme capture avec 95 puis 96
 * octets, et l'ecart correspond exactement au nom en queue de paquet.
 */
export const VARIABLES = new Set([0x09fd, 0x09ff])

const opcodeAt = (data, p) => (p + 2 <= data.length ? data.readUInt16LE(p) : -1)
const validOpcode = (o) => o > 0 && o <= MAX_OPCODE

/** Longueur annoncee dans le paquet lui-meme, si elle est credible. */
function declaredLength(data, pos) {
  if (pos + 4 > data.length) return null
  const len = data.readUInt16LE(pos + 2)
  if (len < 4 || pos + len > data.length) return null
  return len
}

/**
 * Fait avancer le decoupage sans jamais inventer de longueur, et compte les
 * octets couverts par des paquets deja connus.
 *
 * C'est la mesure qui departage les longueurs candidates. Une longueur fausse
 * desynchronise le flux : le paquet suivant tombe sur des octets quelconques,
 * qui ne forment presque jamais un numero connu. Une longueur juste, elle,
 * retombe sur les memes paquets que partout ailleurs dans la capture.
 */
function lookahead(data, pos, lengths, limit = LOOKAHEAD) {
  let covered = 0
  for (let n = 0; n < limit && pos + 2 <= data.length; n++) {
    const op = opcodeAt(data, pos)
    if (!validOpcode(op)) break
    let len = lengths.get(op)
    if (len === undefined && VARIABLES.has(op)) len = declaredLength(data, pos)
    if (len === undefined || len === null || len < MIN_LENGTH || pos + len > data.length) break
    covered += len
    pos += len
  }
  return covered
}

/**
 * Deduit la longueur d'un paquet inconnu.
 *
 * On essaie la longueur annoncee, puis toutes les longueurs fixes plausibles,
 * et on garde celle qui laisse le flux se derouler le plus loin sur des paquets
 * deja identifies. Si deux candidates font aussi bien, on ne tranche pas :
 * mieux vaut s'arreter que decouper au hasard.
 */
export function inferLength(data, pos, lengths) {
  const rest = data.length - pos
  const candidates = []
  const declared = declaredLength(data, pos)
  if (declared !== null) candidates.push(declared)
  for (let len = MIN_LENGTH; len <= MAX_FIXED && len <= rest; len++) {
    if (candidates.includes(len)) continue
    if (pos + len < data.length && !validOpcode(opcodeAt(data, pos + len))) continue
    candidates.push(len)
  }

  // Le score ne compte que ce qui vient apres : la longueur elle-meme n'entre
  // pas en ligne de compte, sans quoi la plus grande gagnerait toujours en
  // avalant le reste du flux.
  let best = null
  let tied = false
  for (const len of candidates) {
    const score = lookahead(data, pos + len, lengths)
    if (!best || score > best.score) { best = { len, score }; tied = false }
    else if (score === best.score) tied = true
  }
  // Un score nul ne prouve rien, et une egalite non plus : mieux vaut s'arreter
  // que decouper au hasard.
  if (!best || tied || best.score <= 0) return null
  return best.len
}

/**
 * Decoupe un flux en paquets a partir d'une position donnee.
 *
 * Les longueurs apprises en chemin sont ajoutees a la table fournie : un paquet
 * inconnu ne coute son inference qu'une fois.
 */
export function framePackets(data, start, lengths) {
  const packets = []
  const learned = new Map()
  let pos = start
  while (pos + 2 <= data.length) {
    const opcode = opcodeAt(data, pos)
    if (!validOpcode(opcode)) break
    // Un paquet a longueur variable porte sa longueur sur deux octets de plus :
    // son contenu commence a +4, celui d'un paquet a longueur fixe a +2.
    const variable = VARIABLES.has(opcode)
    const header = variable ? 4 : 2
    let len = lengths.get(opcode)
    if (len === undefined && variable) len = declaredLength(data, pos)
    if (len === undefined || len === null) {
      len = inferLength(data, pos, lengths)
      if (len === null) break
      lengths.set(opcode, len)
      learned.set(opcode, len)
    }
    if (len < MIN_LENGTH || pos + len > data.length) break
    packets.push({
      offset: pos, opcode, length: len,
      payload: data.subarray(pos + Math.min(header, len), pos + len),
    })
    pos += len
  }
  return { packets, learned, end: pos }
}

/**
 * Decoupe un flux dont on ignore ou commence le premier paquet.
 *
 * Une capture demarree pendant la partie tombe au milieu d'un paquet : on
 * essaie les debuts possibles et on garde celui qui couvre le plus d'octets.
 */
const better = (a, b) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

export function frameStream(data, { lengths = new Map(LONGUEURS) } = {}) {
  // On ne compare pas les departs sur le nombre d'octets couverts : un mauvais
  // alignement peut couvrir tout le flux en s'inventant des longueurs. On les
  // compare sur les octets couverts par des paquets deja connus — ceux-la,
  // aucune inference ne les a fabriques.
  let best = null
  for (let start = 0; start < Math.min(MAX_START, data.length - 2); start++) {
    if (!validOpcode(opcodeAt(data, start))) continue
    const attempt = framePackets(data, start, new Map(lengths))
    const trusted = attempt.packets
      .filter((p) => !attempt.learned.has(p.opcode))
      .reduce((n, p) => n + p.length, 0)
    const covered = attempt.end - start
    // A egalite, le decoupage qui a eu besoin d'inventer le moins l'emporte :
    // un mauvais alignement se paie toujours d'un paquet fabrique.
    const rank = [trusted, -attempt.learned.size, covered]
    if (!best || better(rank, best.rank)) best = { start, covered, trusted, rank, ...attempt }
  }
  if (!best) return { start: 0, packets: [], learned: new Map(), end: 0, covered: 0, coverage: 0 }
  return { ...best, coverage: best.covered / data.length }
}

/**
 * Apparitions : ces paquets decrivent tout ce qui entre dans le champ de vision.
 *
 * On les reconnait a leur forme, pas a leur numero : longueur variable, premier
 * octet du contenu donnant la nature de l'entite, et de quoi loger un identifiant.
 */
export const ENTITY_TYPES = new Map([[0, 'joueur'], [1, 'pnj'], [5, 'monstre'], [6, 'pnj'], [12, 'objet']])
const MIN_ENTRY_LENGTH = 40

export function readEntries(packets) {
  const entries = []
  for (const p of packets) {
    if (!VARIABLES.has(p.opcode) || p.length < MIN_ENTRY_LENGTH) continue
    const type = p.payload[0]
    if (!ENTITY_TYPES.has(type)) continue
    entries.push({
      offset: p.offset,
      type,
      kind: ENTITY_TYPES.get(type),
      aid: p.payload.readUInt32LE(1),
      gid: p.payload.readUInt32LE(5),
      payload: p.payload,
    })
  }
  return entries
}

/**
 * Retrouve ou se cache la classe du monstre dans un paquet d'apparition.
 *
 * La position depend de la version du client, et la supposer donnerait des
 * identifiants faux sans qu'on s'en apercoive. On la deduit : le client nous a
 * deja donne la liste exacte des monstres qui existent, donc on cherche le seul
 * decalage ou toutes les apparitions de monstres tombent sur un monstre connu.
 */
export function inferClassOffset(entries, knownMobIds) {
  const mobs = entries.filter((e) => e.kind === 'monstre')
  if (!mobs.length || !knownMobIds?.size) return null
  const width = Math.min(...mobs.map((e) => e.payload.length))
  let best = null
  for (let off = 0; off + 2 <= width; off++) {
    let hits = 0
    for (const e of mobs) if (knownMobIds.has(e.payload.readUInt16LE(off))) hits++
    if (hits !== mobs.length) continue
    // Plusieurs decalages peuvent coller si tous les monstres vus sont les
    // memes ; on garde le premier et on signale l'ambiguite a l'appelant.
    if (!best) best = { offset: off, hits, ambiguous: false }
    else best.ambiguous = true
  }
  if (!best) return null
  // Avec une seule espece croisee, un decalage peut coller par accident : on
  // dit combien de fois le hasard en produirait, pour que l'appelant en tienne
  // compte au lieu d'annoncer un monstre qu'on n'a pas vraiment identifie.
  const densite = knownMobIds.size / 65536
  best.expectedByChance = width * Math.pow(densite, mobs.length)
  best.solid = best.expectedByChance < BUDGET_HASARD && !best.ambiguous
  return best
}

/** Noms lisibles en queue de paquet : c'est la que le serveur les place. */
const PRINTABLE = /^[\x20-\x7e]+$/
export function trailingName(payload, min = 3) {
  let end = payload.length
  while (end > 0 && payload[end - 1] === 0) end--
  let start = end
  while (start > 0 && payload[start - 1] >= 0x20 && payload[start - 1] <= 0x7e) start--
  const name = payload.subarray(start, end).toString('latin1')
  return name.length >= min && PRINTABLE.test(name) ? name : null
}

/**
 * Cherche le paquet qui annonce un objet tombe au sol.
 *
 * Meme methode que pour la classe du monstre, et pour la meme raison : le
 * numero de ce paquet change d'une version de client a l'autre, alors que
 * l'oracle, lui, ne bouge pas. On retient le paquet dont un champ donne, a
 * position fixe, contient toujours un identifiant d'objet existant.
 */
/** Ce qu'on accepte de voir surgir par hasard, sur toute une capture. */
const BUDGET_HASARD = 0.01

/**
 * Densite de l'oracle sur la seule plage de valeurs observee.
 *
 * La densite globale ment. Les identifiants d'objets d'un client s'etalent de
 * 500 a 20000 avec de gros trous ; un champ qui ne contient jamais que des
 * petits nombres tombe donc dans une zone ou l'oracle est presque plein, et
 * "c'est un objet connu" n'y apprend plus rien. C'est la densite locale, sur
 * l'intervalle reellement rencontre, qui dit ce que la correspondance vaut.
 */
function localDensity(ids, values) {
  const low = Math.min(...values)
  const high = Math.max(...values)
  const span = high - low + 1
  if (span <= 1) return 1
  let inside = 0
  for (const id of ids) if (id >= low && id <= high) inside++
  return Math.min(1, inside / span)
}

export function inferItemPackets(packets, knownItemIds, { minCount = 3 } = {}) {
  if (!knownItemIds?.size) return []
  const byOpcode = new Map()
  for (const p of packets) {
    if (!byOpcode.has(p.opcode)) byOpcode.set(p.opcode, [])
    byOpcode.get(p.opcode).push(p)
  }

  // Nombre de champs examines : c'est le denominateur du calcul de hasard.
  const trials = [...byOpcode.values()]
    .filter((g) => g.length >= minCount)
    .reduce((n, g) => n + 2 * Math.min(...g.map((p) => p.payload.length)), 0) || 1

  const found = []
  for (const [opcode, group] of byOpcode) {
    if (group.length < minCount) continue
    const width = Math.min(...group.map((p) => p.payload.length))
    for (let off = 0; off + 4 <= width; off++) {
      for (const size of [2, 4]) {
        if (off + size > width) continue
        const read = (p) => (size === 2 ? p.payload.readUInt16LE(off) : p.payload.readUInt32LE(off))
        if (!group.every((p) => knownItemIds.has(read(p)))) continue
        // Un champ toujours egal a la meme valeur ne prouve rien : c'est une
        // constante du paquet qui ressemble a un identifiant, pas un objet.
        const distinct = new Set(group.map(read))
        if (distinct.size < 2) continue
        // Une lecture sur quatre octets au meme endroit qu'une lecture sur deux
        // ne dit rien de plus : c'est le meme champ, avec un demi-mot nul.
        if (size === 4 && found.some((f) => f.opcode === opcode && f.offset === off)) continue
        // Combien de champs de ce genre le hasard produirait-il dans cette
        // capture ? Si c'est plus d'un centieme, la correspondance ne prouve rien.
        const values = [...distinct]
        const attendu = trials * Math.pow(localDensity(knownItemIds, values), group.length)
        if (attendu >= BUDGET_HASARD) continue
        found.push({ opcode, offset: off, size, count: group.length, items: values, attendu })
      }
    }
  }
  return found
}
