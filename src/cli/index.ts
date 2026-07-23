#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// nit — point-and-click website annotation for coding agents.
import { Command, Option } from 'commander';
import { runMerge } from './merge.js';
import { runDoctor } from './doctor.js';
import { runMcpInstall } from './mcp-install.js';
import { runSetup, confirmReviewDir } from './setup.js';
import { runExport } from './export.js';
import { runImport } from './import.js';
import { runStatus, displayPath } from './status.js';
import { resolveFeedbackSource } from './source.js';
import { isActionable } from '../store/stats.js';
import { startSession } from '../browser/session.js';
import type { NitSession } from '../browser/session.js';
import { startMcpServer } from '../mcp/server.js';
import { errorMessage } from '../util/error.js';
import { readUserConfig } from '../util/user-config.js';
import { pkgVersion } from '../util/version.js';
import type { SessionMode } from '../types.js';

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
  .version(pkgVersion())
  .showHelpAfterError('(run "nit <command> --help" for details)')
  .showSuggestionAfterError()
  .addHelpText('after', `
The loop:
  0. nit setup                                   one-time project setup (dir, .gitignore, MCP)
  1. nit review https://staging.example.com      annotate the site -> nit-review/
  2. hand nit-review/ to a coding agent          (or serve it: nit mcp nit-review)
  3. nit verify                                  rule each fix (finds nit-review/ by itself)

Examples:
  $ nit review http://localhost:4200 --mobile --author Ann
  $ nit status                                   what is in nit-review/ right now
  $ nit view feedback-ann.json --url https://staging.example.com
  $ nit export                                   pack nit-review/ into a shareable zip
  $ nit import 2026-07-21-example.com-ann.nit.zip
  $ nit merge nit-review/annotations.json imported/annotations.json --out review-merged`);

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
      + 'switches desktop/mobile, sorts and groups them by page, time or state, jumps to\n'
      + 'the page an annotation was found on, records an issue reference, edits comment\n'
      + 'texts, deletes items, and finishes the review.\n\n'
      + 'Writes <out>/annotations.json, review.md, fix-annotations.md and shots/*.png.')
    .argument('<url>', 'page to open (https:// is assumed when no scheme is given)')
    .option('-o, --out <dir>', 'output directory', 'nit-review')
    .option('-a, --author <name>', 'author recorded on each annotation (default: from nit setup, else your OS user name)'))
  .action(async (url: string, opts: BrowserCmdOptions, cmd: Command) => {
    // First review in a project: confirm the default output dir is intended here.
    const out = await confirmReviewDir(opts.out ?? 'nit-review', {
      explicit: cmd.getOptionValueSource('out') !== 'default',
    });
    const session = await startBrowser('review', { url, opts: { ...opts, out } });
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
      + 'Annotations that cannot be re-anchored land in the panel’s "couldn’t place" list.\n\n'
      + 'With no argument, nit looks for ./nit-review. A directory works as well as a\n'
      + 'file — its annotations.json is used.')
    .argument('[source]', 'review directory, or a feedback file (annotations.json)', 'nit-review')
    .option('-u, --url <url>', 'open this url instead of the one stored in the feedback file')
    .addHelpText('after', `
Examples:
  $ nit view                             replay ./nit-review
  $ nit view review-merged               a review folder
  $ nit view feedback-ann.json           a specific feedback file
  $ nit view -u http://localhost:4200    the stored url moved — open this one`))
  .action(async (source: string, opts: BrowserCmdOptions, cmd: Command) => {
    const src = resolveFeedbackSource('view', source, cmd.args.length > 0);
    const session = await startBrowser('view', { file: src.file, opts });
    const total = session.store.annotations.length;
    console.log(`nit view — ${displayPath(src.file)}`);
    console.log(`${total} annotation${total === 1 ? '' : 's'}; pins appear on the routes they were made on. Close the browser when done.`);
    await session.done;
  });

withBrowserOptions(
  program.command('verify')
    .aliases(['check'])
    .summary('capture after-shots for fixed items and rule Verified / Reopen')
    .description('Close the loop after an agent marked change requests "fixed": nit re-opens the\n'
      + 'site and the panel walks you through each fixed annotation in a guided queue.\n'
      + 'Routes are visited automatically, and an "after" screenshot is captured next to\n'
      + 'the original (if the element is gone, the originally recorded region is captured\n'
      + 'instead). Rule each item Verified, Reopen (with an optional note), or Skip —\n'
      + 'reopened items become actionable again for the next fix round.\n\n'
      + 'With no argument, nit looks for ./nit-review. A directory works as well as a\n'
      + 'file — its annotations.json is used.')
    .argument('[source]', 'review directory, or a feedback file (annotations.json)', 'nit-review')
    .option('-u, --url <url>', 'open this url instead of the one stored in the feedback file')
    .addHelpText('after', `
Examples:
  $ nit verify                           rule the fixes in ./nit-review
  $ nit verify review-merged             a review folder
  $ nit verify feedback-ann.json         a specific feedback file
  $ nit verify -u http://localhost:4200  the stored url moved — open this one`))
  .action(async (source: string, opts: BrowserCmdOptions, cmd: Command) => {
    const src = resolveFeedbackSource('verify', source, cmd.args.length > 0);
    const session = await startBrowser('verify', { file: src.file, opts });
    const fixed = session.store.annotations.filter(a => a.status === 'fixed').length;
    console.log(`nit verify — ${displayPath(src.file)}`);
    console.log(`${fixed} fixed item${fixed === 1 ? '' : 's'} queued — the panel walks you through each: Verified, Reopen (with an optional note), or Skip.`);
    console.log('Routes are visited automatically; after-shots appear next to the original.');
    await session.done;
    summarizeVerify(session);
  });

