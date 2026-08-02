// SPDX-License-Identifier: AGPL-3.0-or-later
// What nit asks when an argument is missing or fits nothing — which base, which
// url, which zip. Every fallback here follows the same three rules:
//
//   - it only ever *adds* an answer. Without a terminal (see `canAsk`) each one
//     is a no-op that hands the original argument back, so the command fails
//     exactly as it did before prompts existed, naming the flag to pass.
//   - it returns a plain value the caller passes on. The commands themselves
//     (runClear, runStatus, runImport …) neither prompt nor know that a human
//     was asked, which keeps them synchronous and testable.
//   - null means the user escaped: nothing happened, and the caller returns.
import fs from 'node:fs';
import path from 'node:path';
import { resolveFeedbackSource, AmbiguousSourceError } from './source.js';
import type { FeedbackSource } from './source.js';
import { importTarget } from './import.js';
import { clackPrompts } from './prompt.js';
import type { Choice, Prompts } from './prompt.js';
import { openWorkspace, matchBases } from '../store/workspace.js';
import { readAnnotations } from '../store/read.js';
import { isActionable } from '../store/stats.js';
import { isUrlish } from '../util/route.js';
import { displayPath } from './status.js';
import type { AnnotationStatus, BaseRef } from '../types.js';

/** What every fallback needs: whether it may ask, and what to ask with. */
export interface FallbackOptions {
  /** whether a question is allowed at all — see `canAsk` in prompt.ts */
  interactive?: boolean;
  /** how to ask (default: @clack) */
  prompts?: Prompts;
  /** project root relative paths resolve against */
  cwd?: string;
}

/** The pile of work a base picker should count first. */
export type WorkFocus = 'fixed' | 'verified' | 'annotations';

/** The value the "every base" row of a scope picker returns. */
const EVERY_BASE = '*';

/** The value the "type a url" row of the review picker returns — no url looks like this. */
const ANOTHER_URL = '+another';

// ---------------------------------------------------------------------------
// nit view / nit verify — which review, and which base of it
// ---------------------------------------------------------------------------

/** {@link resolveFeedbackSourceOrPick} options. */
export interface PickSourceOptions extends FallbackOptions {
  /** `--base`, when the user passed one */
  base?: string;
}

/**
 * Resolve the `[source]` of `nit view` / `nit verify`, falling back to a base
 * picker when the argument leaves the choice open — several bases and no
 * `--base`, a `--base` that matches nothing or several, or a name that is
 * neither a path nor a base.
 * @param cmd which command asks
 * @param input what the user typed, or the default `nit-review`
 * @param explicit whether the user typed it
 * @param opts see {@link PickSourceOptions}
 * @returns the resolved source, or null when the user cancelled the picker
 * @throws everything {@link resolveFeedbackSource} throws, except the dead ends
 *   a pick resolved
 */
export async function resolveFeedbackSourceOrPick(
  cmd: 'view' | 'verify',
  input: string,
  explicit: boolean,
  { base, cwd, interactive = false, prompts = clackPrompts }: PickSourceOptions = {},
): Promise<FeedbackSource | null> {
  try {
    return resolveFeedbackSource(cmd, input, explicit, base, cwd);
  } catch (e) {
    if (!interactive || !(e instanceof AmbiguousSourceError) || !e.bases.length) throw e;
    const focus = cmd === 'verify' ? 'fixed' : 'annotations';
    const slug = await askForBase(prompts, e.question, e.bases, focus);
    if (slug === null) {
      prompts.cancelled(`nothing opened — pick one with:  nit ${cmd} --base <name>`);
      return null;
    }
    // Re-resolve rather than opening the picked base's file directly: the
    // chosen base still has to pass every check the argument would have.
    return resolveFeedbackSource(cmd, e.dir, true, slug, cwd);
  }
}

// ---------------------------------------------------------------------------
// --base, everywhere else (nit status / list / export / clear)
// ---------------------------------------------------------------------------

/** {@link resolveBaseArg} options. */
export interface PickBaseOptions extends FallbackOptions {
  /** which pile of work the rows should lead with */
  focus?: WorkFocus;
}

/**
 * Turn a `--base` argument into one that resolves, asking when it does not.
 *
 * The commands themselves already reject a base that names nothing, with a
 * message listing the real ones — this only gets ahead of that when there is a
 * human to ask. A base that resolves, an absent one, and every non-interactive
 * run are handed straight back, so the command keeps full ownership of the
 * error.
 * @param dir the workspace the base should be in
 * @param base what the user passed to `--base`, if anything
 * @param opts see {@link PickBaseOptions}
 * @returns the base to work on, undefined when none was asked for, or null when
 *   the user escaped the picker
 */
