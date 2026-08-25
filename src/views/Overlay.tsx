import { useEffect, useMemo, useRef, useState } from 'react'
import type { Db } from '../data'
import { Empty } from '../ui'

/**
 * Surimpression temps reel, pendant que tu joues.
 *
 * Elle ne lit rien du jeu : elle affiche ce que `npm run watch` a compris du
 * trafic reseau et deverse dans la base. Les deux vont ensemble — la boucle de
 * capture remplit observations.json, l'overlay en est la fenetre.
 *
 * Toujours au premier plan : Chrome sait ouvrir une fenetre d'incrustation
 * video contenant du HTML quelconque, et cette fenetre-la reste au-dessus des
 * autres sans outil externe ni droits d'administrateur. Le jeu doit tourner en
 * fenetre sans bordure : un plein ecran exclusif passe devant tout, y compris
 * elle.
 */

const SOURCE = 'http://localhost:7355'

interface DropObserve {
  objet: number
  fois: number
  /** null tant qu'aucune mort n'a ete observee : un comptage sans denominateur. */
  taux: number | null
}

interface MobObserve {
  id: number
  nom: string
  nomClient: string | null
  nomServeur: string | null
  vues: number
  morts: number
  drops: DropObserve[]
}

interface Etat {
  carte: string | null
  morceaux: number
  octets: number
  mobs: MobObserve[]
  cartes: Record<string, { especes: Record<string, number> }>
}

/**
 * Suit le flux de la boucle de capture.
 *
 * Le serveur pousse un evenement a chaque morceau analyse ; s'il n'est pas la,
 * on le dit franchement au lieu d'afficher une page vide qui laisserait croire
 * qu'il n'y a rien a voir.
 */
function useEtat(): { etat: Etat | null; connecte: boolean } {
  const [etat, setEtat] = useState<Etat | null>(null)
  const [connecte, setConnecte] = useState(false)

  useEffect(() => {
    let source: EventSource | null = null
    let retry: number | undefined

    const brancher = () => {
      source = new EventSource(`${SOURCE}/flux`)
      source.onopen = () => setConnecte(true)
      source.onmessage = (e) => {
        try { setEtat(JSON.parse(e.data)) } catch { /* morceau tronque : on attend le suivant */ }
      }
      source.onerror = () => {
        setConnecte(false)
        source?.close()
        retry = window.setTimeout(brancher, 3000)
      }
    }
    brancher()
    return () => { source?.close(); if (retry) window.clearTimeout(retry) }
  }, [])

  return { etat, connecte }
}

/** L'API n'existe pas partout : on ne propose le bouton que si elle est la. */
type PipWindow = Window & { document: Document }
interface PipApi { requestWindow(options: { width: number; height: number }): Promise<PipWindow> }
const pipApi = (): PipApi | null =>
  (window as unknown as { documentPictureInPicture?: PipApi }).documentPictureInPicture ?? null

