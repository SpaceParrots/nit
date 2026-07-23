// SPDX-License-Identifier: AGPL-3.0-or-later
// The panel document shell: everything static. The interactive parts are built by
// the bundled panel script (src/panel/main.ts), which is injected after this loads.
import { ICONS } from './icons.js';
import { NIT_LOGO_DATA_URI } from './logo.js';

/** The panel window's initial HTML (no script tag — the bundle is added after). */
export const PANEL_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>nit panel</title>
</head>
<body>
<header>
  <img class="logo-img" src="${NIT_LOGO_DATA_URI}" alt="" width="18" height="18">
  <span class="logo">nit</span>
  <span class="mode" id="mode"></span>
</header>
<div class="controls">
  <button id="pick" class="btn nit-pick" title="Pick an element (Alt)">${ICONS.crosshair}<span id="pick-label">Pick element</span></button>
  <div class="vp">
    <button class="btn icon-btn nit-vp-desktop" data-vp="desktop" title="Desktop viewport" aria-label="Desktop viewport">${ICONS.monitor}</button>
    <button class="btn icon-btn nit-vp-mobile" data-vp="mobile" title="Mobile viewport" aria-label="Mobile viewport">${ICONS.smartphone}</button>
    <button class="btn icon-btn nit-filter-btn" id="filter-btn" title="Sort, group and filter" aria-label="Sort, group and filter" aria-expanded="false">${ICONS.filter}</button>
  </div>
  <div class="menu" id="filter-menu" hidden></div>
</div>
<div id="verify" class="verify" hidden></div>
<div id="list" class="list"></div>
<div id="unplaced" class="unplaced" hidden>
  <div class="unplaced-head" id="unplaced-head"></div>
  <div id="unplaced-list"></div>
</div>
<footer>
  <div class="count" id="count"></div>
  <button id="finish" class="btn btn-primary nit-finish">${ICONS.check}Finish review</button>
</footer>
</body>
</html>`;
