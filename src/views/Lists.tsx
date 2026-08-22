import { useMemo, useState } from 'react'
import type { Db } from '../data'
import { normalize } from '../data'
import type { Item, Mob, GameMap } from '../types'
import { ItemIcon, MobLink, MapLink, Section, usePaged, MoreButton, Empty } from '../ui'
import { href, navigate } from '../router'

/**
 * Listes filtrables. Le filtre vit dans l'URL : un lien vers
 * #/items?q=potion est partageable et survit au rechargement.
 */
function Filter({
  value, placeholder, onChange, extra,
}: {
  value: string
  placeholder: string
  onChange: (v: string) => void
  extra?: React.ReactNode
}) {
  return (
    <div className="filter">
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
      />
      {extra}
    </div>
  )
}

function matches(text: string, needle: string) {
  return !needle || normalize(text).includes(needle)
}

export function ItemsView({ db, query }: { db: Db; query: string }) {
  const [onlyDropped, setOnlyDropped] = useState(false)
  const needle = normalize(query.trim())

  const rows = useMemo(
    () => db.itemList.filter((item: Item) => {
      if (onlyDropped && !db.dropsByItem.has(item.id)) return false
      return matches(item.name, needle) || String(item.id) === needle
    }),
    [db, needle, onlyDropped]
  )
  const paged = usePaged(rows, 100)

  return (
    <div className="list-view">
      <Filter
        value={query}
        placeholder="Filtrer les items (nom ou id)"
        onChange={(v) => navigate({ name: 'items', query: v })}
        extra={
          db.hasDrops ? (
            <label className="toggle">
              <input type="checkbox" checked={onlyDropped} onChange={(e) => setOnlyDropped(e.target.checked)} />
              Seulement ceux qui droppent
            </label>
          ) : null
        }
      />
      <Section title="Items" count={rows.length}>
        {!rows.length ? <Empty>Aucun item ne correspond.</Empty> : (
          <>
            <table className="grid">
              <thead>
                <tr>
                  <th className="shrink"></th>
                  <th>Nom</th>
                  <th className="num">Id</th>
                  <th className="num">Slots</th>
                  <th className="num">Sources</th>
                </tr>
              </thead>
              <tbody>
                {paged.visible.map((item) => (
                  <tr key={item.id}>
                    <td className="shrink"><ItemIcon item={item} /></td>
                    <td><a href={href({ name: 'item', id: item.id })}>{item.name}</a></td>
                    <td className="num muted">{item.id}</td>
                    <td className="num muted">{item.slots ?? '—'}</td>
                    <td className="num muted">{(db.dropsByItem.get(item.id) || []).length || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <MoreButton remaining={paged.remaining} onClick={paged.more} />
          </>
        )}
      </Section>
    </div>
  )
}

export function MobsView({ db, query }: { db: Db; query: string }) {
  const [onlySpawning, setOnlySpawning] = useState(false)
  const needle = normalize(query.trim())

  const rows = useMemo(
    () => db.mobList.filter((mob: Mob) => {
      if (onlySpawning && !mob.spawns?.length) return false
      return matches(mob.name, needle) || (mob.sprite ? matches(mob.sprite, needle) : false) || String(mob.id) === needle
    }),
    [db, needle, onlySpawning]
  )
  const paged = usePaged(rows, 100)

  return (
    <div className="list-view">
      <Filter
        value={query}
        placeholder="Filtrer les mobs (nom, sprite ou id)"
        onChange={(v) => navigate({ name: 'mobs', query: v })}
        extra={
          <label className="toggle">
            <input type="checkbox" checked={onlySpawning} onChange={(e) => setOnlySpawning(e.target.checked)} />
            Seulement ceux qui apparaissent quelque part
          </label>
        }
      />
      <Section title="Mobs" count={rows.length}>
        {!rows.length ? <Empty>Aucun mob ne correspond.</Empty> : (
          <>
            <table className="grid">
              <thead>
                <tr>
                  <th>Nom</th>
                  <th className="num">Id</th>
                  <th className="num">Niveau</th>
                  <th className="num">Cartes</th>
                  <th className="num">Drops</th>
                </tr>
              </thead>
              <tbody>
                {paged.visible.map((mob) => (
                  <tr key={mob.id}>
                    <td><MobLink mob={mob} /></td>
                    <td className="num muted">{mob.id}</td>
                    <td className="num muted">{mob.level ?? '—'}</td>
                    <td className="num muted">{mob.spawns?.length || '—'}</td>
                    <td className="num muted">{(db.dropsByMob.get(mob.id) || []).length || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <MoreButton remaining={paged.remaining} onClick={paged.more} />
          </>
        )}
      </Section>
    </div>
  )
}

export function MapsView({ db, query }: { db: Db; query: string }) {
  const [onlyPopulated, setOnlyPopulated] = useState(true)
  const needle = normalize(query.trim())

  const rows = useMemo(
    () => db.mapList.filter((map: GameMap) => {
      if (onlyPopulated && !map.mobs.length) return false
      return matches(map.name, needle) || matches(map.id, needle)
    }),
    [db, needle, onlyPopulated]
  )
  const paged = usePaged(rows, 100)

  return (
    <div className="list-view">
      <Filter
        value={query}
        placeholder="Filtrer les cartes (nom ou identifiant)"
        onChange={(v) => navigate({ name: 'maps', query: v })}
        extra={
          <label className="toggle">
            <input type="checkbox" checked={onlyPopulated} onChange={(e) => setOnlyPopulated(e.target.checked)} />
            Seulement les cartes avec des monstres
          </label>
        }
      />
      <Section title="Cartes" count={rows.length}>
        {!rows.length ? <Empty>Aucune carte ne correspond.</Empty> : (
          <>
            <table className="grid">
              <thead>
                <tr>
                  <th>Nom</th>
                  <th className="num">Espèces</th>
                  <th className="num">Spawns</th>
                </tr>
              </thead>
              <tbody>
                {paged.visible.map((map) => (
                  <tr key={map.id}>
                    <td><MapLink map={map} /></td>
                    <td className="num muted">{map.mobs.length || '—'}</td>
                    <td className="num muted">{map.mobs.reduce((n, m) => n + m.amount, 0) || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <MoreButton remaining={paged.remaining} onClick={paged.more} />
          </>
        )}
      </Section>
    </div>
  )
}
