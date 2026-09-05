// Hand-written declaration for origin-routes.mjs (plain .mjs by design — see that file's header:
// importable by the dev proxy, the checker and the release probe generator without a build step).
// With `moduleResolution: Bundler`, tsc resolves a `.mjs` import against a colocated `.d.mts` — this
// file — rather than requiring the source itself to be TypeScript.
export interface OriginRoute {
  path: string
  upstream: 'server' | 'collab' | 'web'
  strip: boolean
  exact: boolean
  ws: boolean
  why: string
}

export interface SiblingHost {
  subdomain: string
  upstream: string
  port: number
  strip: boolean
  why: string
}

export const ORIGIN_ROUTES: OriginRoute[]
export const SIBLING_HOSTS: SiblingHost[]
export const PROXIED_ROUTES: OriginRoute[]
export const NOT_EDGE_ROUTES: string[]