export async function resolveBaseArg(
  dir: string,
  base: string | undefined,
  { focus = 'annotations', cwd, interactive = false, prompts = clackPrompts }: PickBaseOptions = {},
): Promise<string | undefined | null> {
  if (!base || !interactive) return base;
  const ws = openWorkspace(path.resolve(cwd ?? process.cwd(), dir));
  const matches = matchBases(ws, base);
  if (matches.length === 1) return matches[0].slug;
  // Nothing to offer: let the command report the empty workspace itself.
  if (!ws.bases.length) return base;
  const question = matches.length
    ? `"${base}" matches ${matches.length} bases — which one?`
    : `no base "${base}" in ${displayPath(ws.dir)} — which one?`;
  const slug = await askForBase(prompts, question, matches.length ? matches : ws.bases, focus);
  if (slug === null) prompts.cancelled('cancelled — nothing was done');
  return slug;
}

// ---------------------------------------------------------------------------
// nit clear — which base, and what should go
// ---------------------------------------------------------------------------

/** The scope `nit clear` works on: one base or all of them, and what goes. */
export interface ClearScope {
  base?: string;
  all?: boolean;
  status?: AnnotationStatus;
}

/** {@link pickClearScope} options. */
export interface PickClearScopeOptions extends FallbackOptions, ClearScope {
  /** `--yes`: this run wants no questions, so an absent scope stays an error */
  yes?: boolean;
}

/**
 * The scope of a `nit clear`, asked for when the flags did not give one.
 *
 * Clearing is destructive and a guess would be unforgivable, so bare
 * `nit clear` has always refused. With a terminal it can offer the choice
 * instead: which base (or every one), then — when no `--status` narrowed it
 * already — whether to drop everything or only what is ruled. Both rows carry
 * their counts, so the size of the deletion is on screen before it is chosen,
 * and the existing confirmation still has the last word.
 * @param dir the workspace to clear in
 * @param opts the flags as given, plus see {@link PickClearScopeOptions}
 * @returns the scope to clear (unchanged when the flags already decided), or
 *   null when the user escaped
 */
export async function pickClearScope(
  dir: string,
  { base, all, status, yes = false, cwd, interactive = false, prompts = clackPrompts }: PickClearScopeOptions = {},
): Promise<ClearScope | null> {
  const given = { base, all, status };
  // A named base still has to exist — the same picker every other command gets.
  if (base) {
    const resolved = await resolveBaseArg(dir, base, { focus: 'verified', cwd, interactive, prompts });
    return resolved === null ? null : { ...given, base: resolved };
  }
  // Both scopes (an error runClear owns), or a run that asked for no questions:
  // nothing to add.
  if (all || yes || !interactive) return given;
  const ws = openWorkspace(path.resolve(cwd ?? process.cwd(), dir));
  if (!ws.bases.length) return given;

  const rows = ws.bases.map(b => ({ base: b, work: countWork(b) }));
  const choices: Choice[] = baseRows(rows, 'verified');
  if (rows.length > 1) {
    const total = rows.reduce((n, r) => n + r.work.total, 0);
    choices.push({ value: EVERY_BASE, label: `every base  (${count(total, 'annotation')})` });
  }
  const scope = await prompts.select(`Clear which base of ${displayPath(ws.dir)}?`, choices, rows[0].base.slug);
  if (scope === null) return cancel(prompts);

  const targets = scope === EVERY_BASE ? rows : rows.filter(r => r.base.slug === scope);
  // An escape here must stop the command, not fall through to the widest
  // possible deletion — the whole point of the question is that "everything" is
  // a decision, never a default.
  const narrowed = status ?? await pickClearStatus(prompts, targets);
  if (narrowed === null) return cancel(prompts);
  return { ...(scope === EVERY_BASE ? { all: true } : { base: scope }), status: narrowed };
}

/**
 * What should go: everything in the scope, or only what is already ruled. Both
 * rows count what they would remove, so an empty choice is visible up front.
 * @returns `'verified'` to narrow, undefined for the whole scope, or null when
 *   the user escaped
 */
async function pickClearStatus(
  prompts: Prompts,
  targets: { work: Work }[],
): Promise<AnnotationStatus | undefined | null> {
  const total = targets.reduce((n, t) => n + t.work.total, 0);
  const verified = targets.reduce((n, t) => n + t.work.verified, 0);
  const picked = await prompts.select('What should go?', [
    { value: 'verified', label: `only what is already ruled  (${count(verified, 'verified annotation')})` },
    { value: '', label: `everything  (${count(total, 'annotation')})` },
  ], 'verified');
  if (picked === null) return null;
  return picked === 'verified' ? 'verified' : undefined;
}

