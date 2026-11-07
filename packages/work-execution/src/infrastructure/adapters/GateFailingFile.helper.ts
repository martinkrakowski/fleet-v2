/**
 * PT1a: the repo-relative file a failing gate command names, read from its
 * output. The output itself never leaves this function: only a screened path
 * does (no absolute path, no `..`, bounded, secret-free), or null when no
 * file could be determined. Recognised shapes, in this order:
 *
 *  1. vitest: ` FAIL  <path> > suite > test`;
 *  2. vitest stack frames: ` ❯ <path>:<line>:<col>`;
 *  3. tsc: `<path>(<line>,<col>): error TS...`;
 *  4. eslint (stylish): a bare `<path>` header line followed by `  <l>:<c>  error ...`.
 *
 * A workspace test or typecheck prints paths relative to the workspace, so a
 * path is made repo-relative with the workspace directory, read from the
 * turbo line prefix (`@fleet/<name>:<task>: `) or the command's own
 * `workspace @fleet/<name>` argument. An absolute path is made relative to the
 * worktree when it lies inside it, and is refused otherwise. A candidate that
 * fails the screen is skipped and the next is tried. Pure: no I/O, never throws.
 */

import { screenFailingFile } from '@fleet/evidence-and-acceptance';
import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';

/** Output beyond this many characters is not scanned (the cap bounds the work). */
const SCAN_LIMIT_CHARS = 1_000_000;

/** Terminal colour sequences, stripped before matching. */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

const EXT = '(?:[cm]?[jt]sx?|json|mjs|cjs)';
const VITEST_FAIL = new RegExp(`^\\s*FAIL\\s+(\\S+\\.${EXT})(?:\\s|$)`);
const VITEST_FRAME = new RegExp(`^\\s*[❯>]\\s+(\\S+\\.${EXT}):\\d+(?::\\d+)?`);
const TSC_ERROR = new RegExp(`^(\\S+\\.${EXT})\\(\\d+,\\d+\\):\\s+error\\s+TS\\d+`);
const ESLINT_HEADER = new RegExp(`^(\\S+\\.${EXT})\\s*$`);
const ESLINT_ROW = /^\s+\d+:\d+\s+(?:error|warning)\s/;
/** A turbo log prefix: `@fleet/<name>:<task>: `. */
const TURBO_PREFIX = /^(@fleet\/[a-z0-9-]+):[a-z0-9:_-]+:\s?/;

/** The workspaces that live under `apps/`; every other `@fleet/<name>` is under `packages/`. */
const APP_WORKSPACES: ReadonlySet<string> = new Set(['api', 'cli', 'mcp', 'web']);

function isSecretShaped(text: string): boolean {
  return containsSecretShape(text) || LANE_DIFF_SECRET_PATTERNS.some((pattern) => pattern.regex.test(text));
}

/** The repo directory of an `@fleet/<name>` workspace, or null for any other name. */
function workspaceDirOf(packageName: string): string | null {
  const match = /^@fleet\/([a-z0-9-]+)$/.exec(packageName);
  if (match === null) {
    return null;
  }
  const name = match[1] as string;
  return (APP_WORKSPACES.has(name) ? 'apps/' : 'packages/') + name;
}

/** The workspace a command runs in, from its `workspace <name>` argument; null when it names none. */
function commandWorkspaceDir(argv: unknown): string | null {
  if (!Array.isArray(argv)) {
    return null;
  }
  const at = argv.indexOf('workspace');
  const name: unknown = at === -1 ? undefined : argv[at + 1];
  return typeof name === 'string' ? workspaceDirOf(name) : null;
}

/** The repo-relative candidate: relative to the worktree when inside it, then under the workspace directory. */
function resolveCandidate(candidate: string, worktreePath: string, workspaceDir: string | null): string {
  const root = worktreePath.endsWith('/') ? worktreePath : worktreePath + '/';
  const relative = worktreePath !== '' && candidate.startsWith(root) ? candidate.slice(root.length) : candidate;
  if (
    workspaceDir === null ||
    relative.startsWith('/') ||
    relative.startsWith('packages/') ||
    relative.startsWith('apps/')
  ) {
    return relative;
  }
  return workspaceDir + '/' + relative;
}

interface OutputLine {
  readonly text: string;
  readonly workspaceDir: string | null;
}

function linesOf(text: string, defaultDir: string | null): OutputLine[] {
  return text.split(/\r?\n/).map((raw) => {
    const prefix = TURBO_PREFIX.exec(raw);
    if (prefix === null) {
      return { text: raw, workspaceDir: defaultDir };
    }
    return { text: raw.slice(prefix[0].length), workspaceDir: workspaceDirOf(prefix[1] as string) ?? defaultDir };
  });
}

function firstScreened(
  lines: readonly OutputLine[],
  pattern: RegExp,
  worktreePath: string,
  followedBy?: RegExp,
): string | null {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as OutputLine;
    const match = pattern.exec(line.text);
    if (match === null || match[1] === undefined) {
      continue;
    }
    if (followedBy !== undefined && !followedBy.test(lines[index + 1]?.text ?? '')) {
      continue;
    }
    const screened = screenFailingFile(resolveCandidate(match[1], worktreePath, line.workspaceDir));
    if (screened !== null && !isSecretShaped(screened)) {
      return screened;
    }
  }
  return null;
}

/** The screened failing file named by `stdout` and `stderr` of the command `argv`, or null. */
export function extractFailingFile(
  stdout: unknown,
  stderr: unknown,
  worktreePath: unknown,
  argv?: unknown,
): string | null {
  try {
    const parts = [stdout, stderr].filter((part): part is string => typeof part === 'string');
    const text = parts.join('\n').slice(0, SCAN_LIMIT_CHARS).replace(ANSI, '');
    const root = typeof worktreePath === 'string' ? worktreePath : '';
    const lines = linesOf(text, commandWorkspaceDir(argv));
    return (
      firstScreened(lines, VITEST_FAIL, root) ??
      firstScreened(lines, VITEST_FRAME, root) ??
      firstScreened(lines, TSC_ERROR, root) ??
      firstScreened(lines, ESLINT_HEADER, root, ESLINT_ROW)
    );
  } catch {
    return null;
  }
}
