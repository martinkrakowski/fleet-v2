// Adapter for plan S2: evaluates the frozen acceptance spec on the attempt's
// recorded worktree host. Predicates are data from the frozen manifest; model
// reports are never an input. Results carry no command output: output is read
// only by the coverage reader, and details carry exit codes, counts, durations
// and diff-check findings (path, line, rule) — never a matched value.
/**
 * GatePredicateAdapter implements GatePredicatePort over an injected
 * CommandExecutorPort (resolved for the attempt's recorded host). The commit
 * since the base at the candidate head with a clean tree runs first, then the
 * lane diff check; a command never runs after either did not pass (those
 * commands are reported skipped). The fixed argv commands then run
 * concurrently (KS3), bounded by the host's in-process slot budget (the
 * declared gate-slot count). With one slot, or none declared, the run is the
 * sequential gate of old: the first non-pass stops it and later commands are
 * reported skipped, never executed. Results come back in declared order, each as that
 * predicate really ended: one predicate's failure or timeout never cancels,
 * relabels or hides another's. The verdict is decided from the first non-pass
 * in declared order by the use case, so K4-2's typed verdict is unchanged.
 * With a receipt reuse wiring (KS2), a command whose full key equals a
 * recorded passing receipt is not run again. Nothing here throws for runtime
 * input; a predicate that could not run is `unknown`, never a pass.
 */

import type {
  GatePredicatePort,
  GatePredicateResult,
  GatePredicateKind,
  GatePredicateVerdict,
  EvaluateGatePredicatesRequest,
  EvaluateGatePredicatesResult,
} from '../../application/ports/out/GatePredicatePort.out-port.js';
import type {
  CommandExecutorPort,
  CommandRunResult,
} from '../../application/ports/out/CommandExecutorPort.out-port.js';
import type { ExecutorForRecordedHostResult } from './ExecutorForHost.helper.js';

/** The trusted host-wide gate slot a host may declare (KF-30b). */
export interface GateSlotConfiguration {
  /** Absolute path of the host-installed `gate-slot` wrapper. */
  readonly path: string;
  /** The host-wide slot budget; equal to the hand-run gate's `FLEET_V2_GATE_SLOTS`. */
  readonly slots: number;
}
import { LaneDiffCheckAdapter } from './LaneDiffCheckAdapter.adapter.js';
import type {
  LaneDiffCheckPort,
  LaneDiffCheckResult,
} from '../../application/ports/out/LaneDiffCheckPort.out-port.js';
import { SshExecutor } from './SshExecutor.adapter.js';
import { GateSlotBudget, readGateSlotCapacity } from './GateSlotBudget.helper.js';
import { createHash } from 'node:crypto';
import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';
import { buildGateReceiptKey } from '../../domain/gate-receipt-key.js';
import type { GateReceiptKey } from '../../domain/gate-receipt-key.js';
import type { GateReceiptReusePort } from '../../application/ports/out/GateReceiptReusePort.out-port.js';
import {
  applyCoverage,
  isCheckCoverage,
  readCheckCoverage,
} from '@fleet/evidence-and-acceptance';
import type {
  CheckCoverage,
  EvidenceResultValue,
} from '@fleet/evidence-and-acceptance';
import { MAX_GATE_ARGV_ENTRIES, MAX_GATE_ARG_CHARACTERS, MAX_GATE_COMMANDS, gateCommandPredicateName } from '../../domain/value-objects/AcceptanceSpec.vo.js';
import type { GateCommand } from '../../domain/value-objects/AcceptanceSpec.vo.js';
import type { AttemptRunnerRecord } from '../../domain/execution-records.js';

