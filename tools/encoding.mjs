import iconv from 'iconv-lite'

/**
 * Les clients coreens (kRO / kRO Zero) stockent leurs tables en CP949 (EUC-KR
 * etendu). Les clients occidentaux repatches sont parfois en UTF-8, parfois en
 * CP1252. On detecte plutot que de supposer.
 */

/** UTF-8 strict : renvoie false a la premiere sequence invalide. */
export function looksUtf8(buf) {
  let i = 0
  let sawMultibyte = false
  while (i < buf.length) {
    const b = buf[i]
    if (b < 0x80) { i++; continue }
    let need
    if ((b & 0xe0) === 0xc0) need = 1
    else if ((b & 0xf0) === 0xe0) need = 2
    else if ((b & 0xf8) === 0xf0) need = 3
    else return false
    if (i + need >= buf.length) return false
    for (let k = 1; k <= need; k++) if ((buf[i + k] & 0xc0) !== 0x80) return false
    sawMultibyte = true
    i += need + 1
  }
  return sawMultibyte
}

/** true si le buffer est purement ASCII (l'encodage n'a alors aucune importance). */
export function isAscii(buf) {
  for (let i = 0; i < buf.length; i++) if (buf[i] > 0x7f) return false
  return true
}

/**
 * @param {Buffer} buf
 * @param {string} encoding 'auto' | 'cp949' | 'utf8' | 'cp1252' | ...
 */
export function decode(buf, encoding = 'auto') {
  if (encoding !== 'auto') return iconv.decode(buf, encoding)
  if (isAscii(buf) || looksUtf8(buf)) return buf.toString('utf8')
  return iconv.decode(buf, 'cp949')
}

/** Encode un chemin ASCII/coreen vers les octets tels qu'ils vivent dans le GRF. */
export function encodePath(str, encoding = 'cp949') {
  return iconv.encode(str, encoding)
}

/** Les noms de fichiers du GRF sont manipules comme octets bruts (latin1). */
export function pathKey(str, encoding = 'cp949') {
  return encodePath(str, encoding).toString('latin1').toLowerCase().replace(/\\/g, '/')
}
