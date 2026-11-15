/**
 * The `lane` command group of the CLI driver. `diff-check` (CO34a) runs the
 * existing pure `checkLaneDiff` through `LaneDiffCheckAdapter` over one
 * worktree, so a conducted run can call the check without the frozen shell
 * script. The command prints path, line and rule name only — a matched
 * value is never printed — and it never echoes a rejected prefix, a base
 * string, git stdout or git stderr. All I/O goes through the injected
 * `CliIo`; no `console` in package code.
 */

import type { CliIo } from '../index.js';
import {
  LaneDiffCheckAdapter,
  LocalExecutor,
  parseLaneDiffCliArgs,
  type LaneDiffCheckRequest,
  type LaneDiffCheckResult,
} from '@fleet/work-execution';

/** The baseline-off request shape: no caller-supplied base commit. */
type LaneDiffBaselineOffRequest = Omit<LaneDiffCheckRequest, 'baseCommit'>;

/**
 * The checker the command calls. `checkLaneDiffBaselineOff` is a method on
 * the production adapter, not a port method; a fake in tests may omit it and
 * the command then refuses with `unknown` instead of falling through to
 * `checkLaneDiff`.
 */
export interface LaneDiffChecker {
  checkLaneDiff(request: LaneDiffCheckRequest): Promise<LaneDiffCheckResult>;
  checkLaneDiffBaselineOff?(
    request: LaneDiffBaselineOffRequest,
  ): Promise<LaneDiffCheckResult>;
}

/** Help for `lane` and `lane diff-check`: flag names only, no sample value. */
const LANE_HELP = `Usage: fleet-v2 lane diff-check <worktree> --allowed-path-prefixes '<json array>' [--base <value>] [--policy-protected-paths '<json array>']

Scans one worktree's changed files (tracked, staged and untracked) against
the frozen brief's allowed path prefixes, the fixed protected-path table and
the shared secret-pattern registry. Findings carry path, line and rule name
only; a matched value is never printed.

  --allowed-path-prefixes   required; a JSON array of 1 to 32 relative path
                            prefixes from the frozen brief
  --base                    optional; only a full 40-digit lowercase hex
                            commit sha enables the base-line allowance. Any
                            other value runs the check with the allowance
                            off, which is never a clean exit.
  --policy-protected-paths  optional; a JSON array of 0 to 32 extra
                            protected path prefixes

Exit codes: 0 clean with a trusted base sha, 1 findings or error or no
trusted base, 2 usage.`;

/** True when argv asks for help; a flag's value position never counts. */
function laneHelpRequested(argv: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') return true;
    if (
      token === '--allowed-path-prefixes' ||
      token === '--policy-protected-paths' ||
      token === '--base'
    ) {
      index += 1;
    }
  }
  return false;
}

/**
 * A finding is safe to print only when its path is a bounded string with no
 * newline, carriage return or NUL, its line is absent or a bounded positive
 * integer, and its rule name is a bounded identifier. Anything else makes
 * the whole result unknown.
 */
function isSafeFinding(finding: unknown): finding is {
  path: string;
  line?: number;
  rule: string;
} {
  if (typeof finding !== 'object' || finding === null) return false;
  const record = finding as { path?: unknown; line?: unknown; rule?: unknown };
  if (
    typeof record.path !== 'string' ||
    record.path.length < 1 ||
    record.path.length > 4096 ||
    record.path.includes('\n') ||
    record.path.includes('\r') ||
    record.path.includes('\u0000')
  ) {
    return false;
  }
  if (record.line !== undefined) {
    if (
      typeof record.line !== 'number' ||
      !Number.isInteger(record.line) ||
      record.line < 1 ||
      record.line > 100000000
    ) {
      return false;
    }
  }
  if (typeof record.rule !== 'string' || !/^[A-Za-z0-9:._-]{1,80}$/.test(record.rule)) {
    return false;
  }
  return true;
}

/**
 * An error reason is printed only when it is one of the fixed reasons or a
 * bounded single line that starts with the adapter's own prefix. Anything
 * else prints the fixed unknown line; git stderr and a thrown message are
 * never echoed.
 */
function isPrintableErrorReason(reason: unknown): reason is string {
  if (typeof reason !== 'string') return false;
  if (reason === 'invalid-base-commit' || reason === 'unsupported-path-characters') {
    return true;
  }
  return (
    reason.length <= 200 &&
    reason.startsWith('lane diff check:') &&
    !reason.includes('\n')
  );
}

