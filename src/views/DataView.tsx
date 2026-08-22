import type { Db } from '../data'
import { Section, Empty } from '../ui'

/**
 * Ecran "Donnees" : d'ou sort ce qui est affiche, ce qui manque, et comment
 * completer. C'est ici qu'on regarde quand un chiffre parait faux.
 */
export function DataView({ db }: { db: Db }) {
  const meta = db.meta

  return (
    <div className="detail">
      <h1>Données</h1>

      {!meta ? (
        <Empty>
          Aucune extraction trouvée. Lance <code>npm run extract -- --client "C:\Gravity\Ragnarok Zero"</code>.
        </Empty>
      ) : (
        <>
          <Section title="Extraction">
            <dl className="facts">
              <dt>Générée le</dt>
              <dd>{new Date(meta.generatedAt).toLocaleString('fr-FR')}</dd>
              <dt>Client</dt>
              <dd><code>{meta.client}</code></dd>
              <dt>Archives lues</dt>
              <dd>{meta.archives.join(', ') || '—'}{meta.looseData && ' + dossier data/ en clair'}</dd>
              <dt>Items</dt>
              <dd>{meta.counts.items.toLocaleString('fr-FR')}</dd>
              <dt>Mobs</dt>
              <dd>
                {meta.counts.mobs.toLocaleString('fr-FR')}{' '}
                <span className="muted">dont {meta.counts.mobsWithSpawns} avec au moins une zone</span>
              </dd>
              <dt>Cartes</dt>
              <dd>{meta.counts.maps.toLocaleString('fr-FR')}</dd>
              <dt>Spawns</dt>
              <dd>{meta.counts.spawns.toLocaleString('fr-FR')}</dd>
              {meta.naviFile && (
                <>
                  <dt>Navigation</dt>
                  <dd>
                    <code>{meta.naviFile}</code>
                    {(meta.naviAvailable ?? 0) > 1 && (
                      <span className="muted"> · {meta.naviAvailable} langues disponibles</span>
                    )}
                  </dd>
                </>
              )}
            </dl>
          </Section>

          {meta.naviColumns && (
            <Section title="Colonnes de navigation déduites">
              <p className="note">
                L'ordre des colonnes des fichiers <code>navi_mob_*.lub</code> change d'une version
                à l'autre : il est déduit des données, pas supposé. Si les niveaux ou les
                populations paraissent faux, c'est ici qu'il faut regarder.
              </p>
              <table className="grid">
                <thead>
                  <tr><th>Rôle</th><th className="num">Colonne</th><th className="num">Confiance</th></tr>
                </thead>
                <tbody>
                  {Object.entries(meta.naviColumns).map(([role, index]) => (
                    <tr key={role}>
                      <td>{role}</td>
                      <td className="num">{index < 0 ? 'non trouvée' : index}</td>
                      <td className="num muted">
                        {meta.naviConfidence?.[role] !== undefined
                          ? `${Math.round(meta.naviConfidence[role] * 100)} %`
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}

          <Section title="Fichiers sources" count={meta.sources.length}>
            <ul className="sources">
              {meta.sources.map((source) => <li key={source}><code>{source}</code></li>)}
            </ul>
          </Section>

          {meta.warnings.length > 0 && (
            <Section title="Avertissements" count={meta.warnings.length}>
              <ul className="warnings">
                {meta.warnings.map((warning, i) => <li key={i}>{warning}</li>)}
              </ul>
            </Section>
          )}
        </>
      )}

      <Section title="Tables de drop">
        {db.hasDrops ? (
          <dl className="facts">
            <dt>Source</dt>
            <dd>{db.drops.meta.source || 'inconnue'}</dd>
            <dt>Importées le</dt>
            <dd>{db.drops.meta.importedAt ? new Date(db.drops.meta.importedAt).toLocaleString('fr-FR') : '—'}</dd>
            <dt>Mobs couverts</dt>
            <dd>{db.dropsByMob.size.toLocaleString('fr-FR')}</dd>
            <dt>Entrées</dt>
            <dd>{[...db.dropsByMob.values()].reduce((n, l) => n + l.length, 0).toLocaleString('fr-FR')}</dd>
          </dl>
        ) : (
          <>
            <p className="note">
              Le client ne contient pas les tables de drop : dans le RO officiel elles sont côté
              serveur, et l'encyclopédie en jeu les reçoit par paquet. Tant qu'aucune source n'est
              importée, les colonnes de taux restent vides — tout le reste (items, mobs, cartes,
              zones) fonctionne.
            </p>
            <p className="note">
              Pour en ajouter : un CSV <code>mobId,itemId,taux</code> puis
              <code> npm run import-drops -- drops.csv --source "..." --base 10000</code>.
            </p>
          </>
        )}
      </Section>
    </div>
  )
}
