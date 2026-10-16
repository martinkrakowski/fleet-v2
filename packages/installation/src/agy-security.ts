/**
 * The versioned security text an agy lane runner presents before `full` mode
 * may be chosen (D7, plan "Security step in `init` and `/settings`"). The
 * loader compares a host's `agyAcknowledgement.textVersion` against
 * `AGY_SECURITY_TEXT_VERSION`; a newer shipped text makes stored
 * acknowledgements stale and `full` is refused until `init` or `/settings`
 * re-confirms.
 */

/** Version of the security text shipped with this build. */
export const AGY_SECURITY_TEXT_VERSION = '2026-10-16.1';

/** The security text itself, shown before the agy mode question. */
export const AGY_SECURITY_TEXT = [
  'agy runner security text:',
  '',
  '1. Recommendation: use `full` only inside a container or VM with a scoped',
  '   worktree mount and restricted network egress. Otherwise use `edit-only`.',
  '2. What `full` can do: run any command as the runner\'s user, read anything',
  '   that user can read, reach the network where egress allows, and use',
  '   credentials in its environment or home directory.',
  '3. What fleet still enforces: the runner environment allow-list (D5), the',
  '   declared isolation floor and dispatch refusal (D4/O8), independent review',
  '   by a different model family, verification, and acceptance rules (CI',
  '   evidence when forge mode is `github`; receipt-only when it is `none`, D6).',
  '4. What fleet cannot enforce: anything inside the runner user\'s reach;',
  '   declarations are statements.',
  '5. Confirmation: the developer types `full` to choose it. A checkbox is',
  '   never enough. A hand-written acknowledgement record cannot be told apart',
  '   from a real one.',
].join('\n');