/**
 * Run `lane diff-check`. Returns 0 only for a clean result with a trusted
 * base sha; findings, errors, a missing trusted base and every unknown
 * state exit 1, usage exits 2.
 */
export async function laneCommand(
  argv: readonly string[],
  io: CliIo,
  checker?: LaneDiffChecker,
): Promise<number> {
  if (laneHelpRequested(argv)) {
    io.stdout(`${LANE_HELP}\n`);
    return 0;
  }
  const parsed = parseLaneDiffCliArgs(argv);
  if (parsed.kind !== 'ready') {
    io.stderr('lane diff-check: usage\n');
    return 2;
  }
  // The adapter is constructed only after a ready parse; a fake checker in
  // tests takes the injected seat.
  const active: LaneDiffChecker =
    checker ?? new LaneDiffCheckAdapter(new LocalExecutor());

  let result: LaneDiffCheckResult | null = null;
  try {
    if (parsed.baseline.allowance === 'trusted') {
      result = await active.checkLaneDiff({
        worktreePath: parsed.worktreePath,
        baseCommit: parsed.baseline.baseCommit,
        allowedPathPrefixes: parsed.allowedPathPrefixes,
        ...(parsed.policyProtectedPaths !== undefined
          ? { policyProtectedPaths: parsed.policyProtectedPaths }
          : {}),
      });
    } else {
      if (typeof active.checkLaneDiffBaselineOff !== 'function') {
        io.stderr('lane diff-check: unknown\n');
        return 1;
      }
      // One fixed warning; the supplied base text is neither printed nor
      // passed into the adapter.
      io.stderr('lane diff-check: base is not a full commit sha; no base-line allowance\n');
      result = await active.checkLaneDiffBaselineOff({
        worktreePath: parsed.worktreePath,
        allowedPathPrefixes: parsed.allowedPathPrefixes,
        ...(parsed.policyProtectedPaths !== undefined
          ? { policyProtectedPaths: parsed.policyProtectedPaths }
          : {}),
      });
    }
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      io.stderr('lane diff-check: unknown\n');
      return 1;
    }
    // Success requires exactly `{outcome:'clean'}` on a plain object. An
    // array carrying the property, or a clean result with any extra field,
    // is a malformed result and fails closed.
    const resultKeys = Object.keys(result as Record<string, unknown>);
    if (result.outcome === 'clean' && resultKeys.length === 1) {
      // A clean scan with the base-line allowance off is not a pass: the
      // committed range cannot be named without a sha, and a ref is
      // lane-writable. The one warning is the stderr; stdout stays empty.
      return parsed.baseline.allowance === 'trusted' ? 0 : 1;
    }
    if (result.outcome === 'findings') {
      const findings: unknown = (result as { findings?: unknown }).findings;
      if (!Array.isArray(findings) || findings.length === 0) {
        io.stderr('lane diff-check: unknown\n');
        return 1;
      }
      // Index by number instead of `every`: `every` skips sparse-array
      // holes and a result array carrying its own `every` method would
      // override the call. A hole yields undefined and is rejected.
      const findingList: readonly unknown[] = findings;
      for (let index = 0; index < findingList.length; index += 1) {
        if (!isSafeFinding(findingList[index])) {
          io.stderr('lane diff-check: unknown\n');
          return 1;
        }
      }
      for (let index = 0; index < findingList.length; index += 1) {
        const finding = findingList[index] as {
          path: string;
          line?: number;
          rule: string;
        };
        io.stdout(
          finding.line === undefined
            ? `${finding.path}:${finding.rule}\n`
            : `${finding.path}:${finding.line}:${finding.rule}\n`,
        );
      }
      return 1;
    }
    if (result.outcome === 'error') {
      const reason: unknown = (result as { reason?: unknown }).reason;
      io.stderr(
        isPrintableErrorReason(reason)
          ? `${reason}\n`
          : 'lane diff-check: unknown\n',
      );
      return 1;
    }
  } catch {
    // A throwing getter on the checker result, or any other read failure,
    // is exit 1; the thrown message is never printed.
    io.stderr('lane diff-check: unknown\n');
    return 1;
  }
  io.stderr('lane diff-check: unknown\n');
  return 1;
}
