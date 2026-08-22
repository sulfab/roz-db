import type { Db } from '../data'
import { farmSpots, formatOdds } from '../data'
import { ColorText, ItemIcon, MobLink, MapLink, Chance, Section, Empty, usePaged, MoreButton } from '../ui'
import { href } from '../router'

/**
 * La fiche item repond a la question centrale : qui le droppe, a quel taux,
 * et sur quelle carte aller le chercher.
 */
export function ItemDetail({ db, id }: { db: Db; id: number }) {
  const item = db.items.get(id)
  const spots = item ? farmSpots(db, id) : []
  const withMap = spots.filter((s) => s.map)
  const paged = usePaged(withMap, 40)

  if (!item) {
    return (
      <div className="detail">
        <h1>Item {id}</h1>
        <Empty>Cet item n'existe pas dans les donnees extraites.</Empty>
      </div>
    )
  }

  const sources = db.dropsByItem.get(id) || []
  // Un mob peut apparaitre sur plusieurs cartes : on ne le liste qu'une fois,
  // avec sa meilleure zone (farmSpots est deja trie).
  const bestByMob = new Map<number, (typeof spots)[number]>()
  for (const spot of spots) if (!bestByMob.has(spot.mob.id)) bestByMob.set(spot.mob.id, spot)

  return (
    <div className="detail">
      <header className="detail-head">
        <ItemIcon item={item} size={40} />
        <div>
          <h1>
            {item.name}
            {item.slots ? <span className="slots big">[{item.slots}]</span> : null}
          </h1>
          <p className="ids">
            id {item.id}
            {item.res && <> · ressource <code>{item.res}</code></>}
            {item.nameUnid && item.nameUnid !== item.name && <> · non identifie : {item.nameUnid}</>}
          </p>
        </div>
      </header>

      {item.desc?.length ? (
        <Section title="Description">
          <div className="desc">
            {item.desc.map((line, i) => (
              <div key={i}>{line ? <ColorText text={line} /> : ' '}</div>
            ))}
          </div>
        </Section>
      ) : null}

      <Section title="Droppé par" count={sources.length}>
        {!db.hasDrops ? (
          <Empty>
            Aucune table de drop importée. Voir <a href={href({ name: 'data' })}>Données</a> pour
            savoir comment en ajouter une.
          </Empty>
        ) : !sources.length ? (
          <Empty>Aucun mob connu ne droppe cet item.</Empty>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Mob</th>
                <th className="num">Taux</th>
                <th className="num">Espérance</th>
                <th>Meilleure zone</th>
              </tr>
            </thead>
            <tbody>
              {[...bestByMob.values()].map((spot) => (
                <tr key={spot.mob.id}>
                  <td><MobLink mob={spot.mob} /></td>
                  <td className="num"><Chance value={spot.chance} /></td>
                  <td className="num muted">{formatOdds(spot.chance)}</td>
                  <td>
                    {spot.map ? (
                      <>
                        <MapLink map={spot.map} />
                        <span className="amount">×{spot.amount}</span>
                      </>
                    ) : (
                      <span className="muted">aucune zone connue</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {withMap.length > bestByMob.size && (
        <Section title="Toutes les zones de farm" count={withMap.length}>
          <table className="grid">
            <thead>
              <tr>
                <th>Carte</th>
                <th>Mob</th>
                <th className="num">Population</th>
                <th className="num">Taux</th>
              </tr>
            </thead>
            <tbody>
              {paged.visible.map((spot, i) => (
                <tr key={`${spot.mob.id}-${spot.map?.id}-${i}`}>
                  <td><MapLink map={spot.map} /></td>
                  <td><MobLink mob={spot.mob} /></td>
                  <td className="num">{spot.amount}</td>
                  <td className="num"><Chance value={spot.chance} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <MoreButton remaining={paged.remaining} onClick={paged.more} />
        </Section>
      )}
    </div>
  )
}
