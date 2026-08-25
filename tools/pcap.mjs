import fs from 'node:fs'
import path from 'node:path'

/**
 * Lecture de captures reseau : pcap classique et pcapng (le format par defaut
 * de Wireshark), puis reassemblage des flux TCP.
 *
 * On ne cherche pas a etre un analyseur reseau complet : juste a rendre, pour
 * chaque connexion, les octets envoyes par le serveur dans l'ordre ou le client
 * les a recus. C'est la matiere premiere de l'analyse des paquets du jeu.
 */

const PCAP_MAGIC = 0xa1b2c3d4
const PCAP_MAGIC_SWAPPED = 0xd4c3b2a1
const PCAP_MAGIC_NANO = 0xa1b23c4d
const PCAP_MAGIC_NANO_SWAPPED = 0x4d3cb2a1
const PCAPNG_BLOCK_SECTION = 0x0a0d0d0a

const LINKTYPE_NULL = 0
const LINKTYPE_ETHERNET = 1
const LINKTYPE_RAW = 101
const LINKTYPE_LINUX_SLL = 113
const LINKTYPE_LOOP = 108
const LINKTYPE_LINUX_SLL2 = 276

export class PcapError extends Error {}

/** @returns {{linkType: number, packets: Array<{time: number, data: Buffer}>}} */
export function readCapture(file) {
  const buf = fs.readFileSync(file)
  if (buf.length < 8) throw new PcapError(`${file} : fichier trop court`)
  const magic = buf.readUInt32BE(0)
  if (magic === PCAPNG_BLOCK_SECTION) return readPcapng(buf)
  return readPcap(buf)
}

function readPcap(buf) {
  const magicLE = buf.readUInt32LE(0)
  let littleEndian
  let nano = false
  if (magicLE === PCAP_MAGIC) littleEndian = true
  else if (magicLE === PCAP_MAGIC_NANO) { littleEndian = true; nano = true }
  else if (magicLE === PCAP_MAGIC_SWAPPED) littleEndian = false
  else if (magicLE === PCAP_MAGIC_NANO_SWAPPED) { littleEndian = false; nano = true }
  else throw new PcapError(`format de capture inconnu (magic 0x${magicLE.toString(16)})`)

  const u32 = (at) => (littleEndian ? buf.readUInt32LE(at) : buf.readUInt32BE(at))
  const linkType = u32(20)
  const packets = []
  let p = 24
  while (p + 16 <= buf.length) {
    const tsSec = u32(p)
    const tsFrac = u32(p + 4)
    const inclLen = u32(p + 8)
    p += 16
    if (p + inclLen > buf.length) break
    packets.push({
      time: tsSec + tsFrac / (nano ? 1e9 : 1e6),
      data: buf.subarray(p, p + inclLen),
    })
    p += inclLen
  }
  return { linkType, packets }
}

function readPcapng(buf) {
  const packets = []
  const interfaces = []
  let p = 0
  let littleEndian = true

  while (p + 12 <= buf.length) {
    const type = littleEndian ? buf.readUInt32LE(p) : buf.readUInt32BE(p)
    if (type === PCAPNG_BLOCK_SECTION) {
      // L'ordre des octets est annonce par le "byte-order magic" de ce bloc.
      littleEndian = buf.readUInt32LE(p + 8) === 0x1a2b3c4d
    }
    const length = littleEndian ? buf.readUInt32LE(p + 4) : buf.readUInt32BE(p + 4)
    if (length < 12 || p + length > buf.length) break
    const body = buf.subarray(p + 8, p + length - 4)
    const u32 = (at) => (littleEndian ? body.readUInt32LE(at) : body.readUInt32BE(at))
    const u16 = (at) => (littleEndian ? body.readUInt16LE(at) : body.readUInt16BE(at))

    if (type === 1) {
      interfaces.push({ linkType: u16(0) }) // Interface Description Block
    } else if (type === 6) {
      // Enhanced Packet Block
      const interfaceId = u32(0)
      const tsHigh = u32(4)
      const tsLow = u32(8)
      const capturedLength = u32(12)
      const data = body.subarray(20, 20 + capturedLength)
      packets.push({
        time: (tsHigh * 2 ** 32 + tsLow) / 1e6,
        data,
        linkType: interfaces[interfaceId]?.linkType ?? LINKTYPE_ETHERNET,
      })
    } else if (type === 3) {
      // Simple Packet Block : pas d'horodatage
      packets.push({ time: 0, data: body.subarray(4), linkType: interfaces[0]?.linkType ?? LINKTYPE_ETHERNET })
    }
    p += length
  }

  return { linkType: interfaces[0]?.linkType ?? LINKTYPE_ETHERNET, packets }
}