// ---------------------------------------------------------------------------
// nit review — which url
// ---------------------------------------------------------------------------

/**
 * The url `nit review` should open, asked for when the argument was left out.
 *
 * The urls already in the workspace come first, most recently reviewed at the
 * top — a second round on staging is the common case, and retyping the url is
 * how you end up with two base folders for one site. The last row is always a
 * free text entry.
 * @param out the workspace `--out` points at, whose bases are offered
 * @param opts see {@link FallbackOptions}
 * @returns the url; undefined when there is nobody to ask, so the caller can
 *   report the missing argument; null when the user escaped
 */
export async function pickReviewUrl(
  out: string,
  { cwd, interactive = false, prompts = clackPrompts }: FallbackOptions = {},
): Promise<string | undefined | null> {
  if (!interactive) return undefined;
  const ws = openWorkspace(path.resolve(cwd ?? process.cwd(), out));
  const known = [...ws.bases]
    .filter(b => b.url)
    .sort((a, b) => (b.lastSeenAt ?? b.createdAt ?? '').localeCompare(a.lastSeenAt ?? a.createdAt ?? ''));

  if (known.length) {
    const width = Math.max(...known.map(b => b.url.length));
    const choices: Choice[] = known.map(b => ({
      value: b.url,
      label: `${b.url.padEnd(width)}  ${describeWork('annotations', countWork(b))}`,
    }));
    choices.push({ value: ANOTHER_URL, label: 'another url…' });
    const picked = await prompts.select('Which site do you want to review?', choices, known[0].url);
    if (picked === null) return cancel(prompts);
    if (picked !== ANOTHER_URL) return picked;
  }

  const typed = await prompts.text('Which url should nit open?', {
    placeholder: 'http://localhost:3000',
    validate: value => (isUrlish(value) ? undefined : 'that is not a url — e.g. http://localhost:3000'),
  });
  return !typed?.trim() ? cancel(prompts) : typed.trim();
}

// ---------------------------------------------------------------------------
// nit import — which zip, and where to unpack it
// ---------------------------------------------------------------------------

/** How many zips a picker offers before the list is noise rather than help. */
const MAX_ZIPS = 12;

/**
 * The zip `nit import` should unpack, asked for when the argument was left out.
 * Only the zips in the working directory are offered — a nit export lands next
 * to you, in a chat download or a shared folder you `cd` into — newest first,
 * with nit's own `.nit.zip` exports ahead of anything else.
 * @param opts see {@link FallbackOptions}
 * @returns the zip path; undefined when there is nobody to ask or no zip to
 *   offer, so the caller can report the missing argument; null when the user
 *   escaped
 */
export async function pickImportZip(
  { cwd, interactive = false, prompts = clackPrompts }: FallbackOptions = {},
): Promise<string | undefined | null> {
  if (!interactive) return undefined;
  const dir = path.resolve(cwd ?? process.cwd());
  const zips = listZips(dir);
  if (!zips.length) return undefined;
  const picked = await prompts.select('Which export should nit unpack?', zips.map(z => ({
    value: path.join(dir, z),
    label: z,
  })), path.join(dir, zips[0]));
  return picked ?? cancel(prompts);
}

/**
 * Where `nit import` should unpack to, when the derived target is already in
 * use. Overwriting is never offered — the folder may be someone's review — so
 * the choice is a free name next to it, or nothing.
 * @param zip the zip being imported
 * @param out `--out`, when the user passed one
 * @param opts see {@link FallbackOptions}
 * @returns the target to use (unchanged when it is free), or null when the user
 *   declined or escaped
 */
export async function pickImportTarget(
  zip: string,
  out: string | undefined,
  { cwd, interactive = false, prompts = clackPrompts }: FallbackOptions = {},
): Promise<string | undefined | null> {
  const target = importTarget(zip, out, cwd);
  if (!interactive || !isBusy(target)) return out;
  const free = freeName(target);
  const ok = await prompts.select(
    `${displayPath(target)} is not empty — unpack into ${displayPath(free)} instead?`,
    [{ value: 'yes', label: `yes, import into ${path.basename(free)}` }, { value: 'no', label: 'no, stop here' }],
    'yes',
  );
  if (ok !== 'yes') {
    prompts.cancelled('nothing imported — pick a target with:  nit import <zip> --out <dir>');
    return null;
  }
  return free;
}

/** Whether a path exists and already holds something. */
function isBusy(target: string): boolean {
  return fs.existsSync(target) && fs.readdirSync(target).length > 0;
}

