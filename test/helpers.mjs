import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import iconv from 'iconv-lite'
import { openGrf } from '../tools/grf.mjs'

const HEADER_SIZE = 0x2e

/** Fabrique une archive GRF 0x200 valide, pour tester le lecteur sur du reel. */
export function writeGrf(target, files) {
  const blocks = []
  const table = []
  let offset = 0

  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.isBuffer(content) ? content : iconv.encode(content, 'cp949')
    const packed = zlib.deflateSync(raw)
    blocks.push(packed)

    const nameBytes = iconv.encode(name.replace(/\//g, '\\'), 'cp949')
    const entry = Buffer.alloc(nameBytes.length + 1 + 17)
    nameBytes.copy(entry, 0)
    entry.writeUInt8(0, nameBytes.length)
    const p = nameBytes.length + 1
    entry.writeUInt32LE(packed.length, p)
    entry.writeUInt32LE(packed.length, p + 4)
    entry.writeUInt32LE(raw.length, p + 8)
    entry.writeUInt8(1, p + 12)
    entry.writeUInt32LE(offset, p + 13)
    table.push(entry)
    offset += packed.length
  }

  const tableRaw = Buffer.concat(table)
  const tablePacked = zlib.deflateSync(tableRaw)

  const header = Buffer.alloc(HEADER_SIZE)
  header.write('Master of Magic', 0, 'latin1')
  header.writeUInt32LE(offset, 0x1e)
  header.writeUInt32LE(0, 0x22)
  header.writeUInt32LE(Object.keys(files).length + 7, 0x26)
  header.writeUInt32LE(0x200, 0x2a)

  const sizes = Buffer.alloc(8)
  sizes.writeUInt32LE(tablePacked.length, 0)
  sizes.writeUInt32LE(tableRaw.length, 4)

  fs.writeFileSync(target, Buffer.concat([header, ...blocks, sizes, tablePacked]))
}

/**
 * Variante 0x300, telle que deduite de l'en-tete d'un vrai client Ragnarok Zero :
 * meme en-tete de fichier, mais un en-tete de table de 12 octets au lieu de 8,
 * et le flux compresse qui court jusqu'a la fin du fichier.
 */
export function writeGrf300(target, files) {
  writeGrf(target, files)
  const raw = fs.readFileSync(target)

  const tableAt = 0x2e + raw.readUInt32LE(0x1e)
  const packedLen = raw.readUInt32LE(tableAt)
  const realLen = raw.readUInt32LE(tableAt + 4)
  const stream = raw.subarray(tableAt + 8)

  const head = Buffer.alloc(12)
  head.writeUInt32LE(0, 0)          // champ inconnu, nul sur le client observe
  head.writeUInt32LE(packedLen, 4)
  head.writeUInt32LE(realLen, 8)

  const rebuilt = Buffer.concat([raw.subarray(0, tableAt), head, stream])
  rebuilt.write('Event Horizon\0c', 0, 'latin1')
  rebuilt.writeUInt32LE(0x300, 0x2a)
  fs.writeFileSync(target, rebuilt)
}

/** Relit toutes les entrees d'une archive, pour la reecrire dans un autre format. */
export function readGrfEntries(target) {
  const grf = openGrf(target)
  const files = {}
  for (const entry of grf.entries.values()) files[entry.name] = grf.readEntry(entry)
  grf.close()
  return files
}

/**
 * Client dont les fichiers de navigation ont la forme reellement observee sur
 * Ragnarok Zero : { carte, nom localise, sprite }. Ni identifiant de mob, ni
 * niveau, ni population — le mob ne se retrouve que par son sprite.
 */
export function makeStringsOnlyClient(dir) {
  makeFakeClient(dir)

  const rows = [
    ['prt_fild08', '포링', 'PORING'],
    ['prt_fild08', '루나틱', 'LUNATIC'],
    ['pay_fild04', '포링', 'PORING'],
    ['pay_fild04', '포포링', 'POPORING'],
    ['gef_fild00', '포포링', 'POPORING'],
    ['prt_maze03', '바포메트', 'BAPHOMET'],
    ['izlu2dun', '바포메트', 'BAPHOMET'],
    ['prt_fild01', '포링', 'PORING'],
    ['prt_fild02', '루나틱', 'LUNATIC'],
    ['prt_fild03', '포포링', 'POPORING'],
    ['moc_fild01', '포링', 'PORING'],
    ['moc_fild02', '루나틱', 'LUNATIC'],
    ['moc_fild03', '포포링', 'POPORING'],
    ['pay_fild01', '포링', 'PORING'],
    ['pay_fild02', '루나틱', 'LUNATIC'],
    ['gef_fild01', '포링', 'PORING'],
    ['gef_fild02', '루나틱', 'LUNATIC'],
    ['gef_fild03', '포포링', 'POPORING'],
    ['prt_fild04', '포링', 'PORING'],
    ['prt_fild05', '루나틱', 'LUNATIC'],
    ['moc_fild04', '포포링', 'POPORING'],
    ['pay_fild03', '이름없음', 'SPRITE_INCONNU'],
  ]
  const strings = `Navi_Mob_strings = {\n${
    rows.map(([m, n, s]) => `\t{ "${m}", "${n}", "${s}" },`).join('\n')
  }\n}\n`

  // On remplace toutes les navigations par la forme "chaines seulement".
  const existing = readGrfEntries(path.join(dir, 'data.grf'))
  for (const key of Object.keys(existing)) {
    if (/navi_mob/i.test(key)) delete existing[key]
  }
  existing['data\\luafiles514\\lua files\\navigation\\navi_mob.lub'] = strings
  existing['data\\luafiles514\\lua files\\navigation\\navi_mob_frfr.lub'] = strings
  writeGrf(path.join(dir, 'data.grf'), existing)
  return dir
}

export function tmpdir(prefix = 'rozdb-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** Un client de test minimal mais realiste : GRF unique, tables texte + .lub. */
export function makeFakeClient(dir) {
  const itemInfo = `
tbl = {
	[501] = {
		unidentifiedDisplayName = "Red Potion",
		unidentifiedResourceName = "red_potion",
		unidentifiedDescriptionName = { "Une potion." },
		identifiedDisplayName = "Red Potion",
		identifiedResourceName = "red_potion",
		identifiedDescriptionName = {
			"Une potion rouge qui rend",
			"^0000FF45^000000 points de vie.",
		},
		slotCount = 0,
		ClassNum = 0,
	},
	[909] = {
		unidentifiedDisplayName = "Jellopy",
		identifiedDisplayName = "Jellopy",
		identifiedResourceName = "jellopy",
		identifiedDescriptionName = { "Un morceau de gelee." },
		slotCount = 0,
		ClassNum = 0,
	},
	[1202] = {
		unidentifiedDisplayName = "Knife",
		identifiedDisplayName = "Knife",
		identifiedResourceName = "knife",
		identifiedDescriptionName = { "Un couteau de base." },
		slotCount = 3,
		ClassNum = 1,
	},
	[4001] = {
		unidentifiedDisplayName = "Poring Card",
		identifiedDisplayName = "Poring Card",
		identifiedResourceName = "poring_card",
		identifiedDescriptionName = { "Chance +2" },
		slotCount = 0,
		ClassNum = 0,
	},
}
`

  const npcIdentity = `
jobtbl = {
	JT_PORING = 1002,
	JT_LUNATIC = 1063,
	JT_POPORING = 1031,
	JT_BAPHOMET = 1039,
}
`

  const jobName = `
JobNameTable = {
	[jobtbl.JT_PORING] = "PORING",
	[jobtbl.JT_LUNATIC] = "LUNATIC",
	[jobtbl.JT_POPORING] = "POPORING",
	[jobtbl.JT_BAPHOMET] = "BAPHOMET",
}
`

  // Colonnes volontairement "exotiques" : carte, id, nom, niveau, nombre.
  // Le niveau est stable pour un mob donne, le nombre varie : c'est ce qui
  // permet au parseur de distinguer les deux.
  const naviMob = `
Navi_MobDATA = {
	{ "prt_fild08", 1002, "Poring", 1, 60 },
	{ "prt_fild08", 1063, "Lunatic", 3, 40 },
	{ "pay_fild04", 1002, "Poring", 1, 25 },
	{ "pay_fild04", 1031, "Poporing", 14, 30 },
	{ "gef_fild00", 1031, "Poporing", 14, 15 },
	{ "prt_maze03", 1039, "Baphomet", 81, 1 },
	{ "prt_fild01", 1002, "Poring", 1, 12 },
	{ "prt_fild02", 1002, "Poring", 1, 18 },
	{ "prt_fild03", 1063, "Lunatic", 3, 22 },
	{ "prt_fild04", 1063, "Lunatic", 3, 35 },
	{ "prt_fild05", 1031, "Poporing", 14, 8 },
	{ "gef_fild01", 1002, "Poring", 1, 44 },
	{ "gef_fild02", 1063, "Lunatic", 3, 12 },
	{ "gef_fild03", 1031, "Poporing", 14, 19 },
	{ "moc_fild01", 1002, "Poring", 1, 33 },
	{ "moc_fild02", 1063, "Lunatic", 3, 27 },
	{ "moc_fild03", 1031, "Poporing", 14, 11 },
	{ "moc_fild04", 1002, "Poring", 1, 9 },
	{ "pay_fild01", 1063, "Lunatic", 3, 16 },
	{ "pay_fild02", 1031, "Poporing", 14, 23 },
	{ "pay_fild03", 1002, "Poring", 1, 51 },
	{ "izlu2dun", 1039, "Baphomet", 81, 1 },
}
`

  const mapNames = [
    'prt_fild08.rsw#Prontera Field 8#',
    'pay_fild04.rsw#Payon Field 4#',
    'gef_fild00.rsw#Geffen Field#',
    'prt_maze03.rsw#Labyrinth Forest#',
    'prt_fild01.rsw#Prontera Field 1#',
    'prt_fild02.rsw#Prontera Field 2#',
    'prt_fild03.rsw#Prontera Field 3#',
    'prt_fild04.rsw#Prontera Field 4#',
    'prt_fild05.rsw#Prontera Field 5#',
    'gef_fild01.rsw#Geffen Field 1#',
    'gef_fild02.rsw#Geffen Field 2#',
    'gef_fild03.rsw#Geffen Field 3#',
    'moc_fild01.rsw#Morocc Field 1#',
    'moc_fild02.rsw#Morocc Field 2#',
    'moc_fild03.rsw#Morocc Field 3#',
    'moc_fild04.rsw#Morocc Field 4#',
    'pay_fild01.rsw#Payon Field 1#',
    'pay_fild02.rsw#Payon Field 2#',
    'pay_fild03.rsw#Payon Field 3#',
    'izlu2dun.rsw#Byalan Island#',
    'prontera.rsw#Prontera#',
  ].join('\n')

  // Le vrai client livre le meme jeu de spawns dans une vingtaine de langues :
  // on en met plusieurs pour que les tests attrapent tout cumul accidentel.
  // Les noms localises different des sprites, comme dans le vrai client.
  const localize = (suffix) => naviMob.replace(
    /"(Poring|Lunatic|Poporing|Baphomet)"/g,
    (_, name) => `"${name} ${suffix}"`
  )
  const naviFr = localize('FR')
  const naviKr = localize('KR')

  writeGrf(path.join(dir, 'data.grf'), {
    'System/itemInfo.lub': itemInfo,
    'data/luafiles514/lua files/datainfo/npcidentity.lub': npcIdentity,
    'data/luafiles514/lua files/datainfo/jobname.lub': jobName,
    'data/luafiles514/lua files/navigation/navi_mob.lub': naviMob,
    'data/luafiles514/lua files/navigation/navi_mob_frfr.lub': naviFr,
    'data/luafiles514/lua files/navigation/navi_mob_kokr.lub': naviKr,
    // Le client livre la table d'origine, en coreen, et une variante localisee.
    'data/mapnametable.txt': mapNames.replace(
      /#([^#]+)#/g,
      (_, name) => `#${name.replace(/[A-Za-z]/g, '가')}#`
    ),
    'data/mapnametable_frfr.txt': mapNames,
    'data/idnum2itemdisplaynametable.txt': '501#Red Potion#\n909#Jellopy#\n1202#Knife#\n4001#Poring Card#\n2104#Guard#\n',
    'data/idnum2itemresnametable.txt': '501#red_potion#\n909#jellopy#\n2104#guard#\n',
    'data/itemslotcounttable.txt': '1202#3#\n2104#1#\n',
    'data/idnum2itemdesctable.txt': '2104#\nUn bouclier de base.\nDefense +3.\n#\n',
  })
  fs.writeFileSync(path.join(dir, 'DATA.INI'), '[Data]\n0=data.grf\n')
  return dir
}
