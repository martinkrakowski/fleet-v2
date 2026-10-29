/**
 * `fleet-v2 policy auto-merge` (auto-merge plan A2/A6): show or change
 * `policy.autoMerge` in the v2 installation file. The block's rules come from
 * the onboarding engine's `draftAutoMerge`; this module owns only argument
 * handling and output, and every write goes through the shared compare-and-swap
 * `confirmAndWrite`. There is no `--force`.
 */

import {
  draftAutoMerge,
  renderAutoMergeImpact,
  renderAutoMergeStatus,
  summariseAutoMerge,
  type AutoMergeChange,
} from "@fleet/onboarding";
import { resolveInstallationFile } from "@fleet/installation";
import {
  confirmAndWrite,
  printDiff,
  printErrors,
  readInstallationState,
} from "./hosts.js";
import type { CliIo } from "./index.js";

/** Options the driver and tests inject; every default composes the real thing. */
export interface PolicyCliOptions {
  /** Installation file; the loader's own resolution applies when omitted. */
  readonly installationFile?: string;
  /**
   * The confirmation gate for a write. The default reads one line from
   * stdin and accepts only an explicit y/yes; a declined or closed stdin
   * refuses the write.
   */
  readonly confirm?: (question: string) => Promise<boolean>;
}

const POLICY_HELP = `Usage: fleet-v2 policy auto-merge [status|on|off] [--allow-high-risk true|false] [--on-blocked ask-owner|hold] [--yes]

Show or change policy.autoMerge in the v2 installation file. Absent means
off. on writes the full autoMerge block; off writes enabled: false and keeps
the other two keys at their current values. Every change prints the impact
lines, shows the file diff, asks y/N (unless --yes) and writes with
compare-and-swap. Schema version 1 files have no policy: migrate to v2 first.

  status                print the resolved auto-merge policy and its revision
  on                   enable auto-merge under the policy
  off                  disable auto-merge (the default when absent)

  --allow-high-risk <true|false>   high-risk lanes merge under the same policy
  --on-blocked <ask-owner|hold>    how a blocked auto-merge routes
  --yes                            confirm the write without prompting

The API reads the file once at start: a change takes effect for the API after
it restarts; CLI attempts use it at once. Exit codes: 0 shown, written or
already so, 1 refused, 2 usage error. There is no --force.`;

type ParsedPolicyArgs =
  | {
      readonly ok: true;
      readonly help: boolean;
      readonly action: "status" | "on" | "off";
      readonly yes: boolean;
      readonly allowHighRisk?: boolean;
      readonly onBlocked?: "ask-owner" | "hold";
    }
  | { readonly ok: false; readonly error: string };

function isHelpToken(token: string): boolean {
  return token === "help" || token === "--help" || token === "-h";
}

/** Parse one policy invocation; every problem is a usage message, never a guess. */
function parsePolicyArgs(tokens: readonly string[]): ParsedPolicyArgs {
  if (tokens.some(isHelpToken)) {
    return { ok: true, help: true, action: "status", yes: false };
  }
  const subcommand = tokens[0];
  if (subcommand !== "auto-merge") {
    return {
      ok: false,
      error: `Unknown policy subcommand: ${subcommand === undefined ? "(none)" : subcommand}\n${POLICY_HELP}`,
    };
  }
  const actionToken = tokens[1];
  if (
    actionToken === undefined ||
    actionToken.startsWith("--") ||
    (actionToken !== "status" && actionToken !== "on" && actionToken !== "off")
  ) {
    return {
      ok: false,
      error: `Unknown policy auto-merge action: ${actionToken ?? "(none)"}\n${POLICY_HELP}`,
    };
  }
  const action = actionToken as "status" | "on" | "off";
  let yes = false;
  let allowHighRisk: boolean | undefined;
  let onBlocked: "ask-owner" | "hold" | undefined;
  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--") || token === "--") {
      return { ok: false, error: `Unexpected argument: ${token}\n${POLICY_HELP}` };
    }
    const body = token.slice(2);
    const separator = body.indexOf("=");
    const flag = separator === -1 ? body : body.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : body.slice(separator + 1);
    if (flag === "yes") {
      if (inlineValue !== undefined) {
        return { ok: false, error: `--yes takes no value\n${POLICY_HELP}` };
      }
      yes = true;
      continue;
    }
    let value = inlineValue;
    if (value === undefined) {
      const next = tokens[index + 1];
      if (next === undefined || next.startsWith("--")) {
        return { ok: false, error: `--${flag} requires a value\n${POLICY_HELP}` };
      }
      value = next;
      index += 1;
    }
    if (flag === "allow-high-risk") {
      if (value !== "true" && value !== "false") {
        return {
          ok: false,
          error: `--allow-high-risk accepts only true or false, not '${value}'\n${POLICY_HELP}`,
        };
      }
      allowHighRisk = value === "true";
      continue;
    }
    if (flag === "on-blocked") {
      if (value !== "ask-owner" && value !== "hold") {
        return {
          ok: false,
          error: `--on-blocked accepts only ask-owner or hold, not '${value}'\n${POLICY_HELP}`,
        };
      }
      onBlocked = value;
      continue;
    }
    return { ok: false, error: `Unknown policy auto-merge option: --${flag}\n${POLICY_HELP}` };
  }
  if (yes && action === "status") {
    return { ok: false, error: `--yes applies to on and off only\n${POLICY_HELP}` };
  }
  return {
    ok: true,
    help: false,
    action,
    yes,
    ...(allowHighRisk !== undefined ? { allowHighRisk } : {}),
    ...(onBlocked !== undefined ? { onBlocked } : {}),
  };
}

