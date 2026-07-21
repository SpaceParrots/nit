/**
 * Central JSDoc typedefs for nit's data model (SPEC §3). The annotations.json
 * schema is the public contract between the capture tool, the replay/verify
 * modes, the merge command, the MCP server, and any coding agent consuming it.
 *
 * Reference these from other files with e.g.
 *   @param {import('../types.js').Annotation} annotation
 */

/**
 * @typedef {'change-request' | 'comment'} AnnotationType
 * `change-request` is actionable for a fixing agent; `comment` is context only.
 */

/**
 * @typedef {'open' | 'fixed' | 'wontfix' | 'verified' | 'reopened'} AnnotationStatus
 * Lifecycle: `open` → (agent) `fixed` → (nit verify) `verified` | `reopened`.
 * `reopened` change-requests are actionable again.
 */

/**
 * @typedef {'general' | 'desktop' | 'mobile'} ViewportScope
 * Which viewports an annotation applies to; replay filters by the active mode.
 */

/**
 * @typedef {object} Rect
 * Absolute page coordinates (CSS pixels, independent of scroll position).
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 */

/**
 * @typedef {object} Viewport
 * The viewport an annotation was captured at.
 * @property {'desktop' | 'mobile'} mode
 * @property {number} w width in CSS pixels
 * @property {number} h height in CSS pixels
 */

/**
 * @typedef {object} Target
 * Layered reference to the annotated element (SPEC §4). Every layer is captured
 * so replay/fixing degrade gracefully when the page changes.
 * @property {string} component nearest custom-element tag (e.g. `app-product-tile`), or the element's own tag
 * @property {string | null} ngComponent Angular component class name via `window.ng` (null on production builds)
 * @property {string} selector short CSS selector, verified unique at capture time — the primary replay anchor
 * @property {string} xpath absolute XPath with per-tag indices — the secondary replay anchor
 * @property {string} tag the element's own tag name (lowercase)
 * @property {string[]} classes the element's classes (Angular runtime classes filtered out)
 * @property {string} text normalized text content, capped at 80 chars — the last-resort replay anchor
 * @property {Rect} rect element bounding box in absolute page coordinates
 */

/**
 * @typedef {object} Annotation
 * One captured note, tied to a stable element reference.
 * @property {string} id stable id (`a1`, `a2`, …); merge namespaces it per author (`kevin:a1`)
 * @property {AnnotationType} type
 * @property {string} comment what the reviewer wants changed (or remarked)
 * @property {AnnotationStatus} status
 * @property {string} author
 * @property {ViewportScope} viewportScope
 * @property {Viewport} viewport
 * @property {string} route pathname the annotation belongs to; replay shows it on this route
 * @property {Target} target
 * @property {string | null} screenshot path of the cropped element screenshot, relative to the review dir
 * @property {string} [screenshotAfter] "after" screenshot captured by `nit verify`, relative to the review dir
 * @property {string} createdAt ISO timestamp
 * @property {string} [verifiedAt] ISO timestamp of the verified/reopened verdict
 */

/**
 * @typedef {object} Review
 * Review metadata.
 * @property {string} id e.g. `2026-07-20-example.com`
 * @property {string} url the site under review
 * @property {string} createdAt ISO timestamp
 * @property {string[]} authors union of all annotation authors
 */

/**
 * @typedef {object} ReviewData
 * The full shape of an annotations.json file.
 * @property {Review} review
 * @property {Annotation[]} annotations
 */

export {};
