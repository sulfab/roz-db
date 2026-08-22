import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Chemin du client, partage par tous les outils.
 *
 * Le donner une fois suffit : n'importe quelle commande qui le recoit le
 * memorise, et les suivantes s'en servent. Sans ca, `scan` puis `extract`
 * obligeait a retaper le chemin entre les deux.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_PATH_FILE = path.join(ROOT, '.client-path')

export function rememberClientDir(dir) {
  try {
    fs.writeFileSync(CLIENT_PATH_FILE, dir)
  } catch {
    // Un dossier en lecture seule ne doit pas faire echouer une extraction.
  }
}

export function storedClientDir() {
  try {
    const stored = fs.readFileSync(CLIENT_PATH_FILE, 'utf8').trim()
    return stored || null
  } catch {
    return null
  }
}

/**
 * @param {string|null|undefined} explicit chemin donne sur la ligne de commande
 * @returns {string|null} le chemin a utiliser, memorise au passage
 */
export function resolveClientDir(explicit) {
  if (explicit) {
    rememberClientDir(explicit)
    return explicit
  }
  return storedClientDir()
}

export { CLIENT_PATH_FILE, ROOT }
