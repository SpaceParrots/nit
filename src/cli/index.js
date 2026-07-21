#!/usr/bin/env node
// nit — point-and-click website annotation for coding agents.
//   nit review <url>     annotate a site, write nit-review/
//   nit view <file>      replay a feedback file on the live site
//   nit merge <file...>  combine feedback files into one review
import { parseArgs } from './args.js';
import { runMerge } from './merge.js';
import { startSession } from '../browser/session.js';

const HELP = `nit — point-and-click website annotation for coding agents

Usage:
  nit review <url>  [--out dir] [--author name] [--mobile] [--headless] [--debug]
  nit view <file>   [--url override] [--mobile] [--headless] [--debug]
  nit verify <file> [--url override] [--mobile] [--headless] [--debug]
  nit merge <file...> [--out dir]
  nit mcp [dir]

Review: press Alt to pick an element, click it, describe the change, Save.
Verify: captures "after" screenshots for fixed annotations; rule Verified/Reopen in the panel.
Mcp:    stdio MCP server over <dir>/annotations.json (list_annotations, get_annotation, mark_fixed, set_status).
Output: <out>/annotations.json + review.md + shots/ (default out: nit-review).
`;

main().catch(err => {
  console.error(`nit: ${err.message}`);
  process.exit(1);
});

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const [command, ...rest] = positional;

  if (flags.help || !command) {
    console.log(HELP);
    return;
  }

  const viewportMode = flags.mobile || flags.device === 'mobile' ? 'mobile' : 'desktop';
  const common = {
    viewportMode,
    headless: Boolean(flags.headless),
    debug: Boolean(flags.debug),
  };

  if (command === 'review') {
    const url = rest[0];
    if (!url) throw new Error('usage: nit review <url>');
    const session = await startSession({
      ...common,
      mode: 'review',
      url: normalizeUrl(url),
      out: typeof flags.out === 'string' ? flags.out : 'nit-review',
      author: typeof flags.author === 'string' ? flags.author : undefined,
    });
    hookSigint(session);
    console.log(`nit review — ${url}`);
    console.log('Alt: toggle picking · Esc: cancel · close the browser (or Finish review) when done.');
    await session.done;
    summarize(session);
  } else if (command === 'view' || command === 'verify') {
    const file = rest[0];
    if (!file) throw new Error(`usage: nit ${command} <file>`);
    const session = await startSession({
      ...common,
      mode: command,
      reviewFile: file,
      url: typeof flags.url === 'string' ? normalizeUrl(flags.url) : undefined,
    });
    hookSigint(session);
    if (command === 'verify') {
      console.log(`nit verify — ${file}`);
      console.log('Visit the routes of fixed annotations; after-shots are captured automatically.');
      console.log('Rule each fixed item Verified or Reopen in the panel, then close the browser.');
    } else {
      console.log(`nit view — replaying ${file}`);
      console.log('Navigate the site; pins appear on the routes they were made on. Close the browser when done.');
    }
    await session.done;
  } else if (command === 'mcp') {
    const { startMcpServer } = await import('../mcp/server.js');
    const dir = rest[0] || 'nit-review';
    startMcpServer(dir);
    // stays alive while stdin (the MCP client) is connected
  } else if (command === 'merge') {
    if (!rest.length) throw new Error('usage: nit merge <file...>');
    runMerge(rest, { out: typeof flags.out === 'string' ? flags.out : 'nit-review-merged' });
  } else {
    throw new Error(`unknown command: ${command}\n\n${HELP}`);
  }
}

function summarize(session) {
  const anns = session.store.annotations;
  const open = anns.filter(a => a.type === 'change-request' && a.status === 'open').length;
  console.log(`\n${anns.length} annotation${anns.length === 1 ? '' : 's'} (${open} open change-request${open === 1 ? '' : 's'}) -> ${session.store.dir}`);
  if (open) console.log('Hand nit-review/ to your coding agent (see fix-annotations.md).');
}

function normalizeUrl(url) {
  return /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
}

function hookSigint(session) {
  process.on('SIGINT', () => {
    session.close().finally(() => process.exit(0));
  });
}
