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
/** Ce qu'il faut lire d'affilee pour croire qu'on s'est bien recale. */
const RESYNC_RUN = 6
const RESYNC_BYTES = 24

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
  //
  // La longueur essayee est ajoutee a la table le temps du calcul. Sans cela un
  // paquet encore inconnu ne pouvait jamais s'amorcer : rien de ce qui le suit
  // n'etant connu non plus, toutes les longueurs marquaient zero. C'est
  // pourtant la sa meilleure preuve — si le meme paquet revient plus loin au
  // pas suppose, c'est que le pas est bon.
  const opcode = opcodeAt(data, pos)
  let best = null
  let tied = false
  for (const len of candidates) {
    const essai = new Map(lengths)
    essai.set(opcode, len)
    const score = lookahead(data, pos + len, essai)
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
export function framePackets(data, start, lengths, { resync = false } = {}) {
  const packets = []
  const learned = new Map()
  const gaps = []
  let pos = start
  while (pos + 2 <= data.length) {
    const opcode = opcodeAt(data, pos)
    if (!validOpcode(opcode)) {
      const next = resync ? resyncFrom(data, pos + 1, lengths) : -1
      if (next < 0) break
      gaps.push({ at: pos, skipped: next - pos })
      pos = next
      continue
    }
    // Un paquet a longueur variable porte sa longueur sur deux octets de plus :
    // son contenu commence a +4, celui d'un paquet a longueur fixe a +2.
    const variable = VARIABLES.has(opcode)
    const header = variable ? 4 : 2
    let len = lengths.get(opcode)
    if (len === undefined && variable) len = declaredLength(data, pos)
    if (len === undefined || len === null) {
      len = inferLength(data, pos, lengths)
    }
    if (len === null || len === undefined || len < MIN_LENGTH || pos + len > data.length) {
      // Un paquet indecidable ne doit pas couter tout le reste du flux : on
      // repart au premier endroit ou le decoupage tient a nouveau, et on
      // compte les octets sautes plutot que de les passer sous silence.
      const next = resync ? resyncFrom(data, pos + 1, lengths) : -1
      if (next < 0) break
      gaps.push({ at: pos, skipped: next - pos })
      pos = next
      continue
    }
    if (!lengths.has(opcode) && !variable) {
      lengths.set(opcode, len)
      learned.set(opcode, len)
    }
    packets.push({
      offset: pos, opcode, length: len,
      payload: data.subarray(pos + Math.min(header, len), pos + len),
    })
    pos += len
  }
  const skipped = gaps.reduce((n, g) => n + g.skipped, 0)
  return { packets, learned, gaps, skipped, end: pos }
}

/**
 * Cherche ou le flux redevient lisible apres un passage indechiffrable.
 *
 * On n'accepte pas la premiere position venue : il faut que le decoupage y
 * tienne sur plusieurs paquets deja connus, sans quoi on se recalerait sur du
 * bruit et on repartirait de travers.
 */
function resyncFrom(data, from, lengths) {
  for (let pos = from; pos + 2 <= data.length; pos++) {
    if (!validOpcode(opcodeAt(data, pos))) continue
    if (lookahead(data, pos, lengths, RESYNC_RUN) >= RESYNC_BYTES) return pos
  }
  return -1
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
    // Le depart se choisit sans resynchronisation : sinon tous les departs
    // couvriraient tout, et il n'y aurait plus rien pour les departager.
    const attempt = framePackets(data, start, new Map(lengths))
    const trusted = attempt.packets
      .filter((p) => !attempt.learned.has(p.opcode))
      .reduce((n, p) => n + p.length, 0)
    const covered = attempt.end - start
    // A egalite d'octets surs, on prend le decoupage qui explique le plus du
    // flux. On a d'abord fait l'inverse — preferer celui qui inventait le moins
    // de longueurs — mais les deux situations sont indiscernables : un debut de
    // paquet tronque et un vrai paquet inconnu se presentent pareil. Sauter le
    // second coute une donnee reelle ; garder le premier ne coute qu'un paquet
    // fantome de quelques octets.
    const rank = [trusted, covered]
    if (!best || better(rank, best.rank)) best = { start, covered, trusted, rank, ...attempt }
  }
  if (!best) {
    return { start: 0, packets: [], learned: new Map(), gaps: [], skipped: 0, end: 0, covered: 0, coverage: 0 }
  }

  // Deuxieme passe sur le depart retenu : elle beneficie des longueurs apprises
  // pendant la premiere, donc les paquets qui l'avaient arretee se decoupent
  // souvent tout seuls. Et cette fois on se resynchronise.
  const table = new Map(lengths)
  for (const [opcode, len] of best.learned) table.set(opcode, len)
  const full = framePackets(data, best.start, table, { resync: true })
  const covered = full.packets.reduce((n, p) => n + p.length, 0)
  return {
    start: best.start,
    trusted: best.trusted,
    ...full,
    // Les longueurs deduites a la premiere passe comptent aussi : la seconde
    // les recoit toutes faites et n'en apprendrait plus rien.
    learned: new Map([...best.learned, ...full.learned]),
    covered,
    coverage: covered / data.length,
  }
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

/**
 * Reponses du serveur a une demande de nom.
 *
 * C'est la seule source des noms localises : le paquet d'apparition d'un
 * monstre porte sa classe, pas son nom, et le serveur ne l'envoie que lorsque
 * le client le demande — donc quand on survole ou cible la creature.
 *
 * On ne suppose pas le numero de ce paquet ni la position du nom : on cherche
 * les paquets qui commencent par un identifiant deja croise dans une apparition
 * et qui contiennent, juste apres, du texte lisible.
 */
const NAME_OFFSETS = [4, 6, 8, 10, 12]
/** Un paquet isole qui contient du texte ne prouve rien : il en faut plusieurs. */
const MIN_NAME_REPLIES = 2
/** Part des paquets d'un meme numero ou le champ doit livrer un nom. */
const PART_NOMMEE = 0.6

export function readNameReplies(packets, knownIds = null) {
  // On essaie toutes les positions, et surtout on n'en retient aucune avant de
  // les avoir toutes vues.
  //
  // La version precedente gardait la premiere position qui livrait du texte, et
  // c'etait faux : dans un paquet ou le nom est plus loin, les octets d'un
  // identifiant tombent parfois sur des caracteres lisibles — un identifiant
  // finissant par 0x66 0x69 se lit "if". Le champ juste devant le nom livrait
  // donc des bribes de deux lettres, qui passaient devant le vrai nom.
  const parOpcode = new Map()
  for (const p of packets) {
    if (p.payload.length < 8) continue
    const id = p.payload.readUInt32LE(0)
    if (knownIds && !knownIds.has(id)) continue
    if (!parOpcode.has(p.opcode)) parOpcode.set(p.opcode, [])
    parOpcode.get(p.opcode).push({ p, id })
  }

  const replies = []
  for (const [opcode, group] of parOpcode) {
    // Le vrai champ de nom en livre un dans presque tous les paquets ; une
    // suite d'octets lisibles par accident, seulement de temps en temps.
    let best = null
    for (const at of NAME_OFFSETS) {
      const noms = []
      for (const { p, id } of group) {
        const nom = champNom(p.payload, at)
        if (nom) noms.push({ opcode, id, name: nom, offset: at })
      }
      if (noms.length < MIN_NAME_REPLIES) continue
      if (noms.length < group.length * PART_NOMMEE) continue
      const lettres = noms.reduce((n, r) => n + r.name.length, 0)
      if (!best || noms.length > best.noms.length ||
          (noms.length === best.noms.length && lettres > best.lettres)) {
        best = { noms, lettres }
      }
    }
    if (best) replies.push(...best.noms)
  }
  return replies
}

/**
 * Lit un champ de nom a taille fixe.
 *
 * Ces champs sont des tampons de largeur constante, completes par des zeros.
 * Exiger ce remplissage ecarte d'un coup les octets lisibles par hasard : un
 * identifiant qui se lit "if" n'est pas suivi de zeros jusqu'au bout du champ.
 */
const LARGEURS_NOM = [24, 16, 32]

function champNom(payload, at, min = 3) {
  for (const largeur of LARGEURS_NOM) {
    const fin = at + largeur
    if (fin > payload.length) continue
    let n = at
    while (n < fin && payload[n] >= 0x20 && payload[n] <= 0x7e) n++
    if (n - at < min) continue
    // Un champ termine par un zero l'est toujours : du texte qui remplit le
    // tampon jusqu'au dernier octet n'est pas un nom, c'est autre chose.
    if (n >= fin) continue
    let plein = true
    for (let k = n; k < fin; k++) if (payload[k] !== 0) { plein = false; break }
    if (!plein) continue
    return payload.subarray(at, n).toString('latin1')
  }
  return null
}

/** Texte lisible en tete de zone, termine par un octet nul ou la fin. */
export function leadingName(buf, min = 2) {
  let end = 0
  while (end < buf.length && buf[end] >= 0x20 && buf[end] <= 0x7e) end++
  if (end < min) return null
  // Un nom est suivi de remplissage : du texte qui va jusqu'au bout sans jamais
  // s'arreter est probablement autre chose.
  if (end === buf.length && buf.length > 32) return null
  return buf.subarray(0, end).toString('latin1')
}

/**
 * Changements de carte.
 *
 * Le nom de la carte circule en clair dans le paquet qui t'y envoie. On le
 * reconnait a coup sur parce que le client nous a deja donne la liste exacte
 * des cartes qui existent : pas besoin de connaitre le numero du paquet.
 */
export function readMapChanges(packets, knownMaps) {
  if (!knownMaps?.size) return []
  const changes = []
  for (const p of packets) {
    for (let at = 0; at + 3 <= p.payload.length; at++) {
      const nom = leadingName(p.payload.subarray(at), 3)
      if (!nom) continue
      const carte = nom.replace(/\.gat$/i, '')
      if (!knownMaps.has(carte)) continue
      changes.push({ offset: p.offset, opcode: p.opcode, map: carte })
      break
    }
  }
  return changes
}

/**
 * Disparitions : c'est ce qui permet de compter les morts, donc les taux.
 *
 * Un taux de drop n'est pas dans le trafic : le serveur envoie ce qui tombe,
 * pas la probabilite que ca tombe. On ne peut donc que l'observer — combien de
 * fois telle espece est morte, combien de fois tel objet est apparu ensuite.
 *
 * Contrairement au reste de ce fichier, le numero de ce paquet vient d'une
 * capture reelle et non d'une deduction : rien dans le flux ne distingue une
 * disparition d'un autre paquet de sept octets portant un identifiant. On ne
 * retient donc que les identifiants deja vus apparaitre comme monstres, ce qui
 * rend une confusion sans consequence.
 */
export const OPCODE_VANISH = 0x0080

export function readVanishings(packets, mobIds) {
  const events = []
  for (const p of packets) {
    if (p.opcode !== OPCODE_VANISH || p.payload.length < 5) continue
    const id = p.payload.readUInt32LE(0)
    if (mobIds && !mobIds.has(id)) continue
    events.push({ offset: p.offset, id, reason: p.payload[4] })
  }
  return events
}
