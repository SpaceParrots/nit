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
import { runList } from './list.js';
import { runClear } from './clear.js';
import {
  resolveFeedbackSourceOrPick, resolveBaseArg, pickClearScope, pickReviewUrl,
  pickImportZip, pickImportTarget,
} from './pick.js';
import { canAsk } from './prompt.js';
import { isActionable } from '../store/stats.js';
import { normalizeUrl } from '../util/route.js';
import { startSession } from '../browser/session.js';
import type { NitSession } from '../browser/session.js';
import { startMcpServer } from '../mcp/server.js';
import { errorMessage } from '../util/error.js';
import { readUserConfig } from '../util/user-config.js';
import { pkgVersion } from '../util/version.js';
import { ANNOTATION_STATUSES } from '../types.js';
import type { AnnotationStatus, AnnotationType, SessionMode } from '../types.js';

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
  /**
   * review: short name for this url's base folder inside the workspace;
   * view/verify: which base of a workspace to open
   */
  base?: string;
  /** review: author recorded on each annotation */
  author?: string;
  /** `--no-input`: commander sets this to false when the flag is passed */
  input?: boolean;
}

const program = new Command();

program
  .name('nit')
  .description('Point-and-click website annotation that hands small UI fixes to a coding agent.\n'
    + 'Annotate any site in a real browser; nit writes a structured review folder\n'
    + '(annotations.json + review.md + screenshots) that an agent fixes directly.')
  // commander binds one short flag per option, so -V (its default) is declared
  // separately from the -v most CLIs use. Both print the same string.
  .version(pkgVersion(), '-v, --version', 'print the nit version')
  .addOption(new Option('-V').hideHelp())
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
  $ nit merge nit-review/staging-example-com/annotations.json imported/annotations.json --out review-merged`);

// -V is declared hidden above so it stays accepted for scripts written against
// commander's default flag; commander only auto-handles the flag it owns.
program.on('option:V', () => {
  console.log(pkgVersion());
  process.exit(0);
});

/** Attach the options shared by every command that launches a browser. */
function withBrowserOptions(cmd: Command): Command {
  return withPromptOption(cmd)
    .option('-m, --mobile', 'start in the mobile viewport (390×844) instead of desktop (1440×900)')
    .addOption(new Option('-d, --device <mode>', 'explicit start viewport').choices(['desktop', 'mobile']))
    .option('--headless', 'run the browser headless (for automation/CI)')
    .option('--debug', 'verbose overlay logging (every page click is logged to stdout)');
}

/**
 * Attach `--no-input` to a command that can ask for a missing argument. The
 * questions only ever appear on a terminal anyway; this is the way to turn them
 * off on one, so a shell function or an agent wrapping nit gets the error and
 * the flag to pass rather than a prompt nobody is watching.
 */
function withPromptOption(cmd: Command): Command {
  return cmd.option('--no-input', 'never ask for a missing argument — fail with the flag to pass instead');
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
      + 'Writes <out>/<base>/annotations.json, review.md, fix-annotations.md and shots/*.png\n'
      + '— <base> is a short name for this url\'s folder inside <out>, derived from its\n'
      + 'host by default (override with --base). A pre-existing single-url review at\n'
      + '<out>/annotations.json is migrated into a base folder automatically the first\n'
      + 'time a second, different url is reviewed into the same <out>.\n\n'
      + 'With no url, nit offers the sites this review already covers, most recently\n'
      + 'reviewed first, plus a free text entry.')
    .argument('[url]', 'page to open (https:// is assumed when no scheme is given)')
    .option('-o, --out <dir>', 'output directory', 'nit-review')
    .option('-a, --author <name>', 'author recorded on each annotation (default: from nit setup, else your OS user name)')
    .option('-b, --base <name>', 'short name for this url\'s folder inside the review workspace (default: derived from the host)'))
  .action(async (urlArg: string | undefined, opts: BrowserCmdOptions, cmd: Command) => {
    const interactive = canAsk({ input: opts.input });
    // No url: offer the ones this workspace already covers before giving up.
    const url = urlArg ?? await pickReviewUrl(opts.out ?? 'nit-review', { interactive });
    if (url === undefined) throw new Error('nit review needs a url — e.g. nit review http://localhost:4200');
    if (url === null) return; // escaped the picker
    // First review in a project: confirm the default output dir is intended here.
    const out = await confirmReviewDir(opts.out ?? 'nit-review', {
      explicit: cmd.getOptionValueSource('out') !== 'default',
      interactive,
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
      + 'file — its annotations.json is used — and so does the bare name of a base in\n'
      + './nit-review, which is the same as passing it to --base.')
    .argument('[source]', 'review directory, a feedback file (annotations.json), or a base name', 'nit-review')
    .option('-u, --url <url>', 'open this url instead of the one stored in the feedback file')
    .option('-b, --base <name>', 'which base URL of the review to open — a slug, a url, or an unambiguous prefix')
    .addHelpText('after', `
