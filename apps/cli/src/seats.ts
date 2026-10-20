/**
 * `fleet-v2 seats free-tier` (free-seat plan FS4, F1 and F8): show or
 * change `policy.useFreeSeats` in the v2 installation file. The flag's rules
 * come from the onboarding engine's `draftFreeTier`; this module owns only
 * argument handling and output, and every write goes through the shared
 * compare-and-swap `confirmAndWrite`. There is no `--force`.
 */

import {
  draftFreeTier,
  renderFreeTierImpact,
  renderFreeTierStatus,
  summariseFreeTier,
  type FreeTierAction,
} from '@fleet/onboarding';
import { resolveInstallationFile } from '@fleet/installation';
import {
  confirmAndWrite,
  printDiff,
  printErrors,
  readInstallationState,
} from './hosts.js';
import type { CliIo } from './index.js';

/** Options the driver and tests inject; every default composes the real thing. */
export interface SeatsCliOptions {
  /** Installation file; the loader's own resolution applies when omitted. */
  readonly installationFile?: string;
  /**
   * The confirmation gate for a write. The default reads one line from
   * stdin and accepts only an explicit y/yes; a declined or closed stdin
   * refuses the write.
   */
  readonly confirm?: (question: string) => Promise<boolean>;
}

const SEATS_HELP = `Usage: fleet-v2 seats free-tier [status|on|off] [--yes]

Show or change policy.useFreeSeats in the v2 installation file. Absent means
on. off writes useFreeSeats: false; on removes it. Every change prints which
seats are enabled or disabled and how many seats each role keeps, shows the
file diff, asks y/N (unless --yes) and writes with compare-and-swap. A change
that would leave a role with no seat is refused. Schema version 1 files have
no policy: migrate to v2 first.

  status   print the setting, the free seats and each role's seats in use
  on       use free seats (removes useFreeSeats: false)
  off      do not use free seats (writes useFreeSeats: false)

The API reads the file once at start: a change takes effect for the API after
it restarts; CLI dispatches use it at once.

Exit codes: 0 shown, written or already so, 1 refused, 2 usage error.
There is no --force.`;

type ParsedSeatsArgs =
  | {
      readonly ok: true;
      readonly help: boolean;
      readonly action: FreeTierAction | 'status';
      readonly yes: boolean;
    }
  | { readonly ok: false; readonly error: string };

function isHelpToken(token: string): boolean {
  return token === 'help' || token === '--help' || token === '-h';
}

/** Parse one seats invocation; every problem is a usage message, never a guess. */
function parseSeatsArgs(tokens: readonly string[]): ParsedSeatsArgs {
  if (tokens.some(isHelpToken)) {
    return { ok: true, help: true, action: 'status', yes: false };
  }
  if (tokens[0] !== 'free-tier') {
    return {
      ok: false,
      error: `Unknown seats subcommand: ${tokens[0] ?? '(none)'}\n${SEATS_HELP}`,
    };
  }
  let action: FreeTierAction | 'status' = 'status';
  let actionGiven = false;
  let yes = false;
  for (const token of tokens.slice(1)) {
    if (!token.startsWith('--') || token === '--') {
      if (actionGiven) {
        return {
          ok: false,
          error: `Unexpected argument: ${token}\n${SEATS_HELP}`,
        };
      }
      if (token !== 'status' && token !== 'on' && token !== 'off') {
        return {
          ok: false,
          error: `Unknown free-tier action: ${token}\n${SEATS_HELP}`,
        };
      }
      action = token;
      actionGiven = true;
      continue;
    }
    const body = token.slice(2);
    const separator = body.indexOf('=');
    const flag = separator === -1 ? body : body.slice(0, separator);
    const inlineValue =
      separator === -1 ? undefined : body.slice(separator + 1);
    if (flag !== 'yes') {
      return {
        ok: false,
        error: `Unknown seats free-tier option: --${flag}\n${SEATS_HELP}`,
      };
    }
    if (inlineValue !== undefined) {
      return { ok: false, error: `--yes takes no value\n${SEATS_HELP}` };
    }
    yes = true;
  }
  if (yes && action === 'status') {
    return {
      ok: false,
      error: `--yes applies to on and off only\n${SEATS_HELP}`,
    };
  }
  return { ok: true, help: false, action, yes };
}

