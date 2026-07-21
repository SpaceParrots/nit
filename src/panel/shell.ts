// SPDX-License-Identifier: AGPL-3.0-or-later
// The panel document shell: everything static. The interactive parts are built by
// the bundled panel script (src/panel/main.ts), which is injected after this loads.

/** The panel window's initial HTML (no script tag — the bundle is added after). */
export const PANEL_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>nit panel</title>
</head>
<body>
<header><span class="logo">nit</span><span class="mode" id="mode"></span></header>
<div class="controls">
  <button id="pick" class="btn nit-pick">Pick element (Alt)</button>
  <div class="vp">
    <button class="btn nit-vp-desktop" data-vp="desktop">Desktop</button>
    <button class="btn nit-vp-mobile" data-vp="mobile">Mobile</button>
  </div>
  <button id="filter" class="btn nit-filter"></button>
  <button id="finish" class="btn nit-finish">Finish review</button>
</div>
<div id="list" class="list"></div>
<div id="unplaced" class="unplaced" hidden>
  <div class="unplaced-head" id="unplaced-head"></div>
  <div id="unplaced-list"></div>
</div>
</body>
</html>`;
