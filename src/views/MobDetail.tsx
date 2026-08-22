import type { Db } from '../data'
import { formatOdds } from '../data'
import { ItemLink, MapLink, Chance, Section, Empty } from '../ui'
import { href } from '../router'

/** Fiche mob : ce qu'il lache, et ou le trouver. */
export function MobDetail({ db, id }: { db: Db; id: number }) {
  const mob = db.mobs.get(id)
  if (!mob) {
    return (
      <div className="detail">
        <h1>Mob {id}</h1>
        <Empty>Ce mob n'existe pas dans les donnees extraites.</Empty>
      </div>
    )
  }

  const drops = db.dropsByMob.get(id) || []
  const spawns = mob.spawns || []
  const total = spawns.reduce((n, s) => n + s.amount, 0)

  return (
    <div className="detail">
      <header className="detail-head">
        <div>
          <h1>{mob.name}</h1>
          <p className="ids">
            id {mob.id}
            {mob.level !== undefined && <> · niveau {mob.level}</>}
            {mob.sprite && <> · sprite <code>{mob.sprite}</code></>}
          </p>
        </div>
      </header>

      <Section title="Drops" count={drops.length}>
        {!db.hasDrops ? (
          <Empty>
            Aucune table de drop importée. Voir <a href={href({ name: 'data' })}>Données</a>.
          </Empty>
        ) : !drops.length ? (
          <Empty>Aucun drop connu pour ce mob.</Empty>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Taux</th>
                <th className="num">Espérance</th>
              </tr>
            </thead>
            <tbody>
              {drops.map((drop) => {
                const item = db.items.get(drop.item)
                return (
                  <tr key={drop.item}>
                    <td>
                      {item ? <ItemLink item={item} /> : <span className="muted">item {drop.item} (inconnu)</span>}
                    </td>
                    <td className="num"><Chance value={drop.chance} /></td>
                    <td className="num muted">{formatOdds(drop.chance)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Zones" count={spawns.length}>
        {!spawns.length ? (
          <Empty>Aucune zone connue (absent des fichiers de navigation du client).</Empty>
        ) : (
          <>
            <table className="grid">
              <thead>
                <tr>
                  <th>Carte</th>
                  <th className="num">Population</th>
                  <th className="num">Part</th>
                </tr>
              </thead>
              <tbody>
                {spawns.map((spawn) => (
                  <tr key={spawn.map}>
                    <td><MapLink map={db.maps.get(spawn.map) || null} /></td>
                    <td className="num">{spawn.amount}</td>
                    <td className="num muted">{total ? `${Math.round((spawn.amount / total) * 100)} %` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="note">{total} spawns au total sur {spawns.length} carte(s).</p>
          </>
        )}
      </Section>
    </div>
  )
}