/** Retire l'en-tete de liaison pour ne garder que le paquet IP. */
function stripLinkLayer(data, linkType) {
  switch (linkType) {
    case LINKTYPE_ETHERNET: {
      if (data.length < 14) return null
      let type = data.readUInt16BE(12)
      let offset = 14
      while (type === 0x8100 || type === 0x88a8) { // VLAN
        if (data.length < offset + 4) return null
        type = data.readUInt16BE(offset + 2)
        offset += 4
      }
      if (type !== 0x0800 && type !== 0x86dd) return null
      return data.subarray(offset)
    }
    case LINKTYPE_NULL:
    case LINKTYPE_LOOP:
      return data.length > 4 ? data.subarray(4) : null
    case LINKTYPE_RAW:
      return data
    case LINKTYPE_LINUX_SLL:
      return data.length > 16 ? data.subarray(16) : null
    case LINKTYPE_LINUX_SLL2:
      return data.length > 20 ? data.subarray(20) : null
    default:
      return null
  }
}

function parseIp(packet) {
  if (!packet || packet.length < 20) return null
  const version = packet[0] >> 4
  if (version === 4) {
    const headerLength = (packet[0] & 0x0f) * 4
    if (packet.length < headerLength) return null
    if (packet[9] !== 6) return null // TCP seulement
    return {
      src: `${packet[12]}.${packet[13]}.${packet[14]}.${packet[15]}`,
      dst: `${packet[16]}.${packet[17]}.${packet[18]}.${packet[19]}`,
      payload: packet.subarray(headerLength, Math.min(packet.readUInt16BE(2), packet.length)),
    }
  }
  if (version === 6) {
    if (packet.length < 40 || packet[6] !== 6) return null
    const hex = (at) => [...packet.subarray(at, at + 16)].map((b) => b.toString(16).padStart(2, '0')).join('')
    return { src: hex(8), dst: hex(24), payload: packet.subarray(40) }
  }
  return null
}

function parseTcp(payload) {
  if (!payload || payload.length < 20) return null
  const dataOffset = (payload[12] >> 4) * 4
  if (payload.length < dataOffset) return null
  return {
    sport: payload.readUInt16BE(0),
    dport: payload.readUInt16BE(2),
    seq: payload.readUInt32BE(4),
    flags: payload[13],
    data: payload.subarray(dataOffset),
  }
}

const FLAG_SYN = 0x02
const FLAG_ACK = 0x10

/**
 * Reassemble les flux TCP d'une capture.
 *
 * Les segments sont ranges par numero de sequence : les retransmissions et les
 * paquets arrives dans le desordre sont donc traites, et les trous sont
 * signales plutot que silencieusement combles.
 *
 * @returns {Array<{key: string, src: string, sport: number, dst: string, dport: number,
 *   data: Buffer, bytes: number, gaps: number, isServerToClient: boolean|null}>}
 */
