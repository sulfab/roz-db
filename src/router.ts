import { useEffect, useState } from 'react'

/**
 * Routeur minimal sur le hash. Pas de dependance : l'app tient en une poignee
 * d'ecrans et doit s'ouvrir depuis un simple fichier local.
 */

export type Route =
  | { name: 'home' }
  | { name: 'items'; query: string }
  | { name: 'item'; id: number }
  | { name: 'mobs'; query: string }
  | { name: 'mob'; id: number }
  | { name: 'maps'; query: string }
  | { name: 'map'; id: string }
  | { name: 'data' }

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '')
  const [pathPart, queryPart] = raw.split('?')
  const segments = pathPart.split('/').filter(Boolean).map(decodeURIComponent)
  const query = new URLSearchParams(queryPart || '').get('q') || ''

  switch (segments[0]) {
    case 'item': return { name: 'item', id: Number(segments[1]) }
    case 'mob': return { name: 'mob', id: Number(segments[1]) }
    case 'map': return { name: 'map', id: segments[1] || '' }
    case 'items': return { name: 'items', query }
    case 'mobs': return { name: 'mobs', query }
    case 'maps': return { name: 'maps', query }
    case 'data': return { name: 'data' }
    default: return { name: 'home' }
  }
}

export function href(route: Route): string {
  switch (route.name) {
    case 'item': return `#/item/${route.id}`
    case 'mob': return `#/mob/${route.id}`
    case 'map': return `#/map/${encodeURIComponent(route.id)}`
    case 'items': return route.query ? `#/items?q=${encodeURIComponent(route.query)}` : '#/items'
    case 'mobs': return route.query ? `#/mobs?q=${encodeURIComponent(route.query)}` : '#/mobs'
    case 'maps': return route.query ? `#/maps?q=${encodeURIComponent(route.query)}` : '#/maps'
    case 'data': return '#/data'
    default: return '#/'
  }
}

export function navigate(route: Route) {
  window.location.hash = href(route)
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash))
  useEffect(() => {
    const onChange = () => {
      setRoute(parseHash(window.location.hash))
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}
