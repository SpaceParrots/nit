// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Route helpers shared by the overlay (which captures routes) and the panel
 * (which groups by them). Pure and DOM-free so both sides — and the unit tests —
 * can use them.
 */

/** The parts of `window.location` a route is built from. */
export interface RouteLocation {
  pathname: string;
  search: string;
  hash: string;
}

/**
 * The route recorded on an annotation: path plus query and hash, so a
 * query-driven page (`?id=5`, `#tab`) can be navigated back to exactly.
 * The origin is deliberately excluded — navigation resolves it from the url the
 * session actually opened (`NitSession.targetUrl`, which `--url` overrides), which
 * is what lets a review captured on staging replay against localhost. It is not
 * taken from the annotations file: that content is shared and agent-written.
 */
export function currentRoute(loc: RouteLocation): string {
  return `${loc.pathname}${loc.search}${loc.hash}`;
}

/**
 * The pathname portion of a stored route. Pin placement matches on this, so an
 * annotation captured at `/products?id=5` still anchors on `/products` and every
 * review file written before routes carried queries behaves as it always did.
 */
export function routePath(route: string | undefined): string {
  const value = route ?? '';
  const cut = value.search(/[?#]/);
  const path = cut === -1 ? value : value.slice(0, cut);
  return path || '/';
}

/**
 * The part of a route that identifies "the same page" for navigation purposes:
 * pathname plus query, with the hash dropped. `__nitGoTo` (src/browser/bridge.ts)
 * treats two routes as already-the-same-page by this exact rule before deciding
 * whether a navigation is even needed; the panel's "go to page" button disables
 * itself using this same helper so the two can never drift apart — a button
 * that looks enabled always corresponds to a real navigation, and vice versa.
 */
export function routeKey(route: string | undefined): string {
  const value = route ?? '';
  const cut = value.indexOf('#');
  const pathAndSearch = cut === -1 ? value : value.slice(0, cut);
  return pathAndSearch || '/';
}
