import { useEffect, useMemo, useRef, useState } from 'react'
import type { Db } from './data'
import { loadDb, search } from './data'
import { useRoute, href, navigate } from './router'
import { ItemIcon, Empty } from './ui'
import { ItemDetail } from './views/ItemDetail'
import { MobDetail } from './views/MobDetail'
import { MapDetail } from './views/MapDetail'
import { ItemsView, MobsView, MapsView } from './views/Lists'
import { DataView } from './views/DataView'

export function App() {
  const [db, setDb] = useState<Db | null>(null)
  const [error, setError] = useState<string | null>(null)
  const route = useRoute()

  useEffect(() => {
    loadDb().then(setDb).catch((err) => setError(String(err)))
  }, [])

  if (error) return <div className="boot">Erreur de chargement : {error}</div>
  if (!db) return <div className="boot">Chargement…</div>

  const empty = db.items.size === 0 && db.mobs.size === 0

  return (
    <div className="app">
      <Sidebar db={db} route={route} />
      <main>
        {empty && route.name !== 'data' ? (
          <div className="detail">
            <h1>Aucune donnée</h1>
            <Empty>
              Lance d'abord l'extraction :{' '}
              <code>npm run extract -- --client "C:\Gravity\Ragnarok Zero"</code>. Détails dans{' '}
              <a href={href({ name: 'data' })}>Données</a>.
            </Empty>
          </div>
        ) : (
          <Content db={db} route={route} />
        )}
      </main>
    </div>
  )
}

function Content({ db, route }: { db: Db; route: ReturnType<typeof useRoute> }) {
  switch (route.name) {
    case 'item': return <ItemDetail db={db} id={route.id} />
    case 'mob': return <MobDetail db={db} id={route.id} />
    case 'map': return <MapDetail db={db} id={route.id} />
    case 'items': return <ItemsView db={db} query={route.query} />
    case 'mobs': return <MobsView db={db} query={route.query} />
    case 'maps': return <MapsView db={db} query={route.query} />
    case 'data': return <DataView db={db} />
    default: return <Home db={db} />
  }
}

function Sidebar({ db, route }: { db: Db; route: ReturnType<typeof useRoute> }) {
  const links = [
    { name: 'items' as const, label: 'Items', count: db.items.size },
    { name: 'mobs' as const, label: 'Mobs', count: db.mobs.size },
    { name: 'maps' as const, label: 'Cartes', count: db.maps.size },
  ]
  return (
    <nav className="sidebar">
      <a className="brand" href="#/">
        ROZ <span>DB</span>
      </a>
      <SearchBox db={db} />
      <ul>
        {links.map((link) => (
          <li key={link.name}>
            <a
              href={href({ name: link.name, query: '' })}
              className={route.name === link.name || route.name === link.name.slice(0, -1) ? 'active' : ''}
            >
              {link.label}
              <span className="count">{link.count.toLocaleString('fr-FR')}</span>
            </a>
          </li>
        ))}
        <li>
          <a href={href({ name: 'data' })} className={route.name === 'data' ? 'active' : ''}>
            Données
            {!db.hasDrops && <span className="badge" title="Aucune table de drop importée">!</span>}
          </a>
        </li>
      </ul>
    </nav>
  )
}

/** Recherche globale : items, mobs et cartes dans le meme champ. */
function SearchBox({ db }: { db: Db }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const hits = useMemo(() => (query.trim() ? search(db, query, 20) : []), [db, query])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement !== inputRef.current) {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
    }
  }, [])

  const go = (index: number) => {
    const hit = hits[index]
    if (!hit) return
    if (hit.kind === 'item') navigate({ name: 'item', id: hit.item.id })
    else if (hit.kind === 'mob') navigate({ name: 'mob', id: hit.mob.id })
    else navigate({ name: 'map', id: hit.map.id })
    setOpen(false)
    setQuery('')
    inputRef.current?.blur()
  }

  return (
    <div className="search" ref={boxRef}>
      <input
        ref={inputRef}
        type="search"
        value={query}
        placeholder="Rechercher…  ( / )"
        autoComplete="off"
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setCursor(0) }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, hits.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)) }
          else if (e.key === 'Enter') { e.preventDefault(); go(cursor) }
          else if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur() }
        }}
      />
      {open && hits.length > 0 && (
        <ul className="results">
          {hits.map((hit, i) => (
            <li key={`${hit.kind}-${i}`}>
              <button className={i === cursor ? 'active' : ''} onMouseEnter={() => setCursor(i)} onClick={() => go(i)}>
                <span className={`kind ${hit.kind}`}>
                  {hit.kind === 'item' ? 'item' : hit.kind === 'mob' ? 'mob' : 'carte'}
                </span>
                {hit.kind === 'item' && <ItemIcon item={hit.item} size={20} />}
                <span className="label">
                  {hit.kind === 'item' ? hit.item.name : hit.kind === 'mob' ? hit.mob.name : hit.map.name}
                </span>
                <span className="hint">
                  {hit.kind === 'item'
                    ? `${(db.dropsByItem.get(hit.item.id) || []).length || 0} source(s)`
                    : hit.kind === 'mob'
                      ? `${hit.mob.spawns?.length || 0} carte(s)`
                      : `${hit.map.mobs.length} espèce(s)`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Home({ db }: { db: Db }) {
  // Sans populations, "la plus peuplee" n'a pas de sens : on classe alors par
  // nombre d'especes.
  const weight = (m: (typeof db.mapList)[number]) =>
    db.hasPopulations ? m.mobs.reduce((n, x) => n + (x.amount ?? 0), 0) : m.mobs.length
  const topMaps = [...db.mapList]
    .filter((m) => m.mobs.length)
    .sort((a, b) => weight(b) - weight(a))
    .slice(0, 12)

  return (
    <div className="home">
      <h1>Base Ragnarok Zero</h1>
      <p className="lede">
        Tapez <kbd>/</kbd> pour chercher un item, un mob ou une carte. Depuis un item vous voyez qui
        le droppe et où le farmer ; depuis un mob, ce qu'il lâche et où il vit.
      </p>

      <div className="cards">
        <a className="card" href={href({ name: 'items', query: '' })}>
          <strong>{db.items.size.toLocaleString('fr-FR')}</strong>
          <span>items</span>
        </a>
        <a className="card" href={href({ name: 'mobs', query: '' })}>
          <strong>{db.mobs.size.toLocaleString('fr-FR')}</strong>
          <span>mobs</span>
        </a>
        <a className="card" href={href({ name: 'maps', query: '' })}>
          <strong>{db.maps.size.toLocaleString('fr-FR')}</strong>
          <span>cartes</span>
        </a>
        <a className="card" href={href({ name: 'data' })}>
          <strong>{db.hasDrops ? db.dropsByMob.size.toLocaleString('fr-FR') : '—'}</strong>
          <span>mobs avec drops</span>
        </a>
      </div>

      {!db.hasDrops && (
        <p className="note warn">
          Aucune table de drop importée : le client de jeu ne les contient pas. Les items, mobs,
          cartes et zones sont complets ; les taux arriveront quand une source sera branchée
          (<a href={href({ name: 'data' })}>comment faire</a>).
        </p>
      )}

      {topMaps.length > 0 && (
        <>
          <h2>{db.hasPopulations ? 'Cartes les plus peuplées' : 'Cartes les plus variées'}</h2>
          <ul className="chips">
            {topMaps.map((map) => (
              <li key={map.id}>
                <a href={href({ name: 'map', id: map.id })}>
                  {map.name}
                  <span className="count">{weight(map)}</span>
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
