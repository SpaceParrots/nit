// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Central type definitions for nit's data model (SPEC §3) and the bridge
 * contract between the injected overlay / panel window and Node.
 *
 * The annotations.json schema is the public contract between the capture tool,
 * the replay/verify modes, the merge command, the MCP server, and any coding
 * agent consuming it.
 */

/** `change-request` is actionable for a fixing agent; `comment` is context only. */
export type AnnotationType = 'change-request' | 'comment';

/**
 * Lifecycle: `open` → (agent) `fixed` → (nit verify) `verified` | `reopened`.
 * `reopened` change-requests are actionable again.
 */
export type AnnotationStatus = 'open' | 'fixed' | 'wontfix' | 'verified' | 'reopened';

/** Which viewports an annotation applies to; replay filters by the active mode. */
export type ViewportScope = 'general' | 'desktop' | 'mobile';

/** The two viewport presets a session can run in. */
export type ViewportMode = 'desktop' | 'mobile';

/** What a browser session is doing: capture, replay, or fix-verification. */
export type SessionMode = 'review' | 'view' | 'verify';

/** Absolute page coordinates (CSS pixels, independent of scroll position). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The viewport an annotation was captured at. */
export interface Viewport {
  mode: ViewportMode;
  /** width in CSS pixels */
  w: number;
  /** height in CSS pixels */
  h: number;
}

/**
 * Layered reference to the annotated element (SPEC §4). Every layer is captured
 * so replay/fixing degrade gracefully when the page changes.
 */
export interface Target {
  /** nearest custom-element tag (e.g. `app-product-tile`), or the element's own tag */
  component: string;
  /** Angular component class name via `window.ng` (null on production builds) */
  ngComponent: string | null;
  /** short CSS selector, verified unique at capture time — the primary replay anchor */
  selector: string;
  /** absolute XPath with per-tag indices — the secondary replay anchor */
  xpath: string;
  /** the element's own tag name (lowercase) */
  tag: string;
  /** the element's classes (Angular runtime classes filtered out) */
  classes: string[];
  /** normalized text content, capped at 80 chars — the last-resort replay anchor */
  text: string;
  /** element bounding box in absolute page coordinates */
  rect: Rect;
}

/** One recorded page click leading up to an annotation (reproduction trail). */
export interface ClickStep {
  /** short CSS selector, built at click time (the element may be gone later) */
  selector: string;
  tag: string;
  /** nearest custom-element tag */
  component: string;
  /** visible text, whitespace-normalized, capped at 80 chars */
  text: string;
  /** ISO timestamp */
  at: string;
}

/** One captured note, tied to a stable element reference. */
export interface Annotation {
  /** stable id (`a1`, `a2`, …); merge namespaces it per author (`kevin:a1`) */
  id: string;
  type: AnnotationType;
  /** what the reviewer wants changed (or remarked) */
  comment: string;
  status: AnnotationStatus;
  author: string;
  viewportScope: ViewportScope;
  viewport: Viewport;
  /** pathname the annotation belongs to; replay shows it on this route */
  route: string;
  target: Target;
  /** path of the cropped element screenshot, relative to the review dir */
  screenshot: string | null;
  /** "after" screenshot captured by `nit verify`, relative to the review dir */
  screenshotAfter?: string;
  /** ISO timestamp */
  createdAt: string;
  /** ISO timestamp of the verified/reopened verdict */
  verifiedAt?: string;
  /** free-form issue key or URL: `FAI-1234`, `#87`, `https://…/browse/FAI-1234` */
  issueRef?: string;
  /** ISO timestamp of the last change to this annotation (status, issueRef) */
  updatedAt?: string;
  /** who made that change: the session author, or `agent` via MCP */
  updatedBy?: string;
  /** last ≤10 page clicks on this pathname before capture, oldest first */
  history?: ClickStep[];
}

/** Review metadata. */
export interface Review {
  /** e.g. `2026-07-20-example.com` */
  id: string;
  /** the site under review */
  url: string;
  /** ISO timestamp */
  createdAt: string;
  /** union of all annotation authors */
  authors: string[];
}

/** The full shape of an annotations.json file. */
export interface ReviewData {
  review: Review;
  annotations: Annotation[];
}

// ---------------------------------------------------------------------------
// Bridge contract: the `window.__nit*` bindings exposed by Node (bridge.ts)
// and consumed by the injected overlay (src/overlay) and the panel window.
// ---------------------------------------------------------------------------

