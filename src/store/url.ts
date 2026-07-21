// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Resolve an annotation's route to a navigable url. Annotation files are shared
 * between people and edited by agents, so `route` is untrusted: a crafted
 * `https://evil.com/`, `//evil.com`, or `javascript:` value must never navigate
 * the reviewer's browser. Everything is resolved against the review's own url and
 * rejected unless it stays on that origin over http(s).
 */

/**
 * @param reviewUrl the site under review (`review.url`)
 * @param route the annotation's stored route
 * @returns the absolute url to navigate to, or null when it is unsafe/unusable
 */
export function resolveAnnotationUrl(reviewUrl: string, route: string | undefined): string | null {
  let base: URL;
  try {
    base = new URL(reviewUrl);
  } catch {
    return null;
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') return null;

  // An empty string means the same thing as `undefined` here — "go to the
  // root" — so it is normalized away before falling back with `??`, keeping
  // the fallback itself nullish-coalescing (satisfies
  // @typescript-eslint/prefer-nullish-coalescing) without treating `''` as a
  // meaningful route.
  const normalizedRoute = route === '' ? undefined : route;

  let target: URL;
  try {
    target = new URL(normalizedRoute ?? '/', base);
  } catch {
    return null;
  }
  // `origin` is 'null' for opaque schemes (javascript:, data:), so a scheme check
  // is not enough on its own — but combined they reject every escape route.
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
  return target.origin === base.origin ? target.href : null;
}
