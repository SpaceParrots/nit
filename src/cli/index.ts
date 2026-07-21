#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// nit — point-and-click website annotation for coding agents.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, Option } from 'commander';
import { runMerge } from './merge.js';
import { runDoctor } from './doctor.js';
import { startSession } from '../browser/session.js';
import type { NitSession } from '../browser/session.js';
import { startMcpServer } from '../mcp/server.js';
import { errorMessage } from '../util/error.js';
import type { SessionMode } from '../types.js';

const pkg = JSON.parse(fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8')) as { version: string };

/** Options shared by every command that launches a browser. */
interface BrowserCmdOptions {
  mobile?: boolean;
  device?: 'desktop' | 'mobile';
  headless?: boolean;
  debug?: boolean;
  /** view/verify: open this url instead of the one stored in the feedback file */
  url?: string;
  /** review: output directory */
  out?: string;
  /** review: author recorded on each annotation */
  author?: string;
}

const program = new Command();

program
  .name('nit')
  .description('Point-and-click website annotation that hands small UI fixes to a coding agent.\n'
    + 'Annotate any site in a real browser; nit writes a structured review folder\n'
    + '(annotations.json + review.md + screenshots) that an agent fixes directly.')
  .version(pkg.version)
  .showHelpAfterError('(run "nit <command> --help" for details)')
  .showSuggestionAfterError()
  .addHelpText('after', `
The loop:
  1. nit review https://staging.example.com      annotate the site -> nit-review/
  2. hand nit-review/ to a coding agent          (or serve it: nit mcp nit-review)
  3. nit verify nit-review/annotations.json      rule each fix Verified / Reopen

Examples:
  $ nit review http://localhost:4200 --mobile --author Ann
  $ nit view feedback-ann.json --url https://staging.example.com
  $ nit merge feedback-kevin.json feedback-ann.json --out review-merged
  $ claude mcp add nit -- nit mcp ./nit-review`);

/** Attach the options shared by every command that launches a browser. */
function withBrowserOptions(cmd: Command): Command {
  return cmd
    .option('-m, --mobile', 'start in the mobile viewport (390×844) instead of desktop (1440×900)')
    .addOption(new Option('-d, --device <mode>', 'explicit start viewport').choices(['desktop', 'mobile']))
    .option('--headless', 'run the browser headless (for automation/CI)')
    .option('--debug', 'verbose overlay logging (every page click is logged to stdout)');
}

withBrowserOptions(
  program.command('review')
    .aliases(['r', 'annotate'])
    .summary('open a browser and annotate a site')
    .description('Open a real Chromium with the nit overlay and annotate any website — live,\n'
      + 'staging, or http://localhost.\n\n'
      + 'Press Alt (or click the nit chip bottom-left) to toggle element picking, click an\n'
      + 'element, describe the change, pick a type (change request / comment) and a viewport\n'
      + 'scope, then Save. The nit panel window next to the browser lists annotations,\n'
      + 'switches desktop/mobile, deletes items, and finishes the review.\n\n'
      + 'Writes <out>/annotations.json, review.md, fix-annotations.md and shots/*.png.')
    .argument('<url>', 'page to open (https:// is assumed when no scheme is given)')
    .option('-o, --out <dir>', 'output directory', 'nit-review')
    .option('-a, --author <name>', 'author recorded on each annotation (default: your OS user name)'))
  .action(async (url: string, opts: BrowserCmdOptions) => {
    const session = await startBrowser('review', { url, opts });
    console.log(`nit review — ${url}`);
    console.log('Alt: toggle picking · Esc: cancel · use the panel window · close the browser (or Finish review) when done.');
    await session.done;
    summarize(session);
  });

withBrowserOptions(
  program.command('view')
    .aliases(['v', 'replay'])
    .summary('replay a feedback file on the live site')
    .description('Reload a feedback file and re-view its annotations as numbered pins, re-anchored\n'
      + 'on the pages/routes where they were made and filtered by the active viewport.\n'
      + 'Annotations that cannot be re-anchored land in the panel’s "couldn’t place" list.')
    .argument('<file>', 'a nit feedback file (annotations.json)')
    .option('-u, --url <url>', 'open this url instead of the one stored in the feedback file'))
  .action(async (file: string, opts: BrowserCmdOptions) => {
    const session = await startBrowser('view', { file, opts });
    console.log(`nit view — replaying ${file}`);
    console.log('Navigate the site; pins appear on the routes they were made on. Close the browser when done.');
    await session.done;
  });

withBrowserOptions(
  program.command('verify')
    .aliases(['check'])
    .summary('capture after-shots for fixed items and rule Verified / Reopen')
    .description('Close the loop after an agent marked change requests "fixed": nit re-opens the\n'
      + 'site, re-anchors each fixed annotation on its route, and captures an "after"\n'
      + 'screenshot next to the original (if the element is gone, the originally recorded\n'
      + 'region is captured instead). Rule each item Verified or Reopen in the panel —\n'
      + 'reopened items become actionable again for the next fix round.')
    .argument('<file>', 'a nit feedback file (annotations.json)')
    .option('-u, --url <url>', 'open this url instead of the one stored in the feedback file'))
  .action(async (file: string, opts: BrowserCmdOptions) => {
    const session = await startBrowser('verify', { file, opts });
    console.log(`nit verify — ${file}`);
    console.log('Visit the routes of fixed annotations; after-shots are captured automatically.');
    console.log('Rule each fixed item Verified or Reopen in the panel, then close the browser.');
    await session.done;
  });

program.command('merge')
  .aliases(['combine'])
  .summary('combine feedback files into one consolidated review')
  .description('Combine feedback files (e.g. from co-founders) into one consolidated review.\n'
    + 'Ids are namespaced by author (kevin:a1, ann:a1) so nothing collides, screenshots\n'
    + 'are copied into a shared shots/, and per-annotation authorship is preserved.\n'
    + 'The merged folder feeds nit view, nit verify, nit mcp and the agent handoff alike.')
  .argument('<files...>', 'nit feedback files (annotations.json, one per author)')
  .option('-o, --out <dir>', 'output directory', 'nit-review-merged')
  .action((files: string[], opts: { out: string }) => {
    runMerge(files, { out: opts.out });
  });

program.command('doctor')
  .aliases(['setup'])
  .summary('check that nit can run; offer to install Chromium if missing')
  .description('Check everything nit needs: Node >= 18, the npm dependencies, and the\n'
    + 'Playwright Chromium browser. If Chromium is missing, nit offers to download\n'
    + 'it — the same one-time download "npx playwright install chromium" performs.\n\n'
    + 'First-time setup (e.g. for co-founders):  npm install && nit doctor --yes')
  .option('-y, --yes', 'install Chromium without asking (non-interactive setup)')
  .action(async (opts: { yes?: boolean }) => {
    const ok = await runDoctor({ yes: Boolean(opts.yes) });
    process.exitCode = ok ? 0 : 1;
  });

program.command('mcp')
  .aliases(['serve'])
  .summary('serve a review folder as an MCP server (stdio)')
  .description('Expose a nit review folder to coding agents as an MCP server over stdio.\n\n'
    + 'Tools: list_annotations (filterable; reports the actionable count),\n'
    + 'get_annotation (full record incl. before/after screenshots as images),\n'
    + 'mark_fixed, set_status (open | fixed | wontfix | verified | reopened).\n\n'
    + 'Register with Claude Code:  claude mcp add nit -- nit mcp ./nit-review')
  .argument('[dir]', 'review directory containing annotations.json', 'nit-review')
  .action((dir: string) => {
    startMcpServer(dir);
    // stays alive while stdin (the MCP client) is connected
  });

async function startBrowser(
  mode: SessionMode,
  { url, file, opts }: { url?: string; file?: string; opts: BrowserCmdOptions },
): Promise<NitSession> {
  const session = await startSession({
    mode,
    url: url ? normalizeUrl(url) : opts.url ? normalizeUrl(opts.url) : undefined,
    reviewFile: file,
    out: opts.out,
    author: opts.author,
    viewportMode: opts.mobile || opts.device === 'mobile' ? 'mobile' : 'desktop',
    headless: Boolean(opts.headless),
    debug: Boolean(opts.debug),
  });
  process.on('SIGINT', () => {
    void session.close().finally(() => process.exit(0));
  });
  return session;
}

function summarize(session: NitSession): void {
  const anns = session.store.annotations;
  const open = anns.filter(a => a.type === 'change-request' && (a.status === 'open' || a.status === 'reopened')).length;
  console.log(`\n${anns.length} annotation${anns.length === 1 ? '' : 's'} (${open} actionable change-request${open === 1 ? '' : 's'}) -> ${session.store.dir}`);
  if (open) console.log('Hand the folder to your coding agent (see fix-annotations.md) or serve it: nit mcp ' + session.store.dir);
}

function normalizeUrl(url: string): string {
  return /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
}

void program.parseAsync().catch((err: unknown) => {
  console.error(`nit: ${errorMessage(err)}`);
  process.exit(1);
});
