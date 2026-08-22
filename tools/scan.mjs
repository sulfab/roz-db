#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openClient } from './vfs.mjs'
import { describeLua } from './luadata.mjs'
import { looksUtf8, isAscii } from './encoding.mjs'

/**
 * Inventaire du client : qu'est-ce qui est reellement present, et sous quelle
 * forme (texte lisible ou bytecode compile) ?
 *
 * A lancer en premier. Le rapport dit quels parseurs vont fonctionner et
 * lesquels vont avoir besoin d'etre cales sur ton client precis.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const KNOWN = [
  ['itemInfo (noms + descriptions)', [
    'System/itemInfo.lub', 'System/itemInfo_true.lub', 'System/itemInfo_Sak.lub',
    'data/luafiles514/lua files/datainfo/iteminfo.lub',
  ]],
  ['noms d\'items', ['data/idnum2itemdisplaynametable.txt']],
  ['descriptions d\'items', ['data/idnum2itemdesctable.txt']],
  ['ressources d\'items (icones)', ['data/idnum2itemresnametable.txt']],
  ['slots d\'items', ['data/itemslotcounttable.txt']],
  ['noms d\'items non identifies', ['data/num2itemdisplaynametable.txt']],
  ['noms de cartes', ['data/mapnametable.txt']],
  ['messages du client', ['data/msgstringtable.txt']],
  ['ids de mobs/npc', ['data/luafiles514/lua files/datainfo/npcidentity.lub', 'System/npcidentity.lub']],
  ['sprites de mobs', ['data/luafiles514/lua files/datainfo/jobname.lub', 'System/jobname.lub']],
]

const PATTERNS = [
  ['navigation (mob -> carte)', /navigation\/navi_mob[^/]*\.(lub|lua)$/],
  ['navigation (cartes)', /navigation\/navi_map[^/]*\.(lub|lua)$/],
  ['navigation (liens entre cartes)', /navigation\/navi_link[^/]*\.(lub|lua)$/],
  ['navigation (npc)', /navigation\/navi_npc[^/]*\.(lub|lua)$/],
  ['datainfo (tout)', /datainfo\/[^/]*\.(lub|lua)$/],
  ['System (tout)', /^system\/[^/]*\.(lub|lua)$/],
  ['fichiers "monster"', /monster[^/]*\.(lub|lua|txt|xml)$/],
  ['fichiers "encyclopedia" / "guide"', /(encyclop|guide|dogam)[^/]*\.(lub|lua|txt|xml)$/],
]

function classify(buf) {
  if (!buf) return { note: 'absent', readable: false }
  const described = describeLua(buf)
  if (described.compiled) return described
  if (isAscii(buf)) return { note: 'texte (ascii)', readable: true }
  if (looksUtf8(buf)) return { note: 'texte (utf-8)', readable: true }
  return { note: 'texte (cp949 probable)', readable: true }
}

function main() {
  const argv = process.argv.slice(2)
  const full = argv.includes('--full')
  const clientDir = argv.find((a) => !a.startsWith('-')) ||
    (fs.existsSync(path.join(ROOT, '.client-path'))
      ? fs.readFileSync(path.join(ROOT, '.client-path'), 'utf8').trim()
      : null)

  if (!clientDir) {
    console.error('Usage : node tools/scan.mjs "C:\\Gravity\\Ragnarok Zero" [--full]')
    process.exit(1)
  }

  const vfs = openClient(clientDir, { encoding: 'cp949' })
  const report = { client: clientDir, scannedAt: new Date().toISOString(), archives: [], known: [], groups: [], errors: vfs.errors }

  console.log(`Client : ${clientDir}\n`)
  console.log('Archives')
  for (const { name, grf } of vfs.grfs) {
    const line = {
      name,
      version: `0x${grf.version.toString(16)}`,
      files: grf.entries.size,
      signature: grf.signature,
    }
    report.archives.push(line)
    line.entryLayout = grf.entryLayout
    line.tableHeaderSize = grf.tableHeaderSize
    console.log(`  ${name.padEnd(24)} ${line.files} fichiers  (v${line.version})`)
    if (grf.customSignature) console.log(`      signature "${grf.signature}" — non standard, mais lisible`)
    console.log(`      en-tete de table ${grf.tableHeaderSize} octets, entrees ${grf.entryLayout}`)
    if (grf.skippedEntries) console.log(`      ${grf.skippedEntries} entree(s) incoherente(s) ignoree(s)`)
  }
  if (vfs.looseDir) console.log(`  data/ en clair           ${vfs.looseDir}`)
  for (const err of vfs.errors) console.log(`  ! ${err}`)

  console.log('\nFichiers attendus')
  for (const [label, candidates] of KNOWN) {
    const found = candidates.find((c) => vfs.exists(c))
    const kind = found ? classify(safeRead(vfs, found)) : { note: 'absent', readable: false }
    report.known.push({ label, path: found || null, kind: kind.note })
    const mark = !found ? 'x' : kind.readable ? 'v' : '!'
    console.log(`  [${mark}] ${label.padEnd(34)} ${found || '(introuvable)'}${found ? `  -> ${kind.note}` : ''}`)
  }

  console.log('\nGroupes de fichiers')
  for (const [label, pattern] of PATTERNS) {
    const hits = vfs.list((key) => pattern.test(key))
    const group = { label, count: hits.length, files: hits.slice(0, full ? hits.length : 12).map((h) => ({ path: h.name, size: h.size, from: h.from })) }
    report.groups.push(group)
    console.log(`  ${label} : ${hits.length}`)
    for (const h of group.files) {
      const kind = /\.(lub|lua)$/i.test(h.path) ? classify(safeRead(vfs, h.path)).note : ''
      console.log(`      ${h.path}${kind ? `  -> ${kind}` : ''}`)
    }
    if (!full && hits.length > group.files.length) console.log(`      ... et ${hits.length - group.files.length} autres (--full pour tout voir)`)
  }

  // Quand rien n'est trouve, savoir ce que le dossier data/ contient vraiment
  // vaut mieux qu'une liste de "introuvable".
  if (vfs.looseDir && report.known.every((k) => !k.path)) {
    console.log('\nContenu du dossier data/ en clair')
    const listing = inventory(vfs.looseDir)
    report.looseData = listing
    for (const line of listing.slice(0, 30)) console.log(`  ${line.count.toString().padStart(6)}  ${line.ext}`)
    if (!listing.length) console.log('  (vide)')
  }

  fs.writeFileSync(path.join(ROOT, 'scan-report.json'), JSON.stringify(report, null, 2))
  vfs.close()

  console.log('\nRapport ecrit dans scan-report.json.')
  console.log('Le bytecode Lua 5.1 est execute a l\'extraction : marque [v], il est exploitable.')
  console.log('Les lignes [!] sont ce que l\'extraction ne sait pas lire.')
}

/** Repartition par extension du dossier data/ en clair. */
function inventory(dir) {
  const counts = new Map()
  const walk = (current, depth) => {
    if (depth > 6) return
    let items
    try { items = fs.readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const item of items) {
      if (item.isDirectory()) walk(path.join(current, item.name), depth + 1)
      else {
        const ext = path.extname(item.name).toLowerCase() || '(sans extension)'
        counts.set(ext, (counts.get(ext) || 0) + 1)
      }
    }
  }
  walk(dir, 0)
  return [...counts].map(([ext, count]) => ({ ext, count })).sort((a, b) => b.count - a.count)
}

function safeRead(vfs, p) {
  try { return vfs.read(p) } catch { return null }
}

main()