/** `seats free-tier status`: print the setting, free seats and role counts. */
async function showFreeTierStatus(file: string, io: CliIo): Promise<number> {
  const state = await readInstallationState(file);
  if (state.status === 'unreadable') {
    io.stderr(`${file}: could not be read (${state.reason})\n`);
    return 1;
  }
  if (state.status === 'invalid') {
    io.stderr('the installation file is invalid; fix it by hand:\n');
    printErrors(io, state.errors);
    return 1;
  }
  if (state.status === 'absent') {
    io.stdout('no installation file; free-tier: on (the default)\n');
    return 0;
  }
  if (state.status === 'v1') {
    io.stdout(
      'free-tier: on (schema version 1 has no policy section; migrate to v2 to change it)\n',
    );
    return 0;
  }
  for (const line of renderFreeTierStatus(summariseFreeTier(state.installation))) {
    io.stdout(`${line}\n`);
  }
  return 0;
}

/** `seats free-tier on|off`: draft, diff, confirm and compare-and-swap write. */
async function changeFreeTier(
  file: string,
  action: FreeTierAction,
  yes: boolean,
  io: CliIo,
  options: SeatsCliOptions,
): Promise<number> {
  const state = await readInstallationState(file);
  if (state.status === 'unreadable') {
    io.stderr(`${file}: could not be read (${state.reason})\n`);
    return 1;
  }
  if (state.status === 'invalid') {
    io.stderr(
      'the installation file is invalid; fix it by hand before changing free-tier:\n',
    );
    printErrors(io, state.errors);
    return 1;
  }
  if (state.status === 'absent') {
    if (action === 'off') {
      io.stderr('no installation file; run fleet-v2 init first\n');
      return 1;
    }
    io.stdout(
      'free-tier is already on (no installation file); nothing was written\n',
    );
    return 0;
  }
  if (state.status === 'v1') {
    if (action === 'off') {
      io.stderr(
        'the installation file is schema version 1, which has no policy section; migrate to v2 before turning free seats off\n',
      );
      return 1;
    }
    io.stdout('free-tier is already on (schema version 1); nothing was written\n');
    return 0;
  }

  const draft = draftFreeTier(state.value, action);
  if (draft.status === 'invalid') {
    io.stderr(
      'the installation file is invalid; fix it by hand before changing free-tier:\n',
    );
    printErrors(io, draft.errors);
    return 1;
  }
  if (draft.status === 'unchanged') {
    io.stdout(`free-tier is already ${action}; nothing was written\n`);
    return 0;
  }

  if (draft.after !== undefined) {
    for (const line of renderFreeTierImpact(draft.before, draft.after)) {
      io.stdout(`${line}\n`);
    }
  }
  if (draft.errors.length > 0) {
    io.stderr('refused: the installation would be invalid with this change:\n');
    printErrors(io, draft.errors);
    printDiff(
      io,
      state.read.status === 'read' ? state.read.text : '',
      draft.candidate,
    );
    io.stderr('nothing was written\n');
    return 1;
  }

  const code = await confirmAndWrite(
    file,
    state.read,
    draft.candidate,
    { yes },
    io,
    { confirm: options.confirm },
  );
  if (code === 0) {
    io.stdout(
      'takes effect for the API after it restarts; CLI dispatches use it at once\n',
    );
  }
  return code;
}

/** `fleet-v2 seats <subcommand>`; exit codes: 0 shown/written, 1 refused, 2 usage. */
export async function seatsCommand(
  argv: readonly string[],
  io: CliIo,
  options: SeatsCliOptions = {},
): Promise<number> {
  const parsed = parseSeatsArgs(argv);
  if (!parsed.ok) {
    io.stderr(`${parsed.error}\n`);
    return 2;
  }
  if (parsed.help) {
    io.stdout(`${SEATS_HELP}\n`);
    return 0;
  }
  const file =
    options.installationFile ??
    resolveInstallationFile(undefined, process.env, process.cwd());
  return parsed.action === 'status'
    ? showFreeTierStatus(file, io)
    : changeFreeTier(file, parsed.action, parsed.yes, io, options);
}