program.command('setup')
  .aliases(['init'])
  .summary('one-time project setup: review dir, .gitignore, MCP server')
  .description('Get a project ready for reviews with a short interactive wizard:\n'
    + '  - pick the review directory (default nit-review/, created if missing)\n'
    + '  - add it to .gitignore (reviews are working files, usually not committed)\n'
    + '  - register the nit MCP server in .mcp.json so coding agents can read reviews\n\n'
    + 'Re-running is safe — every step is idempotent. Use --yes for scripts/CI.')
  .option('-y, --yes', 'accept all defaults without prompting')
  .action(async (opts: { yes?: boolean }) => {
    await runSetup({ yes: Boolean(opts.yes) });
  });

program.command('status')
  .aliases(['stats'])
  .summary('show what is in a review: file, last change, counts')
  .description('A quick read on a review folder, without opening a browser: where the\n'
    + 'annotations file is, when it last changed and by whom, how many annotations\n'
    + 'there are by status and type, which routes they sit on, and what to do next.\n\n'
    + 'Nothing is written — safe to run against a review someone else is editing.\n'
    + 'Use --json to feed the same numbers to a script or CI.')
  .argument('[dir]', 'review directory (or an annotations.json path)', 'nit-review')
  .option('--json', 'print the stats as JSON instead of a report')
  .action((dir: string, opts: { json?: boolean }) => {
    runStatus(dir, { json: Boolean(opts.json) });
  });

program.command('export')
  .aliases(['pack'])
  .summary('pack a review into a shareable zip')
  .description('Pack a review folder (annotations.json, review.md, fix-annotations.md and\n'
    + 'shots/) into a single zip you can send to a co-founder. The default file name\n'
    + 'carries the review id and author, e.g. 2026-07-21-example.com-ann.nit.zip.\n\n'
    + 'The other side unpacks it with:  nit import <file>')
  .argument('[dir]', 'review directory (or an annotations.json path)', 'nit-review')
  .option('-o, --out <file>', 'output zip path (default: derived from review id + author)')
  .action((dir: string, opts: { out?: string }) => {
    runExport(dir, { out: opts.out });
  });

program.command('import')
  .aliases(['unpack'])
  .summary('unpack a review zip from a co-founder')
  .description('Unpack a zip created by "nit export" into a local review folder, ready for\n'
    + 'nit view / verify / merge / mcp. The target directory is derived from the zip\n'
    + 'name (override with --out) and is never overwritten if it already has content.')
  .argument('<zip>', 'a nit export (.zip)')
  .option('-o, --out <dir>', 'target directory (default: derived from the zip name)')
  .action((zip: string, opts: { out?: string }) => {
    runImport(zip, { out: opts.out });
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
    + 'Tools: nit_list_annotations (filterable; reports the actionable count),\n'
    + 'nit_get_annotation (full record incl. before/after screenshots as images),\n'
    + 'nit_mark_fixed, nit_set_status (open | fixed | wontfix | verified | reopened),\n'
    + 'nit_set_issue_ref (attach a tracker key or url; empty clears it).\n\n'
    + 'Resources: nit://review/annotations.json, nit://review/review.md,\n'
    + 'nit://review/fix-annotations.md and nit://annotation/<id> (plus its screenshots).\n\n'
    + 'Register with Claude Code:  claude mcp add nit -- nit mcp ./nit-review')
  .argument('[dir]', 'review directory containing annotations.json', 'nit-review')
  .action(async (dir: string) => {
    const server = await startMcpServer(dir);
    // stays alive while stdin (the MCP client) is connected
    server.onClose(() => process.exit(0));
  });

program.command('mcp-install')
  .aliases(['mcp-config'])
  .summary('register the nit MCP server in this project (.mcp.json)')
  .description('Write the nit MCP server into this project\'s .mcp.json — the project-scoped\n'
    + 'MCP config that Claude Code and other MCP clients pick up automatically.\n\n'
    + 'The file is created when missing and merged when present: other servers and\n'
    + 'unknown keys are preserved, and re-running simply updates the nit entry.\n'
    + 'On Windows the command is wrapped in "cmd /c", because MCP clients spawn\n'
    + 'servers without a shell and the installed nit command is a .cmd shim there.\n\n'
    + 'Alternative (user-scoped, via the Claude CLI):  claude mcp add nit -- nit mcp ./nit-review')
  .argument('[dir]', 'review directory the server should expose', 'nit-review')
  .option('-n, --name <name>', 'server name inside .mcp.json', 'nit')
  .action((dir: string, opts: { name: string }) => {
    runMcpInstall(dir, { name: opts.name });
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
    author: opts.author ?? readUserConfig().author,
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
  const open = anns.filter(isActionable).length;
  console.log(`\n${anns.length} annotation${anns.length === 1 ? '' : 's'} (${open} actionable change-request${open === 1 ? '' : 's'}) -> ${session.store.dir}`);
  if (open) console.log('Hand the folder to your coding agent (see fix-annotations.md) or serve it: nit mcp ' + session.store.dir);
}

/** One-line outcome of a verify session: what was ruled, and what still waits. */
function summarizeVerify(session: NitSession): void {
  const anns = session.store.annotations;
  const count = (status: string): number => anns.filter(a => a.status === status).length;
  console.log(`\nverify done: ${count('verified')} verified · ${count('reopened')} reopened · ${count('fixed')} still fixed -> ${session.store.dir}`);
}

function normalizeUrl(url: string): string {
  return /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
}

void program.parseAsync().catch((err: unknown) => {
  console.error(`nit: ${errorMessage(err)}`);
  process.exit(1);
});