export interface GatePredicateAdapterOptions {
  /** The composition root passes ExecutorForHost.executorForRecordedHost. */
  readonly executorForRecordedHost: (runner: AttemptRunnerRecord | null) => ExecutorForRecordedHostResult;
  /** Default: (executor) => new LaneDiffCheckAdapter(executor). */
  readonly laneDiffCheckFor?: (executor: CommandExecutorPort) => LaneDiffCheckPort;
  /** Per-command wall-clock budget; default 30 minutes. */
  readonly commandTimeoutMs?: number;
  /** Whether exit 255 is the transport's failure; default `executor instanceof SshExecutor`. */
  readonly isRemote?: (executor: CommandExecutorPort) => boolean;
  /** Millisecond clock for durations; default Date.now. */
  readonly nowMs?: () => number;
  /**
   * Further cap on concurrent predicates per host, never above the host's
   * declared gate-slot count. Default: the declared slot count (one when the
   * host declares none).
   */
  readonly maxConcurrentPredicates?: number;
  /** Cap on the output one command may produce (stdout + stderr); default 16 MiB. */
  readonly maxOutputBytes?: number;
  /** KS2 receipt reuse; absent means every command runs, exactly as before. */
  readonly receiptReuse?: GateReceiptReuseWiring;
}

/**
 * What the receipt key needs beyond the spec: the toolchain versions and the
 * declared environment digest of the host, read through its executor. Each
 * returns an unvalidated value; an unreadable one (or a throw) is a miss.
 */
export interface GateReceiptReuseWiring {
  readonly port: GateReceiptReusePort;
  readonly toolchainVersions: (executor: CommandExecutorPort, worktreePath: string) => Promise<unknown>;
  readonly declaredEnvironmentDigest: (executor: CommandExecutorPort, worktreePath: string) => Promise<unknown>;
}

const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** Longest result detail the adapter returns; longer text is cut. */
const MAX_DETAIL_LENGTH = 300;
const WITHHELD_DETAIL = 'detail withheld: secret-shaped text';
const WITHHELD_LONG_DETAIL = 'coverage reason withheld: too long';
const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
/** The fixed last stderr line `bin/gate-slot` prints when no slot freed up (KF-30a). */
const GATE_SLOT_WAIT_LIMIT_LINE = 'gate-slot: no slot within the wait limit';
const GATE_SLOT_EXIT_CODE = 75;
/** The slot wait may use at most a third of the command budget, capped at 600 s. */
const GATE_SLOT_MAX_WAIT_SECONDS = 600;
const GATE_SLOT_WAIT_DIVISOR_MS = 3000;
const GIT_TIMEOUT_MS = 60 * 1000;
const GIT_HARDENING: readonly string[] = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
];

/** A run that never reported a completed exit is not a verdict. */
function gitFailed(run: CommandRunResult): boolean {
  return run.error !== undefined || run.exitCode === null;
}

/** The last stderr line after stripping one trailing newline, trimmed. */
function lastStderrLine(stderr: string): string {
  const stripped = stderr.replace(/\r?\n$/, '');
  const lines = stripped.split(/\r?\n/);
  return (lines[lines.length - 1] ?? '').trim();
}

function skipped(name: string, kind: GatePredicateKind): GatePredicateResult {
  return {
    name,
    kind,
    verdict: 'skipped',
    exitCode: null,
    durationMs: 0,
    detail: 'not run: an earlier predicate did not pass',
  };
}

function commandName(command: GateCommand, index: number): string {
  return gateCommandPredicateName(command.argv, index);
}

/** Raw command verdict before coverage is applied; exit 255 is only a transport failure when remote. */
function rawVerdict(run: CommandRunResult, isRemote: boolean): EvidenceResultValue {
  if (run.error !== undefined || run.exitCode === null) {
    return 'unknown';
  }
  if (run.exitCode === 255 && isRemote) {
    return 'unknown';
  }
  if (run.exitCode === 0) {
    return 'pass';
  }
  return 'fail';
}

function mapVerdict(value: EvidenceResultValue): GatePredicateVerdict {
  if (value === 'pass') {
    return 'pass';
  }
  if (value === 'fail') {
    return 'fail';
  }
  return 'unknown';
}

