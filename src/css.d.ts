// SPDX-License-Identifier: AGPL-3.0-or-later
// CSS files are imported as raw text (esbuild `text` loader bundles them into
// the overlay IIFE; tsc only needs to know the module shape).
declare module '*.css' {
  const css: string;
  export default css;
}
