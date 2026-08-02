// SPDX-License-Identifier: AGPL-3.0-or-later
// When nit may ask, and how it asks. Every interactive fallback in the CLI goes
// through this module: `canAsk` decides whether a question is allowed at all,
// and `Prompts` is the small surface the fallbacks use — a @clack select and a
// @clack text — behind an interface, so the flows are testable without a
// terminal and there is one place to change how nit talks to a human.
import * as p from '@clack/prompts';

/** One row of a {@link Prompts.select}. */
export interface Choice {
  /** what a pick returns */
  value: string;
  /** the row as the user reads it */
  label: string;
}

/** What a text question accepts. */
export interface TextOptions {
  placeholder?: string;
  /** return a message to reject the answer, or undefined to accept it */
  validate?: (value: string) => string | undefined;
}

/**
 * The questions nit knows how to ask. Injectable so every fallback can be
 * driven by a test; {@link clackPrompts} is the real implementation.
 */
export interface Prompts {
  /**
   * Pick one of `choices`.
   * @returns the chosen value, or null when the user escaped
   */
  select(question: string, choices: Choice[], initial?: string): Promise<string | null>;
  /**
   * Type an answer.
   * @returns the answer, or null when the user escaped
   */
  text(question: string, opts?: TextOptions): Promise<string | null>;
  /** Report that nothing happened, after a question was escaped. */
  cancelled(message: string): void;
}

/** Whether a run may be interrupted with a question. */
export interface AskGate {
  /** `--no-input` was passed (commander sets this to false) */
  input?: boolean;
  /** `--json` was passed — the output is for a machine, so never prompt */
  json?: boolean;
  /** override the terminal check (tests) */
  tty?: boolean;
}

/**
 * Whether nit may ask a question in this run.
 *
 * Three things have to hold: a human asked for it (`--no-input` says they did
 * not), the output is for a human (`--json` says it is not), and there is a
 * terminal at *both* ends — stdout alone is not enough, a piped stdin cannot
 * answer. Everything that fails this check must keep working exactly as it did
 * before there were prompts: an error that names the flag to pass instead.
 * @param gate see {@link AskGate}
 */
export function canAsk({ input = true, json = false, tty }: AskGate = {}): boolean {
  if (input === false || json) return false;
  return tty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** The real questions: @clack prompts on the terminal. */
export const clackPrompts: Prompts = {
  async select(question, choices, initial) {
    const picked = await p.select({
      message: question,
      ...(initial === undefined ? {} : { initialValue: initial }),
      options: choices.map(c => ({ value: c.value, label: c.label })),
    });
    return p.isCancel(picked) ? null : picked;
  },

  async text(question, { placeholder, validate } = {}) {
    const answer = await p.text({
      message: question,
      ...(placeholder === undefined ? {} : { placeholder }),
      ...(validate ? { validate: (value = '') => validate(value) } : {}),
    });
    return p.isCancel(answer) ? null : answer;
  },

  cancelled(message) {
    p.cancel(message);
  },
};