export function reassemble(capture) {
  const flows = new Map()
  const servers = new Set() // endpoints ayant recu un SYN : ce sont les serveurs

  for (const packet of capture.packets) {
    const ip = parseIp(stripLinkLayer(packet.data, packet.linkType ?? capture.linkType))
    if (!ip) continue
    const tcp = parseTcp(ip.payload)
    if (!tcp) continue

    if ((tcp.flags & FLAG_SYN) && !(tcp.flags & FLAG_ACK)) {
      servers.add(`${ip.dst}:${tcp.dport}`)
    }

    if (!tcp.data.length) continue
    const key = `${ip.src}:${tcp.sport}>${ip.dst}:${tcp.dport}`
    let flow = flows.get(key)
    if (!flow) {
      flow = { key, src: ip.src, sport: tcp.sport, dst: ip.dst, dport: tcp.dport, segments: new Map() }
      flows.set(key, flow)
    }
    // Une retransmission porte le meme numero de sequence : on garde la version
    // la plus longue plutot que d'empiler deux fois les memes octets.
    const existing = flow.segments.get(tcp.seq)
    if (!existing || existing.length < tcp.data.length) flow.segments.set(tcp.seq, tcp.data)
  }

  const out = []
  for (const flow of flows.values()) {
    const ordered = [...flow.segments.entries()].sort((a, b) => a[0] - b[0])
    const chunks = []
    let gaps = 0
    let expected = null
    for (const [seq, data] of ordered) {
      if (expected !== null && seq !== expected) gaps++
      chunks.push(data)
      expected = seq + data.length
    }
    const origin = `${flow.src}:${flow.sport}`
    out.push({
      key: flow.key,
      src: flow.src,
      sport: flow.sport,
      dst: flow.dst,
      dport: flow.dport,
      data: Buffer.concat(chunks),
      bytes: chunks.reduce((n, c) => n + c.length, 0),
      gaps,
      origin,
      isServerToClient: servers.size ? servers.has(origin) : null,
    })
  }
  out.sort((a, b) => b.bytes - a.bytes)
  return inferDirections(out)
}

/**
 * Retrouve le sens des flux quand la poignee de main manque.
 *
 * Une capture demarree en cours de partie n'a pas vu le SYN, donc on ne sait
 * pas qui a ouvert la connexion. Mais les deux sens d'une meme connexion ne se
 * ressemblent pas : le client envoie des ordres de quelques octets, le serveur
 * renvoie le monde. On ne tranche que si l'ecart est franc — sinon on prefere
 * ne rien dire.
 */
const DIRECTION_RATIO = 4

function inferDirections(flows) {
  const known = flows.some((f) => f.isServerToClient !== null)
  if (known) return flows
  const byPair = new Map()
  for (const f of flows) {
    const pair = [`${f.src}:${f.sport}`, `${f.dst}:${f.dport}`].sort().join('|')
    if (!byPair.has(pair)) byPair.set(pair, [])
    byPair.get(pair).push(f)
  }
  for (const group of byPair.values()) {
    if (group.length !== 2) continue
    const [gros, petit] = [...group].sort((a, b) => b.bytes - a.bytes)
    if (gros.bytes < petit.bytes * DIRECTION_RATIO) continue
    gros.isServerToClient = true
    petit.isServerToClient = false
    gros.directionInferee = true
    petit.directionInferee = true
  }
  return flows
}

/** Le trafic chiffre TLS commence par un handshake reconnaissable. */
export function looksTls(data) {
  return data.length > 5 && data[0] === 0x16 && data[1] === 0x03 && data[2] <= 0x04
}

/**
 * Un flux deja extrait, tel que celui ecrit par --raw, n'est pas une capture :
 * il n'a ni magie ni en-tetes. On le rend tel quel plutot que d'echouer, pour
 * pouvoir reanalyser un flux qu'on s'est deja envoye.
 */
function isCapture(buf) {
  if (buf.length < 8) return false
  if (buf.readUInt32BE(0) === PCAPNG_BLOCK_SECTION) return true
  const magic = buf.readUInt32LE(0)
  return magic === PCAP_MAGIC || magic === PCAP_MAGIC_NANO ||
    magic === PCAP_MAGIC_SWAPPED || magic === PCAP_MAGIC_NANO_SWAPPED
}

export function loadFlows(file) {
  const buf = fs.readFileSync(file)
  if (!isCapture(buf)) {
    return [{ key: path.basename(file), bytes: buf.length, data: buf, isServerToClient: null, gaps: 0 }]
  }
  return reassemble(readCapture(file))
}