export function Overlay({ db }: { db: Db }) {
  const { etat, connecte } = useEtat()
  const [choisi, setChoisi] = useState<number | null>(null)
  const [detache, setDetache] = useState(false)
  const [erreur, setErreur] = useState<string | null>(null)
  const racine = useRef<HTMLDivElement>(null)
  const ancre = useRef<HTMLDivElement>(null)

  const surCarte = useMemo(() => {
    if (!etat) return []
    if (!etat.carte) return etat.mobs
    const especes = etat.cartes[etat.carte]?.especes ?? {}
    return etat.mobs
      .filter((m) => especes[String(m.id)])
      .sort((a, b) => (especes[String(b.id)] ?? 0) - (especes[String(a.id)] ?? 0))
  }, [etat])

  /**
   * Deplace la liste dans une fenetre d'incrustation.
   *
   * Le noeud est deplace, pas recopie : React continue de le mettre a jour
   * comme si de rien n'etait, et l'affichage reste vivant dans la nouvelle
   * fenetre. En contrepartie il faut le ramener quand elle se ferme, sinon la
   * page d'origine reste vide.
   */
  const detacher = async () => {
    const api = pipApi()
    if (!api || !racine.current) return

    let fenetre: PipWindow
    try {
      fenetre = await api.requestWindow({ width: 380, height: 520 })
    } catch (err) {
      // Chrome refuse sans geste de l'utilisateur, ou si une incrustation est
      // deja ouverte. Autant le dire que laisser le bouton sans effet.
      setErreur(err instanceof Error ? err.message : String(err))
      return
    }

    for (const feuille of Array.from(document.styleSheets)) {
      try {
        const css = Array.from(feuille.cssRules).map((r) => r.cssText).join('\n')
        const style = fenetre.document.createElement('style')
        style.textContent = css
        fenetre.document.head.appendChild(style)
      } catch { /* feuille d'une autre origine : rien a copier */ }
    }
    fenetre.document.body.classList.add('overlay-detache')
    fenetre.document.body.appendChild(racine.current)
    setDetache(true)

    fenetre.addEventListener('pagehide', () => {
      if (racine.current && ancre.current) ancre.current.appendChild(racine.current)
      setDetache(false)
    })
  }

  return (
    <div className="detail overlay">
      <header className="overlay-tete">
        <div>
          <h1>Surimpression</h1>
          <p className="sous-titre">
            {connecte
              ? `${etat?.carte ?? 'carte inconnue'} — ${surCarte.length} espèce(s) vue(s)`
              : 'en attente de la capture'}
          </p>
        </div>
        {pipApi() ? (
          <button type="button" onClick={detacher} disabled={detache}>
            {detache ? 'Fenêtre ouverte' : 'Toujours au-dessus'}
          </button>
        ) : (
          <p className="sous-titre">
            Ton navigateur ne sait pas ouvrir de fenêtre toujours au-dessus. Il faut Chrome ou
            Edge 116+, et une adresse en <code>localhost</code> ou <code>https</code>.
          </p>
        )}
      </header>

      {erreur && <p className="avertissement">Fenêtre refusée : {erreur}</p>}
      {detache && (
        <p className="sous-titre">
          La liste est dans la fenêtre d'incrustation. Ferme-la pour la ramener ici.
        </p>
      )}

      <div ref={ancre}>
      <div ref={racine} className="overlay-corps">
        {!connecte && (
          <Empty>
            La boucle de capture ne répond pas sur <code>{SOURCE}</code>. Ouvre un terminal en
            administrateur et lance <code>npm run watch</code>, avant le jeu.
          </Empty>
        )}

        {connecte && !surCarte.length && (
          <Empty>
            Rien encore. Traverse la carte : chaque monstre croisé donne son espèce. Survole-les
            pour que le serveur envoie leur nom.
          </Empty>
        )}

        <ul className="overlay-mobs">
          {surCarte.map((mob) => (
            <li key={mob.id}>
              <button
                type="button"
                className={choisi === mob.id ? 'choisi' : ''}
                onClick={() => setChoisi(choisi === mob.id ? null : mob.id)}
              >
                <span className="nom">{mob.nom}</span>
                <span className="chiffres">
                  {mob.vues} vu{mob.vues > 1 ? 's' : ''}
                  {mob.morts > 0 && ` · ${mob.morts} tué${mob.morts > 1 ? 's' : ''}`}
                </span>
              </button>
              {choisi === mob.id && <Butin mob={mob} db={db} />}
            </li>
          ))}
        </ul>
      </div>
      </div>
    </div>
  )
}

/**
 * Butin d'une espece.
 *
 * Deux sources, jamais melangees : ce que le serveur a laisse voir tomber
 * pendant cette session, et la table importee si elle existe. La premiere est
 * un comptage — elle ne vaut que par le nombre de morts derriere elle, et c'est
 * pour ca qu'il est toujours affiche.
 */
function Butin({ mob, db }: { mob: MobObserve; db: Db }) {
  const table = db.dropsByMob.get(mob.id) ?? []
  const nomObjet = (id: number) => db.items.get(id)?.name ?? `objet ${id}`

  return (
    <div className="overlay-butin">
      {mob.drops.length > 0 && (
        <>
          <h3>Observé cette session</h3>
          <ul>
            {mob.drops.map((d) => (
              <li key={d.objet}>
                <span>{nomObjet(d.objet)}</span>
                <span className="taux">
                  {d.taux === null
                    ? `${d.fois}×, aucune mort comptée`
                    : `${(d.taux * 100).toFixed(1)} % (${d.fois}/${mob.morts})`}
                </span>
              </li>
            ))}
          </ul>
          {mob.morts < 30 && (
            <p className="avertissement">
              {mob.morts} mort{mob.morts > 1 ? 's' : ''} observée{mob.morts > 1 ? 's' : ''} : bien
              trop peu pour un taux fiable.
            </p>
          )}
        </>
      )}

      {table.length > 0 && (
        <>
          <h3>Table importée</h3>
          <ul>
            {table.map((d) => (
              <li key={d.item}>
                <span>{nomObjet(d.item)}</span>
                <span className="taux">{d.chance} %</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {!mob.drops.length && !table.length && (
        <p className="avertissement">Rien vu tomber, et aucune table importée pour cette espèce.</p>
      )}
    </div>
  )
}