function detailForCommand(
  run: CommandRunResult,
  command: GateCommand,
  coverage: CheckCoverage | undefined,
): string {
  const exit = run.exitCode === null ? 'no exit code' : 'exit ' + String(run.exitCode);
  if (command.coverage === undefined) {
    return exit;
  }
  if (coverage !== undefined && coverage.ran) {
    return (
      exit +
      ', coverage ' +
      coverage.units +
      ' ' +
      coverage.unitKind +
      ' (at least ' +
      command.coverage.minUnits +
      ')'
    );
  }
  const reason = coverage !== undefined ? coverage.reason : 'coverage reader returned a malformed value';
  return exit + ', coverage not read (' + reason + ')';
}

/** A detail that is cut to the bound and withheld whole when it looks like a secret. Never throws. */
function boundedDetail(detail: unknown): string {
  if (typeof detail !== 'string') {
    return '';
  }
  if (containsSecretShape(detail) || LANE_DIFF_SECRET_PATTERNS.some((pattern) => pattern.regex.test(detail))) {
    return WITHHELD_DETAIL;
  }
  return detail.length > MAX_DETAIL_LENGTH ? detail.slice(0, MAX_DETAIL_LENGTH) : detail;
}

/** The coverage with a withheld or cut reason when a reader's reason text is secret-shaped or long. */
export function boundedCoverage(coverage: CheckCoverage): CheckCoverage {
  if (coverage.ran) {
    return coverage;
  }
  // A long reason is withheld whole, never cut: its prefix would still be echoed.
  const reason =
    typeof coverage.reason === 'string' && coverage.reason.length > MAX_DETAIL_LENGTH
      ? WITHHELD_LONG_DETAIL
      : boundedDetail(coverage.reason);
  return reason === coverage.reason ? coverage : { ran: false, reason };
}

function withBoundedDetail(result: GatePredicateResult): GatePredicateResult {
  const detail = boundedDetail(result.detail);
  const coverage = result.coverage === undefined ? undefined : boundedCoverage(result.coverage);
  if (detail === result.detail && coverage === result.coverage) {
    return result;
  }
  return { ...result, detail, ...(coverage === undefined ? {} : { coverage }) };
}

/** A predicate that could not run: unknown, never a pass. */
function unknownResult(
  name: string,
  kind: GatePredicateKind,
  detail: string,
  durationMs: number,
): GatePredicateResult {
  return { name, kind, verdict: 'unknown', exitCode: null, durationMs, detail };
}

function isUsableRequest(request: EvaluateGatePredicatesRequest): boolean {
  if (request === null || typeof request !== 'object' || typeof request.worktreePath !== 'string') {
    return false;
  }
  if (request.worktreePath.length === 0 || !Array.isArray(request.allowedPathPrefixes)) {
    return false;
  }
  const spec = request.spec as { commands?: unknown } | null | undefined;
  if (spec === null || typeof spec !== 'object' || !Array.isArray(spec.commands)) {
    return false;
  }
  if (spec.commands.length < 1 || spec.commands.length > MAX_GATE_COMMANDS) {
    return false;
  }
  return spec.commands.every(
    (command: unknown) =>
      command !== null &&
      typeof command === 'object' &&
      Array.isArray((command as { argv?: unknown }).argv) &&
      (command as { argv: unknown[] }).argv.length > 0 &&
      (command as { argv: unknown[] }).argv.length <= MAX_GATE_ARGV_ENTRIES &&
      (command as { argv: unknown[] }).argv.every(
        (entry) => typeof entry === 'string' && entry.length <= MAX_GATE_ARG_CHARACTERS && !entry.includes('\0'),
      ),
  );
}

/** The receipt key inputs read once per request: unvalidated, the key builder refuses what is unreadable. */
interface ReceiptContext {
  readonly treeHash: unknown;
  readonly toolchainVersions: unknown;
  readonly declaredEnvironmentDigest: unknown;
}

