#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openClient } from './vfs.mjs'
import { isCompiledLua } from './lua.mjs'
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
  if (!buf) return 'absent'
  if (isCompiledLua(buf)) return 'bytecode Lua compile'
  if (isAscii(buf)) return 'texte (ascii)'
  if (looksUtf8(buf)) return 'texte (utf-8)'
  return 'texte (cp949 probable)'
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
    const line = { name, version: `0x${grf.version.toString(16)}`, files: grf.entries.size }
    report.archives.push(line)
    console.log(`  ${name.padEnd(24)} ${line.files} fichiers  (v${line.version})`)
  }
  if (vfs.looseDir) console.log(`  data/ en clair           ${vfs.looseDir}`)
  for (const err of vfs.errors) console.log(`  ! ${err}`)

  console.log('\nFichiers attendus')
  for (const [label, candidates] of KNOWN) {
    const found = candidates.find((c) => vfs.exists(c))
    const kind = found ? classify(safeRead(vfs, found)) : 'absent'
    report.known.push({ label, path: found || null, kind })
    const mark = !found ? 'x' : kind.startsWith('bytecode') ? '!' : 'v'
    console.log(`  [${mark}] ${label.padEnd(34)} ${found || '(introuvable)'}${found ? `  -> ${kind}` : ''}`)
  }

  console.log('\nGroupes de fichiers')
  for (const [label, pattern] of PATTERNS) {
    const hits = vfs.list((key) => pattern.test(key))
    const group = { label, count: hits.length, files: hits.slice(0, full ? hits.length : 12).map((h) => ({ path: h.name, size: h.size, from: h.from })) }
    report.groups.push(group)
    console.log(`  ${label} : ${hits.length}`)
    for (const h of group.files) {
      const kind = /\.(lub|lua)$/i.test(h.path) ? classify(safeRead(vfs, h.path)) : ''
      console.log(`      ${h.path}${kind ? `  -> ${kind}` : ''}`)
    }
    if (!full && hits.length > group.files.length) console.log(`      ... et ${hits.length - group.files.length} autres (--full pour tout voir)`)
  }

  fs.writeFileSync(path.join(ROOT, 'scan-report.json'), JSON.stringify(report, null, 2))
  vfs.close()

  console.log('\nRapport ecrit dans scan-report.json.')
  console.log('Les lignes [!] sont du Lua compile : leur contenu n\'est pas lisible tel quel.')
}

function safeRead(vfs, p) {
  try { return vfs.read(p) } catch { return null }
}

main()