Examples:
  $ nit view                             replay ./nit-review
  $ nit view review-merged               a review folder
  $ nit view feedback-ann.json           a specific feedback file
  $ nit view staging                     the staging base of ./nit-review
  $ nit view review-merged --base staging   the staging base of another folder
  $ nit view -u http://localhost:4200    the stored url moved — open this one`))
  .action(async (source: string, opts: BrowserCmdOptions, cmd: Command) => {
    const src = await resolveFeedbackSourceOrPick('view', source, cmd.args.length > 0, {
      base: opts.base, interactive: canAsk({ input: opts.input }),
    });
    if (!src) return;
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
      + 'file — its annotations.json is used — and so does the bare name of a base in\n'
      + './nit-review, which is the same as passing it to --base.')
    .argument('[source]', 'review directory, a feedback file (annotations.json), or a base name', 'nit-review')
    .option('-u, --url <url>', 'open this url instead of the one stored in the feedback file')
    .option('-b, --base <name>', 'which base URL of the review to verify — a slug, a url, or an unambiguous prefix')
    .addHelpText('after', `
Examples:
  $ nit verify                           rule the fixes in ./nit-review
  $ nit verify review-merged             a review folder
  $ nit verify feedback-ann.json         a specific feedback file
  $ nit verify localhost-4200            the localhost-4200 base of ./nit-review
  $ nit verify review-merged --base staging   the staging base of another folder
  $ nit verify -u http://localhost:4200  the stored url moved — open this one`))
  .action(async (source: string, opts: BrowserCmdOptions, cmd: Command) => {
    const src = await resolveFeedbackSourceOrPick('verify', source, cmd.args.length > 0, {
      base: opts.base, interactive: canAsk({ input: opts.input }),
    });
    if (!src) return;
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

withPromptOption(program.command('status')
  .aliases(['stats']))
  .summary('show what is in a review: file, last change, counts')
  .description('A quick read on a review folder, without opening a browser: where the\n'
    + 'annotations file is, when it last changed and by whom, how many annotations\n'
    + 'there are by status and type, which routes they sit on, and what to do next.\n\n'
    + 'A review covering several base URLs reports one line per base plus the totals;\n'
    + '--base narrows to one and reports it like any single review.\n\n'
    + 'Nothing is written — safe to run against a review someone else is editing.\n'
    + 'Use --json to feed the same numbers to a script or CI.')
  .argument('[dir]', 'review directory (or an annotations.json path)', 'nit-review')
  .option('-b, --base <name>', 'only this base — a slug, a url, or an unambiguous prefix')
  .option('--json', 'print the stats as JSON instead of a report')
  .addHelpText('after', `
Examples:
  $ nit status                           what is in nit-review/
  $ nit status --base staging            just the staging base
  $ nit status --json                    the same numbers, for a script`)
  .action(async (dir: string, opts: { base?: string; json?: boolean; input?: boolean }) => {
    const base = await resolveBaseArg(dir, opts.base, { interactive: canAsk(opts) });
    if (base === null) return;
    runStatus(dir, { base, json: Boolean(opts.json) });
  });

withPromptOption(program.command('list')
  .aliases(['ls']))
  .summary('list the base URLs in a review, or the annotated urls in one')
  .description('See what a review workspace holds. With no options it lists every base URL\n'
    + '(local, staging, production …) with its counts; with --base it lists the\n'
    + 'annotated urls inside one of them.\n\n'
    + 'Nothing is written — safe to run against a review someone else is editing.\n'
    + 'Every filter applies to both shapes, and --json feeds the same numbers to a script.')
  .argument('[dir]', 'review workspace (or an annotations.json path)', 'nit-review')
  .option('-b, --base <name>', 'only this base — a slug, a url, or an unambiguous prefix')
  .option('--all', 'show annotated urls for every base')
  .addOption(new Option('--status <status>', 'only annotations with this status')
    .choices(ANNOTATION_STATUSES))
  .addOption(new Option('--type <type>', 'only this annotation type').choices(['change-request', 'comment']))
  .option('--route <path>', 'only annotations on this route (exact route or bare pathname)')
  .option('--author <name>', 'only annotations by this author')
  .option('--actionable', 'only open/reopened change-requests')
  .option('--json', 'print the listing as JSON instead of a report')
  .addHelpText('after', `
Examples:
  $ nit list                                  every base URL with its counts
  $ nit list --base staging                   the annotated urls on staging
  $ nit list --all --actionable               everything still waiting, everywhere
  $ nit list --base staging --status verified what is already ruled on staging`)
  .action(async (dir: string, opts: {
    base?: string; all?: boolean; status?: AnnotationStatus; type?: AnnotationType;
    route?: string; author?: string; actionable?: boolean; json?: boolean; input?: boolean;
  }) => {
    const base = await resolveBaseArg(dir, opts.base, { interactive: canAsk(opts) });
    if (base === null) return;
    runList(dir, {
      base,
      all: opts.all,
      json: opts.json,
      filter: {
        status: opts.status,
        type: opts.type,
        route: opts.route,
        author: opts.author,
        actionable: opts.actionable,
      },
    });
  });

withPromptOption(program.command('clear')
  .aliases(['rm']))
  .summary('remove annotations from a base, or from every base')
  .description('Remove annotations once they have served their purpose — typically the ones\n'
    + 'already ruled Verified after a fix round.\n\n'
    + 'A scope is always required: --base <name> for one environment, --all for every\n'
    + 'one — bare "nit clear" asks for one (and for what should go) rather than\n'
    + 'guessing, and still refuses when there is no terminal to ask on. Without\n'
    + '--status the whole scope is emptied; --verified (or --status) narrows it. The\n'
    + 'base folder and its review metadata always survive, so the next review of that\n'
    + 'url keeps its review id.\n\n'
    + 'Screenshots of removed annotations are deleted too. Use --dry-run to see what\n'
    + 'would go, and --yes to skip the confirmation in scripts.')
  .argument('[dir]', 'review workspace', 'nit-review')
  .option('-b, --base <name>', 'clear this base — a slug, a url, or an unambiguous prefix')
  .option('--all', 'clear every base in the workspace')
  .option('--verified', 'only annotations ruled verified (same as --status verified)')
  .addOption(new Option('--status <status>', 'only annotations with this status')
    .choices(ANNOTATION_STATUSES))
  .option('-y, --yes', 'skip the confirmation prompt')
  .option('--dry-run', 'print what would be cleared and exit without writing')
  .addHelpText('after', `
Examples:
  $ nit clear --base staging --verified   drop what is already ruled on staging
  $ nit clear --all --verified            same, across every environment
  $ nit clear --base staging              empty staging entirely (prompts)
  $ nit clear --all --verified --dry-run  see what would go`)
  .action(async (dir: string, opts: {
    base?: string; all?: boolean; verified?: boolean; status?: AnnotationStatus;
    yes?: boolean; dryRun?: boolean; input?: boolean;
  }) => {
    // Clearing without a scope has always been refused rather than guessed —
    // with a terminal, ask for one instead.
    const scope = await pickClearScope(dir, {
      base: opts.base,
      all: opts.all,
      // --verified is sugar; an explicit --status wins if somebody passes both
      status: opts.status ?? (opts.verified ? 'verified' : undefined),
      yes: opts.yes,
      interactive: canAsk({ input: opts.input }),
    });
    if (!scope) return;
    await runClear(dir, { ...scope, yes: opts.yes, dryRun: opts.dryRun });
  });

withPromptOption(program.command('export')
  .aliases(['pack']))
  .summary('pack a review into a shareable zip')
  .description('Pack a review folder (annotations.json, review.md, fix-annotations.md and\n'
    + 'shots/) into a single zip you can send to a co-founder. The default file name\n'
    + 'carries the review id and author, e.g. 2026-07-21-example.com-ann.nit.zip.\n\n'
    + 'A review covering several base URLs packs all of them, each under its own\n'
    + 'folder; --base packs one of them as a plain single-review zip.\n\n'
    + 'The other side unpacks it with:  nit import <file>')
  .argument('[dir]', 'review directory (or an annotations.json path)', 'nit-review')
  .option('-b, --base <name>', 'pack only this base — a slug, a url, or an unambiguous prefix')
  .option('-o, --out <file>', 'output zip path (default: derived from review id + author)')
  .action(async (dir: string, opts: { base?: string; out?: string; input?: boolean }) => {
    const base = await resolveBaseArg(dir, opts.base, { interactive: canAsk({ input: opts.input }) });
    if (base === null) return;
    runExport(dir, { base, out: opts.out });
  });

withPromptOption(program.command('import')
  .aliases(['unpack'])
  .summary('unpack a review zip from a co-founder')
  .description('Unpack a zip created by "nit export" into a local review folder, ready for\n'
    + 'nit view / verify / merge / mcp. The target directory is derived from the zip\n'
    + 'name (override with --out) and is never overwritten if it already has content.\n\n'
    + 'With no argument, nit offers the zips in the current directory.')
  .argument('[zip]', 'a nit export (.zip)')
  .option('-o, --out <dir>', 'target directory (default: derived from the zip name)'))
  .action(async (zipArg: string | undefined, opts: { out?: string; input?: boolean }) => {
    const interactive = canAsk({ input: opts.input });
    const zip = zipArg ?? await pickImportZip({ interactive });
    if (zip === undefined) {
      throw new Error('nit import needs a zip — e.g. nit import 2026-07-21-example.com-ann.nit.zip');
    }
    if (zip === null) return; // escaped the picker
    // An occupied target is a question ("unpack next to it instead?"), not just
    // a refusal — runImport still refuses when there is nobody to ask.
    const out = await pickImportTarget(zip, opts.out, { interactive });
    if (out === null) return;
    runImport(zip, { out });
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
    base: opts.base,
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

void program.parseAsync().catch((err: unknown) => {
  console.error(`nit: ${errorMessage(err)}`);
  process.exit(1);
});