export class GatePredicateAdapter implements GatePredicatePort {
  private readonly executorForRecordedHost: (
    runner: AttemptRunnerRecord | null,
  ) => ExecutorForRecordedHostResult;
  private readonly laneDiffCheckFor: (executor: CommandExecutorPort) => LaneDiffCheckPort;
  private readonly commandTimeoutMs: number;
  private readonly isRemote: (executor: CommandExecutorPort) => boolean;
  private readonly nowMs: () => number;
  private readonly maxConcurrentPredicates: number | undefined;
  private readonly maxOutputBytes: number;
  private readonly receiptReuse: GateReceiptReuseWiring | undefined;
  /** One budget per host, shared by every lane gated through this adapter. */
  private readonly budgets = new Map<string, GateSlotBudget>();
  /** Passing runs in flight by receipt key, so an identical predicate on another lane waits instead of running twice. */
  private readonly inFlight = new Map<string, Promise<GatePredicateResult>>();

  constructor(options: GatePredicateAdapterOptions) {
    this.executorForRecordedHost = options.executorForRecordedHost;
    this.laneDiffCheckFor =
      options.laneDiffCheckFor ?? ((executor) => new LaneDiffCheckAdapter(executor));
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.isRemote = options.isRemote ?? ((executor) => executor instanceof SshExecutor);
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.maxConcurrentPredicates =
      options.maxConcurrentPredicates === undefined
        ? undefined
        : readGateSlotCapacity(options.maxConcurrentPredicates);
    this.maxOutputBytes =
      typeof options.maxOutputBytes === 'number' &&
      Number.isSafeInteger(options.maxOutputBytes) &&
      options.maxOutputBytes > 0
        ? Math.min(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES)
        : DEFAULT_MAX_OUTPUT_BYTES;
    this.receiptReuse = options.receiptReuse;
  }

  async evaluateGatePredicates(
    request: EvaluateGatePredicatesRequest,
  ): Promise<EvaluateGatePredicatesResult> {
    try {
      return await this.evaluateGuarded(request);
    } catch {
      return { outcome: 'unavailable', reason: 'gate predicate evaluation did not complete' };
    }
  }

  /** The budget of the request's host: the declared gate-slot count (one when none), cut by the adapter's own cap. */
  private budgetFor(request: EvaluateGatePredicatesRequest, gateSlot: GateSlotConfiguration | undefined): GateSlotBudget {
    const declared = gateSlot === undefined ? 1 : readGateSlotCapacity(gateSlot.slots);
    const capacity =
      this.maxConcurrentPredicates === undefined ? declared : Math.min(declared, this.maxConcurrentPredicates);
    const hostName = request.runner?.hostName;
    const id = typeof hostName === 'string' && hostName.length > 0 ? hostName : 'legacy';
    const existing = this.budgets.get(id);
    if (existing !== undefined) {
      existing.reconcile(capacity);
      return existing;
    }
    const created = new GateSlotBudget(capacity);
    this.budgets.set(id, created);
    return created;
  }

