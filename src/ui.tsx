import { useState } from 'react'
import type { ReactNode } from 'react'
import type { Item, Mob, GameMap } from './types'
import { formatChance, formatOdds, hasIcon } from './data'
import { href } from './router'

/** Le client colore ses descriptions avec ^RRGGBB. On rend la meme chose. */
export function ColorText({ text }: { text: string }) {
  const parts: ReactNode[] = []
  const regex = /\^([0-9a-fA-F]{6})/g
  let last = 0
  let color: string | null = null
  let match: RegExpExecArray | null

  while ((match = regex.exec(text))) {
    const chunk = text.slice(last, match.index)
    if (chunk) parts.push(<span key={parts.length} style={color ? { color: `#${color}` } : undefined}>{chunk}</span>)
    color = match[1].toLowerCase() === '000000' ? null : match[1]
    last = match.index + match[0].length
  }
  const rest = text.slice(last)
  if (rest) parts.push(<span key={parts.length} style={color ? { color: `#${color}` } : undefined}>{rest}</span>)
  return <>{parts}</>
}

/** Les icones sont optionnelles (npm run icons) : on ne casse rien sans elles. */
export function ItemIcon({ item, size = 24 }: { item: Item; size?: number }) {
  const [failed, setFailed] = useState(false)
  if (failed || !hasIcon(item.id)) {
    return <span className="icon-placeholder" style={{ width: size, height: size }} aria-hidden />
  }
  return (
    <img
      className="icon"
      src={`./icons/${item.id}.png`}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  )
}

export function ItemLink({ item, icon = true }: { item: Item; icon?: boolean }) {
  return (
    <a className="entity-link" href={href({ name: 'item', id: item.id })}>
      {icon && <ItemIcon item={item} />}
      <span>{item.name}</span>
      {item.slots ? <span className="slots">[{item.slots}]</span> : null}
    </a>
  )
}

export function MobLink({ mob }: { mob: Mob }) {
  return (
    <a className="entity-link" href={href({ name: 'mob', id: mob.id })}>
      <span>{mob.name}</span>
      {mob.level !== undefined && <span className="level">niv. {mob.level}</span>}
    </a>
  )
}

export function MapLink({ map }: { map: GameMap | null; }) {
  if (!map) return <span className="muted">carte inconnue</span>
  return (
    <a className="entity-link" href={href({ name: 'map', id: map.id })}>
      <span>{map.name}</span>
      <code className="map-id">{map.id}</code>
    </a>
  )
}

/** Un taux se lit mieux avec sa contrepartie "1 sur N" et une jauge. */
export function Chance({ value }: { value: number }) {
  return (
    <span className="chance" title={formatOdds(value)}>
      <span className="chance-bar" style={{ width: `${Math.min(100, Math.max(2, Math.sqrt(value) * 10))}%` }} />
      <span className="chance-value">{formatChance(value)}</span>
    </span>
  )
}

/** Une population absente s'affiche comme telle, jamais comme un zero. */
export function Population({ amount }: { amount: number | null | undefined }) {
  if (amount === null || amount === undefined) return <span className="muted" title="Le client ne donne pas le nombre de monstres">présent</span>
  return <>{amount}</>
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>
}

export function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="section">
      <h2>
        {title}
        {count !== undefined && <span className="count">{count}</span>}
      </h2>
      {children}
    </section>
  )
}

/**
 * Listes longues : on affiche une tranche et on etend a la demande.
 * Version hook, utilisable a l'interieur d'un <table> ou un <button> ne peut
 * pas etre insere entre les lignes.
 */
export function usePaged<T>(rows: T[], pageSize = 100) {
  const [shown, setShown] = useState(pageSize)
  return {
    visible: rows.slice(0, shown),
    remaining: Math.max(0, rows.length - shown),
    more: () => setShown((n) => n + pageSize * 5),
  }
}

export function MoreButton({ remaining, onClick }: { remaining: number; onClick: () => void }) {
  if (!remaining) return null
  return (
    <button className="more" onClick={onClick}>
      Afficher plus ({remaining.toLocaleString('fr-FR')} restants)
    </button>
  )
}

/** Meme chose, mais pour les listes hors tableau. */
export function Paged<T>({
  rows, render, pageSize = 100, empty,
}: {
  rows: T[]
  render: (row: T, index: number) => ReactNode
  pageSize?: number
  empty?: ReactNode
}) {
  const [shown, setShown] = useState(pageSize)
  if (!rows.length) return <>{empty ?? <Empty>Rien a afficher.</Empty>}</>
  return (
    <>
      {rows.slice(0, shown).map(render)}
      {rows.length > shown && (
        <button className="more" onClick={() => setShown((n) => n + pageSize * 5)}>
          Afficher plus ({(rows.length - shown).toLocaleString('fr-FR')} restants)
        </button>
      )}
    </>
  )
}
