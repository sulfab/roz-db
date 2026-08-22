import type { Db } from '../data'
import { mapLoot } from '../data'
import { ItemLink, MobLink, Chance, Section, Empty, usePaged, MoreButton, Population } from '../ui'

/** Fiche carte : qui y vit, et tout ce qui peut y tomber. */
export function MapDetail({ db, id }: { db: Db; id: string }) {
  const map = db.maps.get(id)
  const loot = map ? mapLoot(db, map) : []
  const paged = usePaged(loot, 60)

  if (!map) {
    return (
      <div className="detail">
        <h1>{id}</h1>
        <Empty>Cette carte n'existe pas dans les donnees extraites.</Empty>
      </div>
    )
  }

  const total = map.mobs.reduce((n, m) => n + (m.amount ?? 0), 0)

  return (
    <div className="detail">
      <header className="detail-head">
        <div>
          <h1>{map.name}</h1>
          <p className="ids">
            <code>{map.id}</code>
            {db.hasPopulations && <> · {total} spawns</>} · {map.mobs.length} espèce(s)
          </p>
        </div>
      </header>

      <Section title="Monstres" count={map.mobs.length}>
        {!map.mobs.length ? (
          <Empty>Aucun monstre repertorie sur cette carte (ville, donjon d'instance, ou absent du navi).</Empty>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Mob</th>
                <th className="num">Population</th>
                <th className="num">Drops connus</th>
              </tr>
            </thead>
            <tbody>
              {map.mobs.map((entry) => {
                const mob = db.mobs.get(entry.id)
                return (
                  <tr key={entry.id}>
                    <td>{mob ? <MobLink mob={mob} /> : <span className="muted">mob {entry.id}</span>}</td>
                    <td className="num"><Population amount={entry.amount} /></td>
                    <td className="num muted">{(db.dropsByMob.get(entry.id) || []).length || '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Butin possible ici" count={loot.length}>
        {!db.hasDrops ? (
          <Empty>Aucune table de drop importée.</Empty>
        ) : !loot.length ? (
          <Empty>Aucun drop connu pour les monstres de cette carte.</Empty>
        ) : (
          <>
            <table className="grid">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Meilleur taux</th>
                  <th>Via</th>
                </tr>
              </thead>
              <tbody>
                {paged.visible.map((row) => (
                  <tr key={row.item.id}>
                    <td><ItemLink item={row.item} /></td>
                    <td className="num"><Chance value={row.chance} /></td>
                    <td><MobLink mob={row.mob} /></td>
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