  private async evaluateGuarded(
    request: EvaluateGatePredicatesRequest,
  ): Promise<EvaluateGatePredicatesResult> {
    if (!isUsableRequest(request)) {
      return { outcome: 'unavailable', reason: 'gate predicate request is malformed' };
    }
    const resolved = this.executorForRecordedHost(request.runner);
    if (!resolved.ok) {
      return { outcome: 'unavailable', reason: boundedDetail(resolved.reason) };
    }
    const executor = resolved.executor;
    // KF-30b: the host's declared gate-slot throttle. Absent means the
    // command runs exactly as before, without any prefix.
    const gateSlot: GateSlotConfiguration | undefined =
      resolved.hostSpec?.runner?.gateSlot === undefined
        ? undefined
        : {
            path: resolved.hostSpec.runner.gateSlot.path,
            slots: resolved.hostSpec.runner.gateSlot.slots,
          };
    const budget = this.budgetFor(request, gateSlot);

    // Commit and diff check run first, one at a time, inside the budget; they gate every command.
    const commitRun = await budget.run(() => this.commitPredicate(executor, request));
    const commit = commitRun.ok
      ? commitRun.value
      : unknownResult('commit', 'commit', 'commit predicate did not complete', 0);
    let diff: GatePredicateResult;
    if (commit.verdict === 'pass') {
      const diffRun = await budget.run(() => this.diffPredicate(executor, request));
      diff = diffRun.ok
        ? diffRun.value
        : unknownResult('diff-check', 'diff-check', 'diff check did not complete', 0);
    } else {
      diff = skipped('diff-check', 'diff-check');
    }

    const gated = diff.verdict !== 'pass';
    let receiptContext: Promise<ReceiptContext | null> | null = null;
    const contextOnce = (): Promise<ReceiptContext | null> => {
      receiptContext ??= this.readReceiptContext(executor, request, budget);
      return receiptContext;
    };
    // Every command starts at once; the budget decides how many really run. Each
    // predicateForCommand call settles on its own and never throws, so one
    // command's failure or timeout cannot cancel or relabel another's result.
    const commandResults: GatePredicateResult[] = [];
    if (budget.capacity === 1) {
      // One slot: exactly the sequential gate of old. The first non-pass stops the
      // run and every later command is reported skipped and never executed.
      for (const [index, command] of request.spec.commands.entries()) {
        const blocked = gated || commandResults.some((result) => result.verdict !== 'pass');
        commandResults.push(
          blocked
            ? skipped(commandName(command, index), 'command')
            : await this.predicateForCommand(executor, request, command, index, gateSlot, budget, contextOnce),
        );
      }
    } else {
      commandResults.push(
        ...(await Promise.all(
          request.spec.commands.map((command, index) =>
            gated
              ? Promise.resolve(skipped(commandName(command, index), 'command'))
              : this.predicateForCommand(executor, request, command, index, gateSlot, budget, contextOnce),
          ),
        )),
      );
    }

    return {
      outcome: 'evaluated',
      results: [commit, diff, ...commandResults].map(withBoundedDetail),
    };
  }

  /** The tree hash, toolchain versions and declared environment digest, or null when reuse is not wired. Never throws. */
  private async readReceiptContext(
    executor: CommandExecutorPort,
    request: EvaluateGatePredicatesRequest,
    budget: GateSlotBudget,
  ): Promise<ReceiptContext | null> {
    const wiring = this.receiptReuse;
    if (wiring === undefined) {
      return null;
    }
    const read = await budget.run(async () => {
      const tree = await this.runGit(executor, request.worktreePath, [
        'rev-parse',
        '--verify',
        '--quiet',
        request.candidateHeadSha + '^{tree}',
      ]);
      const treeHash = gitFailed(tree) || tree.exitCode !== 0 ? undefined : tree.stdout.trim();
      const toolchainVersions = await wiring.toolchainVersions(executor, request.worktreePath);
      const declaredEnvironmentDigest = await wiring.declaredEnvironmentDigest(executor, request.worktreePath);
      return { treeHash, toolchainVersions, declaredEnvironmentDigest };
    });
    return read.ok ? read.value : null;
  }