/** `policy auto-merge status`: print the resolved policy and its revision. */
async function showAutoMergeStatus(file: string, io: CliIo): Promise<number> {
  const state = await readInstallationState(file);
  if (state.status === "unreadable") {
    io.stderr(`${file}: could not be read (${state.reason})\n`);
    return 1;
  }
  if (state.status === "invalid") {
    io.stderr("the installation file is invalid; fix it by hand:\n");
    printErrors(io, state.errors);
    return 1;
  }
  if (state.status === "absent") {
    io.stdout("no installation file; auto-merge: off (the default)\n");
    return 0;
  }
  if (state.status === "v1") {
    io.stdout(
      "auto-merge: off (schema version 1 has no policy section; migrate to v2 to change it)\n",
    );
    return 0;
  }
  for (const line of renderAutoMergeStatus(summariseAutoMerge(state.installation))) {
    io.stdout(`${line}\n`);
  }
  return 0;
}

/** `policy auto-merge on|off`: draft, diff, confirm and compare-and-swap write. */
async function changeAutoMerge(
  file: string,
  action: "on" | "off",
  parsed: Extract<ParsedPolicyArgs, { ok: true }>,
  io: CliIo,
  options: PolicyCliOptions,
): Promise<number> {
  const state = await readInstallationState(file);
  if (state.status === "unreadable") {
    io.stderr(`${file}: could not be read (${state.reason})\n`);
    return 1;
  }
  if (state.status === "invalid") {
    io.stderr(
      "the installation file is invalid; fix it by hand before changing auto-merge:\n",
    );
    printErrors(io, state.errors);
    return 1;
  }
  if (state.status === "absent") {
    if (action === "on") {
      io.stderr("no installation file; run fleet-v2 init first\n");
      return 1;
    }
    io.stdout("auto-merge is already off (no installation file); nothing was written\n");
    return 0;
  }
  if (state.status === "v1") {
    if (action === "on") {
      io.stderr(
        "the installation file is schema version 1, which has no policy section; migrate to v2 before enabling auto-merge\n",
      );
      return 1;
    }
    io.stdout("auto-merge is already off (schema version 1); nothing was written\n");
    return 0;
  }

  const change: AutoMergeChange = {
    enabled: action === "on",
    ...(parsed.allowHighRisk !== undefined ? { allowHighRisk: parsed.allowHighRisk } : {}),
    ...(parsed.onBlocked !== undefined ? { onBlocked: parsed.onBlocked } : {}),
  };
  const draft = draftAutoMerge(state.value, change);
  if (draft.status === "invalid") {
    io.stderr(
      "the installation file is invalid; fix it by hand before changing auto-merge:\n",
    );
    printErrors(io, draft.errors);
    return 1;
  }
  if (draft.status === "unchanged") {
    io.stdout(`auto-merge is already ${action}; nothing was written\n`);
    return 0;
  }

  if (draft.after !== undefined) {
    for (const line of renderAutoMergeImpact(draft.before, draft.after)) {
      io.stdout(`${line}\n`);
    }
  }
  if (draft.errors.length > 0) {
    io.stderr("refused: the installation would be invalid with this change:\n");
    printErrors(io, draft.errors);
    printDiff(
      io,
      state.read.status === "read" ? state.read.text : "",
      draft.candidate,
    );
    io.stderr("nothing was written\n");
    return 1;
  }

  const code = await confirmAndWrite(
    file,
    state.read,
    draft.candidate,
    { yes: parsed.yes },
    io,
    { confirm: options.confirm },
  );
  if (code === 0) {
    io.stdout(
      "takes effect for the API after it restarts; CLI attempts use it at once\n",
    );
  }
  return code;
}

/** `fleet-v2 policy <subcommand>`; exit codes: 0 shown/written, 1 refused, 2 usage. */
export async function policyCommand(
  argv: readonly string[],
  io: CliIo,
  options: PolicyCliOptions = {},
): Promise<number> {
  const parsed = parsePolicyArgs(argv);
  if (!parsed.ok) {
    io.stderr(`${parsed.error}\n`);
    return 2;
  }
  if (parsed.help) {
    io.stdout(`${POLICY_HELP}\n`);
    return 0;
  }
  const file =
    options.installationFile ??
    resolveInstallationFile(undefined, process.env, process.cwd());
  return parsed.action === "status"
    ? showAutoMergeStatus(file, io)
    : changeAutoMerge(file, parsed.action, parsed, io, options);
}
