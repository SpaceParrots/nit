// SPDX-License-Identifier: AGPL-3.0-or-later
// A scripted stand-in for the @clack prompts, so every interactive fallback in
// the CLI can be driven end to end without a terminal.

/**
 * A `Prompts` that answers with `answers` in order and records what it was
 * asked. A queued `null` is an escape; running out of answers escapes too.
 * @param {...(string|null)} answers
 */
export function scripted(...answers) {
  const queue = [...answers];
  const asked = [];
  const cancels = [];
  const next = () => (queue.length ? queue.shift() : null);
  return {
    /** every question that was asked, in order */
    asked,
    /** the messages printed after an escape */
    cancels,
    /** the last question's rows, as plain labels */
    labels: () => asked[asked.length - 1].choices.map(c => c.label),
    select(question, choices, initial) {
      asked.push({ kind: 'select', question, choices, initial });
      return Promise.resolve(next());
    },
    text(question, opts = {}) {
      asked.push({ kind: 'text', question, opts });
      return Promise.resolve(next());
    },
    cancelled(message) {
      cancels.push(message);
    },
  };
}

/** A `Prompts` that fails the test if anything is asked. */
export function silent() {
  const fail = () => {
    throw new Error('a question was asked when none should have been');
  };
  return { select: fail, text: fail, cancelled: fail };
}