  /** One command's outcome: a reused receipt, a run, or `unknown`. Never throws. */
  private async predicateForCommand(
    executor: CommandExecutorPort,
    request: EvaluateGatePredicatesRequest,
    command: GateCommand,
    index: number,
    gateSlot: GateSlotConfiguration | undefined,
    budget: GateSlotBudget,
    contextOnce: () => Promise<ReceiptContext | null>,
  ): Promise<GatePredicateResult> {
    const name = commandName(command, index);
    const started = this.nowMs();
    try {
      const execute = async (): Promise<GatePredicateResult> => {
        const run = await budget.run(() =>
          this.runCommand(executor, request.worktreePath, command, index, gateSlot),
        );
        return run.ok
          ? run.value
          : unknownResult(name, 'command', 'command did not complete', this.nowMs() - started);
      };
      const wiring = this.receiptReuse;
      const key = wiring === undefined ? null : await this.receiptKeyFor(command, name, contextOnce);
      if (wiring === undefined || key === null) {
        return await execute();
      }
      const found = await this.findReceipt(wiring, key);
      if (found !== null) {
        return { ...found, name, kind: 'command' };
      }
      const flightId = JSON.stringify(key);
      const flying = this.inFlight.get(flightId);
      if (flying !== undefined) {
        const shared = await flying;
        if (shared.verdict === 'pass') {
          return { ...shared, name, kind: 'command', durationMs: 0, detail: 'reused receipt: ' + shared.detail };
        }
        // The other run did not pass (a timeout may be transient): run this one's own.
        return await execute();
      }
      const flight = (async (): Promise<GatePredicateResult> => {
        const result = await execute();
        if (result.verdict === 'pass') {
          await this.recordReceipt(wiring, key, result);
        }
        return result;
      })();
      this.inFlight.set(flightId, flight);
      try {
        return await flight;
      } finally {
        if (this.inFlight.get(flightId) === flight) {
          this.inFlight.delete(flightId);
        }
      }
    } catch {
      return unknownResult(name, 'command', 'command did not complete', this.nowMs() - started);
    }
  }

  /** The command's receipt key, or null when any component is unreadable (a miss: the command just runs). */
  private async receiptKeyFor(
    command: GateCommand,
    name: string,
    contextOnce: () => Promise<ReceiptContext | null>,
  ): Promise<GateReceiptKey | null> {
    try {
      const context = await contextOnce();
      if (context === null) {
        return null;
      }
      const built = buildGateReceiptKey({
        predicateId: name,
        treeHash: context.treeHash,
        predicateDefinitionDigest: createHash('sha256')
          .update(JSON.stringify({ argv: command.argv, coverage: command.coverage ?? null }))
          .digest('hex'),
        toolchainVersions: context.toolchainVersions,
        declaredEnvironmentDigest: context.declaredEnvironmentDigest,
      });
      return built.ok ? built.key : null;
    } catch {
      return null;
    }
  }

  private async findReceipt(
    wiring: GateReceiptReuseWiring,
    key: GateReceiptKey,
  ): Promise<GatePredicateResult | null> {
    try {
      const found = await wiring.port.findGateReceipt(key);
      if (found.outcome !== 'hit' || found.result.verdict !== 'pass') {
        return null;
      }
      return {
        name: '',
        kind: 'command',
        verdict: 'pass',
        exitCode: found.result.exitCode,
        durationMs: 0,
        detail: 'reused receipt: ' + found.result.detail,
        ...(found.result.coverage === undefined ? {} : { coverage: found.result.coverage }),
      };
    } catch {
      return null;
    }
  }

  /** A failure to record never changes the result: the next gate just runs the command again. */
  private async recordReceipt(
    wiring: GateReceiptReuseWiring,
    key: GateReceiptKey,
    result: GatePredicateResult,
  ): Promise<void> {
    try {
      await wiring.port.recordGateReceipt({
        key,
        result: {
          verdict: 'pass',
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          detail: boundedDetail(result.detail),
          ...(result.coverage === undefined ? {} : { coverage: result.coverage }),
        },
      });
    } catch {
      // Unrecorded is a miss next time, never a failure now.
    }
  }

  private async runGit(
    executor: CommandExecutorPort,
    worktreePath: string,
    argv: readonly string[],
  ): Promise<CommandRunResult> {
    return executor.run(
      ['git', '-C', worktreePath, ...GIT_HARDENING, ...argv],
      { cwd: worktreePath, timeoutMs: GIT_TIMEOUT_MS },
    );
  }