/** `review`, `review-2`, `review-3`, … — the first name nothing is using. */
function freeName(target: string): string {
  for (let n = 2; n < 100; n++) {
    const candidate = `${target}-${n}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  return `${target}-${Date.now()}`;
}

/** The zips in `dir`, nit's own exports first, newest first within each group. */
function listZips(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter(n => n.toLowerCase().endsWith('.zip'));
  } catch {
    return [];
  }
  return names
    .map(name => ({ name, nit: name.toLowerCase().endsWith('.nit.zip'), at: mtime(path.join(dir, name)) }))
    .sort((a, b) => Number(b.nit) - Number(a.nit) || b.at - a.at || a.name.localeCompare(b.name))
    .slice(0, MAX_ZIPS)
    .map(z => z.name);
}

/** A file's mtime in ms, or 0 when it cannot be read. */
function mtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// shared: describing bases
// ---------------------------------------------------------------------------

/** One base as a picker row, plus where the cursor should start. */
export interface BaseChoices {
  choices: Choice[];
  /** the slug to preselect — the first base that has work for this command */
  initial: string;
}

/**
 * The rows for a set of bases. Each shows the base's url and how much work is
 * waiting in it, so a base with nothing to do is visible *before* it is picked.
 *
 * It all goes in the label because @clack's select only renders an option's
 * `hint` while that option is highlighted, and the point is to compare the
 * bases without arrowing through them.
 * @param focus which pile the row should lead with — each command cares about a
 *   different one
 * @param bases the bases to offer, in the order they should be shown
 */
export function baseChoices(focus: WorkFocus, bases: BaseRef[]): BaseChoices {
  const rows = bases.map(base => ({ base, work: countWork(base) }));
  if (!rows.length) return { choices: [], initial: '' };
  const withWork = rows.find(r => r.work[focus === 'annotations' ? 'total' : focus] > 0);
  return { choices: baseRows(rows, focus), initial: (withWork ?? rows[0]).base.slug };
}

/** Ask which base, with the rows {@link baseChoices} builds. */
async function askForBase(
  prompts: Prompts,
  question: string,
  bases: BaseRef[],
  focus: WorkFocus,
): Promise<string | null> {
  const { choices, initial } = baseChoices(focus, bases);
  return prompts.select(question, choices, initial);
}

/** The rows themselves: slug, url and pending work in aligned columns. */
function baseRows(rows: { base: BaseRef; work: Work }[], focus: WorkFocus): Choice[] {
  const urls = rows.map(r => shortUrl(r.base.url));
  const slugWidth = Math.max(...rows.map(r => r.base.slug.length));
  const urlWidth = Math.max(...urls.map(u => u.length));
  return rows.map(({ base, work }, i) => ({
    value: base.slug,
    label: `${base.slug.padEnd(slugWidth)}  ${urls[i].padEnd(urlWidth)}  ${describeWork(focus, work)}`.trimEnd(),
  }));
}

/** How much of each kind of work one base holds. */
interface Work {
  total: number;
  fixed: number;
  verified: number;
  actionable: number;
}

/** Count a base's annotations; an unreadable file counts as an empty review. */
function countWork(base: BaseRef): Work {
  const annotations = readAnnotations(base.file);
  return {
    total: annotations.length,
    fixed: annotations.filter(a => a.status === 'fixed').length,
    verified: annotations.filter(a => a.status === 'verified').length,
    actionable: annotations.filter(isActionable).length,
  };
}

/**
 * The work summary next to a base: what the command being run would touch
 * there, then what is left over for the other side of the loop.
 */
function describeWork(focus: WorkFocus, work: Work): string {
  if (!work.total) return 'empty';
  const lead = focus === 'annotations'
    ? count(work.total, 'annotation')
    : `${work[focus]} ${focus}`;
  const rest = focus === 'verified'
    ? `${work.total} total`
    : work.actionable ? `${work.actionable} actionable` : '';
  return [lead, rest].filter(Boolean).join(' · ');
}

/** How wide a url may get before the row is worth more than the whole url. */
const URL_WIDTH = 44;

/** A url that fits a terminal row; a long one keeps its head, which identifies it. */
function shortUrl(url: string): string {
  return url.length > URL_WIDTH ? `${url.slice(0, URL_WIDTH - 1)}…` : url;
}

/** `1 annotation` / `4 annotations`. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** Note that the escape did nothing, and report it as a cancel. */
function cancel(prompts: Prompts): null {
  prompts.cancelled('cancelled — nothing was done');
  return null;
}
