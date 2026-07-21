// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared types for the injected overlay: the mutable overlay state, the actions
// the UI parts call, and the contracts of each mounted part.
import type { Annotation, SessionMode, ViewportMode } from '../types.js';

/** An annotation re-anchored to a live element on the current route. */
export interface PlacedAnnotation {
  ann: Annotation;
  el: Element;
}

/** Mutable state shared by all overlay parts (single instance per page). */
export interface OverlayState {
  mode: SessionMode;
  author: string;
  debug: boolean;
  viewportMode: ViewportMode;
  annotations: Annotation[];
  picking: boolean;
  hovered: Element | null;
  selected: Element | null;
  /** review: show everything; replay: filter to general + current viewport */
  showAll: boolean;
  placed: PlacedAnnotation[];
  unplaced: Annotation[];
}

/**
 * Actions the overlay parts call back into (wired in main.ts). Property-style
 * signatures on purpose: some of these are passed around detached (e.g.
 * `setUiHidden` is handed to `window.__nitOverlay`).
 */
export interface OverlayActions {
  /** re-anchor annotations and re-render pins/chip */
  refresh: () => void;
  setPicking: (on: boolean) => void;
  hideHighlight: () => void;
  /** chip + panel need to know about picking toggles */
  uiChanged: () => void;
  /** hide the whole overlay (screenshots must never show our UI) */
  setUiHidden: (hidden: boolean) => void;
  setShowAll: (v: boolean) => void;
  onSaved: (annotation: Annotation) => void;
  /** ask the panel window to expand an annotation */
  focusAnnotation: (id: string) => void;
}

/** The hover/selection highlight box. */
export interface Highlight {
  show(el: Element, pinned?: boolean): void;
  hide(): void;
}

/** The element picker (Alt toggles, hover highlights, click selects). */
export interface Picker {
  highlight: Highlight;
  setPicking(on: boolean): void;
}

/** The annotation popover. */
export interface Popover {
  open(el: Element): void;
  close(): void;
  isOpen(): boolean;
}

/** The numbered pins layer. */
export interface Pins {
  render(): void;
  focus(id: string): void;
}

/** The bottom-left chip. */
export interface Chip {
  update(): void;
}

/** All mounted overlay parts. */
export interface OverlayUi {
  host: HTMLElement;
  root: ShadowRoot;
  pins: Pins;
  chip: Chip;
  popover: Popover;
  picker: Picker;
}