/** Injected as `window.__NIT_CONFIG` before the overlay bundle. */
export interface OverlayConfig {
  mode: SessionMode;
  debug: boolean;
}

/** What the overlay hands to `__nitSave` after the reviewer hits Save. */
export interface SavePayload {
  comment: string;
  type: AnnotationType;
  viewportScope: ViewportScope;
  target: Target;
  route: string;
  /** snapshot of the click trail on this pathname (see {@link ClickStep}) */
  history?: ClickStep[];
}

/** Result envelope shared by the mutating bindings. */
export type BridgeResult<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

export type SaveResult = BridgeResult<{ annotation: Annotation }>;
/** Envelope for bindings that return the annotation they changed. */
export type AnnotationResult = BridgeResult<{ annotation: Annotation }>;
/** @deprecated use {@link AnnotationResult} — kept for one version */
export type VerdictResult = AnnotationResult;
export type GoToResult = BridgeResult<{ url: string }>;
export type ViewportResult = BridgeResult<{ mode: ViewportMode; w: number; h: number }>;

/** Session snapshot returned by `__nitLoad` (overlay boot/resync). */
export interface LoadResult {
  mode: SessionMode;
  author: string;
  viewportMode: ViewportMode;
  debug: boolean;
  annotations: Annotation[];
}

/** A re-anchored annotation with its live element rect, as reported by the overlay. */
export interface PlacedRef {
  id: string;
  rect: Rect;
}

/** Debug telemetry: a page click (only emitted with `--debug`). */
export interface OverlayClickEvent {
  type: 'click';
  x: number;
  y: number;
  tag: string;
}

/** Overlay UI state, re-emitted on every refresh; drives panel + verify capture. */
export interface OverlayUiEvent {
  type: 'ui';
  route: string;
  picking: boolean;
  showAll: boolean;
  placed: PlacedRef[];
  unplaced: string[];
}

/** Request to focus an annotation in the panel window. */
export interface OverlayFocusEvent {
  type: 'focus';
  id: string;
}

export type OverlayEvent = OverlayClickEvent | OverlayUiEvent | OverlayFocusEvent;

/** Commands the panel window sends to the overlay (relayed through Node). */
export type PanelCmd =
  | { cmd: 'togglePick' }
  | { cmd: 'toggleShowAll' }
  | { cmd: 'focus'; id: string };

/** State polled by the panel window via `__nitPanelState`. */
export interface PanelState {
  mode: SessionMode;
  author: string;
  viewportMode: ViewportMode;
  picking: boolean;
  showAll: boolean;
  route: string;
  placed: string[];
  unplaced: string[];
  annotations: Annotation[];
}

/** The in-page API the overlay exposes for Node to drive (panel relay, verify shots). */
export interface OverlayApi {
  cmd: (c: PanelCmd) => void;
  setUiHidden: (hidden: boolean) => void;
}

declare global {
  interface Window {
    /** session config injected before the overlay bundle (inject.ts) */
    __NIT_CONFIG?: OverlayConfig;
    /** overlay boot guard — init scripts run on every navigation */
    __NIT_BOOTED__?: boolean;
    __nitSave?: (payload: SavePayload) => Promise<SaveResult>;
    __nitLoad?: () => Promise<LoadResult>;
    __nitSetViewport?: (mode: ViewportMode) => Promise<ViewportResult>;
    __nitShot?: (id: string, which?: 'after') => Promise<string | null>;
    __nitVerdict?: (id: string, verdict: 'verified' | 'reopened') => Promise<VerdictResult>;
    __nitSetIssueRef?: (id: string, ref: string) => Promise<AnnotationResult>;
    __nitGoTo?: (id: string) => Promise<GoToResult>;
    /** stage a screenshot at pick time, while transient state (dropdowns) is still visible */
    __nitStageShot?: (rect: Rect) => Promise<{ ok: boolean }>;
    __nitDelete?: (id: string) => Promise<{ ok: boolean }>;
    __nitFinish?: () => Promise<{ ok: boolean }>;
    __nitEvent?: (evt: OverlayEvent) => Promise<void>;
    __nitPanelState?: () => Promise<PanelState>;
    __nitPanelCmd?: (cmd: PanelCmd) => Promise<BridgeResult>;
    /** installed by the panel window's own bundle (src/panel/main.ts) */
    __nitPanelFocus?: (id: string) => void;
    /** installed by the overlay (main.ts) for Node to drive */
    __nitOverlay?: OverlayApi;
    /** Angular debug API — present on dev/staging builds only */
    ng?: { getComponent?: (el: Element) => unknown };
  }
}