  private async commitPredicate(
    executor: CommandExecutorPort,
    request: EvaluateGatePredicatesRequest,
  ): Promise<GatePredicateResult> {
    const started = this.nowMs();
    const base = request.baseCommit;
    const candidateHeadSha = request.candidateHeadSha;

    const fail = (detail: string): GatePredicateResult => ({
      name: 'commit',
      kind: 'commit',
      verdict: 'fail',
      exitCode: null,
      durationMs: this.nowMs() - started,
      detail,
    });
    const unknown = (detail: string): GatePredicateResult => ({
      name: 'commit',
      kind: 'commit',
      verdict: 'unknown',
      exitCode: null,
      durationMs: this.nowMs() - started,
      detail,
    });

    if (!COMMIT_PATTERN.test(base) || !COMMIT_PATTERN.test(candidateHeadSha)) {
      return fail('invalid base or candidate commit');
    }

    const revParse = await this.runGit(executor, request.worktreePath, ['rev-parse', 'HEAD']);
    if (gitFailed(revParse)) {
      return unknown('git rev-parse did not complete');
    }
    const head = revParse.stdout.trim();
    if (revParse.exitCode !== 0 || head !== candidateHeadSha) {
      return fail('HEAD is not the candidate commit');
    }

    const mergeBase = await this.runGit(executor, request.worktreePath, [
      'merge-base',
      '--is-ancestor',
      base,
      candidateHeadSha,
    ]);
    if (gitFailed(mergeBase)) {
      return unknown('git merge-base did not complete');
    }
    if (mergeBase.exitCode === 1) {
      return fail('base is not an ancestor of the candidate head');
    }
    if (mergeBase.exitCode !== 0) {
      return unknown('git merge-base did not complete');
    }

    const revList = await this.runGit(executor, request.worktreePath, [
      'rev-list',
      '--count',
      base + '..' + candidateHeadSha,
    ]);
    if (gitFailed(revList) || revList.exitCode !== 0) {
      return unknown('git rev-list did not complete');
    }
    const countText = revList.stdout.trim();
    if (!/^\d+$/.test(countText)) {
      return fail('no commit since the base');
    }
    const count = Number.parseInt(countText, 10);
    if (!Number.isSafeInteger(count) || count < 1) {
      return fail('no commit since the base');
    }

    const status = await this.runGit(executor, request.worktreePath, [
      'status',
      '--porcelain=v1',
      '--untracked-files=normal',
    ]);
    if (gitFailed(status) || status.exitCode !== 0) {
      return unknown('git status did not complete');
    }
    if (status.stdout !== '') {
      return fail('uncommitted changes in the worktree');
    }

    return {
      name: 'commit',
      kind: 'commit',
      verdict: 'pass',
      exitCode: null,
      durationMs: this.nowMs() - started,
      detail: 'head ' + candidateHeadSha + ', ' + count + ' commit(s) since the base',
    };
  }

  private diffUnknown(started: number, detail: string): GatePredicateResult {
    return {
      name: 'diff-check',
      kind: 'diff-check',
      verdict: 'unknown',
      exitCode: null,
      durationMs: this.nowMs() - started,
      detail,
    };
  }

  private async diffPredicate(
    executor: CommandExecutorPort,
    request: EvaluateGatePredicatesRequest,
  ): Promise<GatePredicateResult> {
    const started = this.nowMs();
    const laneDiffCheck = this.laneDiffCheckFor(executor);
    let result: LaneDiffCheckResult;
    try {
      result = await laneDiffCheck.checkLaneDiff({
        worktreePath: request.worktreePath,
        baseCommit: request.baseCommit,
        allowedPathPrefixes: request.allowedPathPrefixes,
      });
    } catch {
      return this.diffUnknown(started, 'diff check threw');
    }
    if (result.outcome === 'clean') {
      return {
        name: 'diff-check',
        kind: 'diff-check',
        verdict: 'pass',
        exitCode: null,
        durationMs: this.nowMs() - started,
        detail: 'clean',
      };
    }
    if (result.outcome === 'findings') {
      const joined = result.findings
        .slice(0, 10)
        .map(
          (finding) =>
            finding.path + (finding.line === undefined ? '' : ':' + finding.line) + ' ' + finding.rule,
        )
        .join('; ');
      return {
        name: 'diff-check',
        kind: 'diff-check',
        verdict: 'fail',
        exitCode: null,
        durationMs: this.nowMs() - started,
        detail: result.findings.length + ' finding(s): ' + joined,
      };
    }
    return this.diffUnknown(started, 'diff check error: ' + result.reason);
  }

  private async runCommand(
    executor: CommandExecutorPort,
    worktreePath: string,
    command: GateCommand,
    index: number,
    gateSlot: GateSlotConfiguration | undefined,
  ): Promise<GatePredicateResult> {
    const started = this.nowMs();
    const name = commandName(command, index);
    // KF-30b: with a declared gate slot the command is prefixed so it takes
    // one of the host-wide flock slots through the trusted, host-installed
    // wrapper — never the worktree's own `bin/gate-slot`. The slot wait may
    // use at most a third of the command budget, capped at 600 s and never
    // below 1 s.
    const waitSeconds = Math.max(
      1,
      Math.min(
        GATE_SLOT_MAX_WAIT_SECONDS,
        Math.floor(this.commandTimeoutMs / GATE_SLOT_WAIT_DIVISOR_MS),
      ),
    );
    const argv = [
      'sh',
      '-c',
      'cd -- "$1" && shift && exec "$@"',
      'fleet-gate',
      worktreePath,
      ...(gateSlot === undefined
        ? []
        : [
            '/usr/bin/env',
            'FLEET_V2_GATE_SLOTS=' + String(readGateSlotCapacity(gateSlot.slots)),
            'FLEET_V2_GATE_WAIT_MAX_SECONDS=' + String(waitSeconds),
            gateSlot.path,
          ]),
      ...command.argv,
    ];
    let run: CommandRunResult;
    try {
      run = await executor.run(argv, {
        cwd: worktreePath,
        timeoutMs: this.commandTimeoutMs,
        maxBufferBytes: this.maxOutputBytes,
      });
    } catch {
      return {
        name,
        kind: 'command',
        verdict: 'unknown',
        exitCode: null,
        durationMs: this.nowMs() - started,
        detail: 'command did not complete',
      };
    }

    // KF-30b: with a declared gate slot, exit 75 whose LAST stderr line (after
    // one trailing newline) is the fixed `gate-slot` line is host congestion,
    // not the command's own verdict — earlier stderr lines (ssh warnings) do
    // not matter. A congestion `unknown` verdict parks the run `ambiguous` at
    // the gate, fail closed and visible to the owner; automatic wait-and-retry
    // is a separate unit (KF-30c). Without a declared gate slot, exit 75 is
    // the command's own result. Any other exit 75 stays the command's result.
    if (
      gateSlot !== undefined &&
      run.exitCode === GATE_SLOT_EXIT_CODE &&
      lastStderrLine(run.stderr) === GATE_SLOT_WAIT_LIMIT_LINE
    ) {
      return {
        name,
        kind: 'command',
        verdict: 'unknown',
        exitCode: run.exitCode,
        durationMs: this.nowMs() - started,
        detail: 'gate slot wait limit reached',
        cause: 'gate-slot-wait-limit',
      };
    }

    const raw = rawVerdict(run, this.isRemote(executor));
    if (command.coverage === undefined) {
      return {
        name,
        kind: 'command',
        verdict: mapVerdict(raw),
        exitCode: run.exitCode,
        durationMs: this.nowMs() - started,
        detail: detailForCommand(run, command, undefined),
      };
    }

    const output = [run.stdout, run.stderr].filter((part) => part.trim() !== '').join('\n');
    const read = readCheckCoverage(command.coverage.reader, output);
    const coverage: CheckCoverage = isCheckCoverage(read)
      ? read
      : { ran: false, reason: 'coverage reader returned a malformed value' };
    const verdict = applyCoverage(raw, coverage, {
      unitKind: command.coverage.unitKind,
      minUnits: command.coverage.minUnits,
    });
    return {
      name,
      kind: 'command',
      verdict: mapVerdict(verdict),
      exitCode: run.exitCode,
      durationMs: this.nowMs() - started,
      detail: detailForCommand(run, command, coverage),
      coverage,
    };
  }
}
