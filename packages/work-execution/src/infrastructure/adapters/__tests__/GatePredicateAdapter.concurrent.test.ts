// GatePredicateAdapter concurrency tests — KS3: predicates run concurrently under the slot budget.
/**
 * A fake executor records the peak number of commands running at once, so the
 * slot budget is checked against what the executor really saw. Receipt reuse
 * is checked with KS2's key over the real GateReceiptReuseAdapter.
 */

import { describe, expect, it } from 'vitest';

import { GatePredicateAdapter, boundedCoverage } from '../GatePredicateAdapter.adapter.js';
import type { GatePredicateAdapterOptions } from '../GatePredicateAdapter.adapter.js';
import { GateReceiptReuseAdapter, InMemoryGateReceiptRecordStore } from '../GateReceiptReuseAdapter.adapter.js';
import type { GateReceiptRecordStore } from '../GateReceiptReuseAdapter.adapter.js';
import type {
  EvaluateGatePredicatesRequest,
  EvaluateGatePredicatesResult,
} from '../../../application/ports/out/GatePredicatePort.out-port.js';
import type {
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
} from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import type { LaneDiffCheckPort, LaneDiffCheckResult } from '../../../application/ports/out/LaneDiffCheckPort.out-port.js';
import type { RunnerForAttemptHostSpec } from '../ConfirmRecordedHost.js';
import { MAX_GATE_ARGV_ENTRIES, MAX_GATE_ARG_CHARACTERS, MAX_GATE_COMMANDS, gateCommandPredicateName } from '../../../domain/value-objects/AcceptanceSpec.vo.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
const WORKTREE = '/lanes/w1';
const GATE_SLOT_PATH = '/usr/local/bin/gate-slot';

function hostWith(slots: number | undefined): RunnerForAttemptHostSpec {
  return {
    transport: 'local',
    runner: {
      kind: 'opencode',
      port: 4096,
      ...(slots === undefined ? {} : { gateSlot: { path: GATE_SLOT_PATH, slots } }),
    },
  };
}

function requestWith(names: readonly string[], worktree: string = WORKTREE): EvaluateGatePredicatesRequest {
  return {
    attemptId: 'attempt-1',
    worktreePath: worktree,
    runner: null,
    baseCommit: BASE,
    candidateHeadSha: HEAD,
    allowedPathPrefixes: ['src'],
    spec: { commitRequired: true, diffCheck: true, commands: names.map((name) => ({ argv: [name] })) },
  };
}

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The command a wrapped argv runs: the entry after the worktree path (and the gate-slot prefix). */
function commandOf(argv: readonly string[]): string {
  const at = argv.indexOf('fleet-gate');
  const rest = argv.slice(at + 2);
  const slotAt = rest.indexOf(GATE_SLOT_PATH);
  return rest[slotAt === -1 ? 0 : slotAt + 1] ?? '';
}

interface Behaviour {
  readonly delayMs?: number;
  readonly result?: Partial<CommandRunResult>;
  readonly throws?: boolean;
}

class RecordingExecutor implements CommandExecutorPort {
  active = 0;
  peak = 0;
  readonly started: string[] = [];
  readonly finished: string[] = [];
  readonly options: CommandRunOptions[] = [];
  gitThrows = false;
  treeHash: string = TREE;

  constructor(private readonly behaviours: Readonly<Record<string, Behaviour>> = {}) {}

  get commandRuns(): number {
    return this.started.length;
  }

  async run(argv: readonly string[], options?: CommandRunOptions): Promise<CommandRunResult> {
    if (argv[0] === 'git') {
      if (this.gitThrows) {
        throw new Error('git transport crashed');
      }
      return this.git(argv);
    }
    const name = commandOf(argv);
    const behaviour = this.behaviours[name] ?? {};
    this.started.push(name);
    if (options !== undefined) {
      this.options.push(options);
    }
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    try {
      await tick(behaviour.delayMs ?? 3);
      if (behaviour.throws === true) {
        throw new Error('executor died');
      }
      return { exitCode: 0, signal: null, stdout: '', stderr: '', ...behaviour.result };
    } finally {
      this.active -= 1;
      this.finished.push(name);
    }
  }

  private git(argv: readonly string[]): CommandRunResult {
    const ok = (stdout: string): CommandRunResult => ({ exitCode: 0, signal: null, stdout, stderr: '' });
    if (argv.includes('--verify')) {
      return ok(this.treeHash + '\n');
    }
    if (argv.includes('rev-parse')) {
      return ok(HEAD + '\n');
    }
    if (argv.includes('rev-list')) {
      return ok('2\n');
    }
    return ok('');
  }
}

class CleanDiff implements LaneDiffCheckPort {
  constructor(private readonly result: LaneDiffCheckResult = { outcome: 'clean' }) {}
  async checkLaneDiff(): Promise<LaneDiffCheckResult> {
    return this.result;
  }
}

function makeAdapter(
  executor: CommandExecutorPort,
  slots: number | undefined,
  options: Partial<GatePredicateAdapterOptions> = {},
  diff: LaneDiffCheckPort = new CleanDiff(),
): GatePredicateAdapter {
  return new GatePredicateAdapter({
    executorForRecordedHost: () => ({ ok: true, executor, hostSpec: hostWith(slots) }),
    laneDiffCheckFor: () => diff,
    ...options,
  });
}

function evaluated(result: EvaluateGatePredicatesResult) {
  expect(result.outcome).toBe('evaluated');
  if (result.outcome !== 'evaluated') {
    throw new Error('expected evaluated');
  }
  return result.results;
}

describe('GatePredicateAdapter concurrency (KS3)', () => {
  it('runs commands concurrently and never exceeds the declared slot count', async () => {
    const executor = new RecordingExecutor();
    const adapter = makeAdapter(executor, 3);
    const results = evaluated(await adapter.evaluateGatePredicates(requestWith(['a', 'b', 'c', 'd', 'e', 'f'])));
    expect(executor.peak).toBe(3);
    expect(executor.commandRuns).toBe(6);
    expect(results.slice(2).map((result) => result.verdict)).toEqual(Array(6).fill('pass'));
  });

  it('keeps concurrent lanes inside one shared budget', async () => {
    const executor = new RecordingExecutor();
    const adapter = makeAdapter(executor, 2);
    const lanes = await Promise.all(
      ['l1', 'l2', 'l3'].map((lane) =>
        adapter.evaluateGatePredicates(requestWith([lane + 'a', lane + 'b', lane + 'c'], '/lanes/' + lane)),
      ),
    );
    expect(executor.peak).toBeLessThanOrEqual(2);
    expect(executor.peak).toBe(2);
    expect(executor.commandRuns).toBe(9);
    for (const lane of lanes) {
      expect(evaluated(lane).every((result) => result.verdict === 'pass')).toBe(true);
    }
  });

  it('counts the git predicates in the budget too', async () => {
    const executor = new RecordingExecutor();
    // A one-slot host that allows nothing beside a running command, even another lane's git reads.
    const adapter = makeAdapter(executor, 1);
    await Promise.all([
      adapter.evaluateGatePredicates(requestWith(['a'], '/lanes/x')),
      adapter.evaluateGatePredicates(requestWith(['b'], '/lanes/y')),
    ]);
    expect(executor.peak).toBe(1);
  });

  it('caps at the adapter option when it is below the declared slots', async () => {
    const executor = new RecordingExecutor();
    const adapter = makeAdapter(executor, 8, { maxConcurrentPredicates: 2 });
    await adapter.evaluateGatePredicates(requestWith(['a', 'b', 'c', 'd', 'e']));
    expect(executor.peak).toBe(2);
  });

  it('shares one budget per host when requests declare different slot counts', async () => {
    const executor = new RecordingExecutor({ a: { delayMs: 15 } });
    let slots = 2;
    const adapter = new GatePredicateAdapter({
      executorForRecordedHost: () => ({
        ok: true,
        executor,
        hostSpec: { transport: 'local', runner: { kind: 'opencode', gateSlot: { path: GATE_SLOT_PATH, slots } } },
      }),
      laneDiffCheckFor: () => new CleanDiff(),
    });
    const first = adapter.evaluateGatePredicates(requestWith(['a1', 'a2', 'a3', 'a4'], '/lanes/p'));
    await tick(2);
    slots = 3;
    const second = adapter.evaluateGatePredicates(requestWith(['b1', 'b2', 'b3', 'b4'], '/lanes/q'));
    await Promise.all([first, second]);
    expect(executor.peak).toBeLessThanOrEqual(2);
    // Idle again, the declared count is taken as it stands.
    slots = 3;
    await adapter.evaluateGatePredicates(requestWith(['c1', 'c2', 'c3', 'c4'], '/lanes/r'));
    expect(executor.peak).toBe(3);
  });

  it('refuses an empty spec and arguments beyond the acceptance spec limits', async () => {
    const executor = new RecordingExecutor();
    const adapter = makeAdapter(executor, 2);
    const withCommands = (commands: unknown): EvaluateGatePredicatesRequest =>
      ({ ...requestWith(['x']), spec: { commitRequired: true, diffCheck: true, commands } }) as never;
    for (const commands of [[], [{ argv: ['a'.repeat(MAX_GATE_ARG_CHARACTERS + 1)] }], [{ argv: ['a\0b'] }]]) {
      expect((await adapter.evaluateGatePredicates(withCommands(commands))).outcome).toBe('unavailable');
    }
    expect(executor.commandRuns).toBe(0);
  });

  it('withholds a secret-shaped coverage reason from the result', async () => {
    const secretShaped = ['ghp', '_', 'a'.repeat(24)].join('');
    const executor = new RecordingExecutor({ a: { result: { stdout: secretShaped } } });
    const adapter = makeAdapter(executor, 2);
    const request: EvaluateGatePredicatesRequest = {
      ...requestWith(['a']),
      spec: {
        commitRequired: true,
        diffCheck: true,
        commands: [{ argv: ['a'], coverage: { reader: 'vitest-summary', unitKind: 'tests', minUnits: 1 } }],
      },
    };
    const results = evaluated(await adapter.evaluateGatePredicates(request));
    expect(JSON.stringify(results)).not.toContain(secretShaped);
  });

  it('withholds a long or secret-shaped coverage reason whole instead of echoing a prefix', () => {
    const secretShaped = ['ghp', '_', 'a'.repeat(24)].join('');
    const long = boundedCoverage({ ran: false, reason: 'r'.repeat(400) });
    expect(long).toEqual({ ran: false, reason: 'coverage reason withheld: too long' });
    expect(boundedCoverage({ ran: false, reason: 'leak ' + secretShaped })).toEqual({
      ran: false,
      reason: 'detail withheld: secret-shaped text',
    });
    const fine = { ran: false as const, reason: 'no summary line' };
    expect(boundedCoverage(fine)).toBe(fine);
    const ran = { ran: true as const, unitKind: 'tests' as const, units: 3 };
    expect(boundedCoverage(ran)).toBe(ran);
  });

  it('keys the budget by the recorded host alias when no host name is recorded', async () => {
    const executor = new RecordingExecutor({ a: { delayMs: 10 } });
    const adapter = makeAdapter(executor, 1);
    const runner = (host: string) =>
      ({ kind: 'opencode', remotePort: 4096, host, hostName: null }) as unknown as EvaluateGatePredicatesRequest['runner'];
    await Promise.all([
      adapter.evaluateGatePredicates({ ...requestWith(['a1'], '/lanes/h1'), runner: runner('host-one') }),
      adapter.evaluateGatePredicates({ ...requestWith(['a2'], '/lanes/h2'), runner: runner('host-two') }),
    ]);
    // Two hosts, one slot each: they may overlap; one host's two requests may not.
    expect(executor.peak).toBe(2);
    const same = new RecordingExecutor({ a: { delayMs: 10 } });
    const sameAdapter = makeAdapter(same, 1);
    await Promise.all([
      sameAdapter.evaluateGatePredicates({ ...requestWith(['a1'], '/lanes/h1'), runner: runner('host-one') }),
      sameAdapter.evaluateGatePredicates({ ...requestWith(['a2'], '/lanes/h2'), runner: runner('host-one') }),
    ]);
    expect(same.peak).toBe(1);
  });

  it('refuses a request with more commands or arguments than an acceptance spec allows', async () => {
    const executor = new RecordingExecutor();
    const adapter = makeAdapter(executor, 4);
    const tooMany = requestWith(Array.from({ length: MAX_GATE_COMMANDS + 1 }, (_, index) => 'c' + String(index)));
    expect((await adapter.evaluateGatePredicates(tooMany)).outcome).toBe('unavailable');
    const tooLong: EvaluateGatePredicatesRequest = {
      ...requestWith(['x']),
      spec: {
        commitRequired: true,
        diffCheck: true,
        commands: [{ argv: Array.from({ length: MAX_GATE_ARGV_ENTRIES + 1 }, () => 'a') }],
      },
    };
    expect((await adapter.evaluateGatePredicates(tooLong)).outcome).toBe('unavailable');
    const atLimit = requestWith(Array.from({ length: MAX_GATE_COMMANDS }, (_, index) => 'c' + String(index)));
    expect((await adapter.evaluateGatePredicates(atLimit)).outcome).toBe('evaluated');
    expect(executor.peak).toBeLessThanOrEqual(4);
  });

  it('treats an invalid declared slot count as one slot, never more', async () => {
    for (const slots of [0, -3, Number.NaN, 1.5, 9999]) {
      const executor = new RecordingExecutor();
      const adapter = makeAdapter(executor, slots);
      await adapter.evaluateGatePredicates(requestWith(['a', 'b', 'c']));
      expect(executor.peak).toBe(1);
    }
  });

  it('runs sequentially and skips after the first non-pass when no slot is declared', async () => {
    const executor = new RecordingExecutor({ a: { result: { exitCode: 1 } } });
    const adapter = makeAdapter(executor, undefined);
    const results = evaluated(await adapter.evaluateGatePredicates(requestWith(['a', 'b', 'c'])));
    expect(executor.peak).toBe(1);
    expect(executor.started).toEqual(['a']);
    expect(results.slice(2).map((result) => result.verdict)).toEqual(['fail', 'skipped', 'skipped']);
  });

  it('reports results in declared order whatever order they finished in', async () => {
    const executor = new RecordingExecutor({ a: { delayMs: 30 }, b: { delayMs: 15 }, c: { delayMs: 1 } });
    const adapter = makeAdapter(executor, 3);
    const results = evaluated(await adapter.evaluateGatePredicates(requestWith(['a', 'b', 'c'])));
    expect(executor.finished).toEqual(['c', 'b', 'a']);
    expect(results.map((result) => result.name)).toEqual([
      'commit',
      'diff-check',
      'command 1: a',
      'command 2: b',
      'command 3: c',
    ]);
  });

  it('records each predicate as it really ended: a failure or timeout cancels and mislabels none', async () => {
    const executor = new RecordingExecutor({
      a: { result: { exitCode: 1 } },
      b: { result: { exitCode: null, error: 'timed out' } },
      c: { delayMs: 20 },
      d: { throws: true },
    });
    const adapter = makeAdapter(executor, 4);
    const results = evaluated(await adapter.evaluateGatePredicates(requestWith(['a', 'b', 'c', 'd'])));
    expect(executor.started.slice().sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(results.slice(2).map((result) => [result.name, result.verdict])).toEqual([
      ['command 1: a', 'fail'],
      ['command 2: b', 'unknown'],
      ['command 3: c', 'pass'],
      ['command 4: d', 'unknown'],
    ]);
    expect(results[5]).toMatchObject({ detail: 'command did not complete', exitCode: null });
  });

  it('does not run a command after a failed diff check, however many slots there are', async () => {
    const executor = new RecordingExecutor();
    const adapter = makeAdapter(
      executor,
      4,
      {},
      new CleanDiff({ outcome: 'findings', findings: [{ path: 'package.json', rule: 'protected-path' }] }),
    );
    const results = evaluated(await adapter.evaluateGatePredicates(requestWith(['a', 'b'])));
    expect(executor.commandRuns).toBe(0);
    expect(results.slice(1).map((result) => result.verdict)).toEqual(['fail', 'skipped', 'skipped']);
  });

  it('keeps unknown unknown: a commit predicate that could not run is never a pass and gates the commands', async () => {
    const executor = new RecordingExecutor();
    executor.gitThrows = true;
    const adapter = makeAdapter(executor, 4);
    const results = evaluated(await adapter.evaluateGatePredicates(requestWith(['a'])));
    expect(results[0]).toMatchObject({ name: 'commit', verdict: 'unknown' });
    expect(results[1]).toMatchObject({ name: 'diff-check', verdict: 'skipped' });
    expect(results[2]).toMatchObject({ verdict: 'skipped' });
    expect(executor.commandRuns).toBe(0);
  });

  it('keeps unknown unknown: a diff check that throws is unknown and gates the commands', async () => {
    const executor = new RecordingExecutor();
    const throwing: LaneDiffCheckPort = {
      checkLaneDiff: async () => {
        throw new Error('diff crashed');
      },
    };
    const adapter = makeAdapter(executor, 4, {}, throwing);
    const results = evaluated(await adapter.evaluateGatePredicates(requestWith(['a'])));
    expect(results[1]).toMatchObject({ verdict: 'unknown' });
    expect(results[2]).toMatchObject({ verdict: 'skipped' });
  });

  it('never throws for a malformed request or a failing host lookup: a typed unavailable', async () => {
    const executor = new RecordingExecutor();
    const adapter = makeAdapter(executor, 2);
    const malformed: unknown[] = [
      null,
      undefined,
      'x',
      {},
      { ...requestWith(['a']), worktreePath: '' },
      { ...requestWith(['a']), worktreePath: 7 },
      { ...requestWith(['a']), spec: null },
      { ...requestWith(['a']), spec: { commands: 'a' } },
      { ...requestWith(['a']), spec: { commands: [{ argv: 'a' }] } },
      { ...requestWith(['a']), spec: { commands: [{ argv: [] }] } },
      { ...requestWith(['a']), spec: { commands: [null] } },
      { ...requestWith(['a']), allowedPathPrefixes: undefined },
    ];
    for (const request of malformed) {
      const result = await adapter.evaluateGatePredicates(request as never);
      expect(result.outcome).toBe('unavailable');
    }
    const throwingHost = new GatePredicateAdapter({
      executorForRecordedHost: () => {
        throw new Error('host map exploded');
      },
    });
    expect(await throwingHost.evaluateGatePredicates(requestWith(['a']))).toEqual({
      outcome: 'unavailable',
      reason: 'gate predicate evaluation did not complete',
    });
    expect(executor.commandRuns).toBe(0);
  });

  it('echoes no secret-shaped text: a withheld detail replaces it', async () => {
    const secretShaped = ['ghp', '_', 'a'.repeat(24)].join('');
    const executor = new RecordingExecutor();
    const adapter = makeAdapter(
      executor,
      2,
      {},
      new CleanDiff({ outcome: 'findings', findings: [{ path: 'notes/' + secretShaped + '.txt', rule: 'protected-path' }] }),
    );
    const results = evaluated(await adapter.evaluateGatePredicates(requestWith(['a'])));
    expect(JSON.stringify(results)).not.toContain(secretShaped);
    expect(results[1]).toMatchObject({ verdict: 'fail', detail: 'detail withheld: secret-shaped text' });

    const refusing = new GatePredicateAdapter({
      executorForRecordedHost: () => ({ ok: false, reason: 'no host ' + secretShaped }),
    });
    const unavailable = await refusing.evaluateGatePredicates(requestWith(['a']));
    expect(JSON.stringify(unavailable)).not.toContain(secretShaped);
  });

  it('withholds a secret-shaped argv from the predicate name, agreeing with the use case name', async () => {
    const secretShaped = ['ghp', '_', 'a'.repeat(24)].join('');
    const argv = ['deploy', '--token', secretShaped];
    const executor = new RecordingExecutor();
    const adapter = makeAdapter(executor, 2);
    const request: EvaluateGatePredicatesRequest = {
      ...requestWith(['x']),
      spec: { commitRequired: true, diffCheck: true, commands: [{ argv }] },
    };
    const results = evaluated(await adapter.evaluateGatePredicates(request));
    expect(JSON.stringify(results)).not.toContain(secretShaped);
    expect(results[2]?.name).toBe(gateCommandPredicateName(argv, 0));
    expect(results[2]?.name).toBe('command 1: [argv withheld: secret-shaped text]');
    expect(gateCommandPredicateName(['plain', 'args'], 1)).toBe('command 2: plain args');
  });

  it('passes a normalised slot count to the gate-slot wrapper, never a raw invalid one', async () => {
    for (const [declared, expected] of [[9999, '1'], [0, '1'], [4, '4']] as const) {
      const executor = new RecordingExecutor();
      const seen: string[][] = [];
      const spying: CommandExecutorPort = {
        run: async (argv, options) => {
          seen.push([...argv]);
          return executor.run(argv, options);
        },
      };
      await makeAdapter(spying, declared).evaluateGatePredicates(requestWith(['a']));
      const wrapped = seen.find((argv) => argv.includes(GATE_SLOT_PATH));
      expect(wrapped).toContain('FLEET_V2_GATE_SLOTS=' + expected);
    }
  });

  it('bounds every detail and the output a command may capture', async () => {
    const executor = new RecordingExecutor();
    const long = 'z'.repeat(5000);
    const adapter = makeAdapter(
      executor,
      2,
      { maxOutputBytes: 1024 },
      new CleanDiff({ outcome: 'error', reason: long as never }),
    );
    const results = evaluated(await adapter.evaluateGatePredicates(requestWith(['a', 'b'])));
    expect(results[1]?.detail.length).toBeLessThanOrEqual(300);
    expect(executor.options.every((option) => option.maxBufferBytes === 1024)).toBe(true);

    const defaults = new RecordingExecutor();
    await makeAdapter(defaults, 2, { maxOutputBytes: 10 ** 12 }).evaluateGatePredicates(requestWith(['a']));
    expect(defaults.options[0]?.maxBufferBytes).toBe(16 * 1024 * 1024);
  });
});

describe('GatePredicateAdapter receipt reuse (KS2 key, KS3)', () => {
  const TOOLCHAIN = { node: '22.23.3', yarn: '4.12.0', hexagen: '1.2.3', turbo: '2.11.7' };

  function wiring(
    store: GateReceiptRecordStore,
    overrides: Partial<NonNullable<GatePredicateAdapterOptions['receiptReuse']>> = {},
  ): NonNullable<GatePredicateAdapterOptions['receiptReuse']> {
    return {
      port: new GateReceiptReuseAdapter(store),
      toolchainVersions: async () => TOOLCHAIN,
      declaredEnvironmentDigest: async () => 'e'.repeat(64),
      ...overrides,
    };
  }

  it('runs a command once and reuses its receipt for an identical input', async () => {
    const store = new InMemoryGateReceiptRecordStore();
    const executor = new RecordingExecutor();
    const adapter = makeAdapter(executor, 2, { receiptReuse: wiring(store) });
    const first = evaluated(await adapter.evaluateGatePredicates(requestWith(['a', 'b'])));
    expect(executor.commandRuns).toBe(2);
    expect(store.size).toBe(2);
    const second = evaluated(await adapter.evaluateGatePredicates(requestWith(['a', 'b'])));
    expect(executor.commandRuns).toBe(2);
    expect(second.slice(2).map((result) => [result.name, result.verdict, result.durationMs])).toEqual([
      ['command 1: a', 'pass', 0],
      ['command 2: b', 'pass', 0],
    ]);
    expect(second[2]?.detail.startsWith('reused receipt: ')).toBe(true);
    expect(first[2]?.detail).toBe('exit 0');
  });

  it('recovers after a crash: finished predicates are not run again, the rest are', async () => {
    const store = new InMemoryGateReceiptRecordStore();
    const crashing = new RecordingExecutor({ b: { throws: true } });
    const before = makeAdapter(crashing, 1, { receiptReuse: wiring(store) });
    const crashed = evaluated(await before.evaluateGatePredicates(requestWith(['a', 'b'])));
    expect(crashed.slice(2).map((result) => result.verdict)).toEqual(['pass', 'unknown']);
    // A fresh adapter over the same store stands for the restarted process.
    const healthy = new RecordingExecutor();
    const after = makeAdapter(healthy, 1, { receiptReuse: wiring(store) });
    const recovered = evaluated(await after.evaluateGatePredicates(requestWith(['a', 'b'])));
    expect(healthy.started).toEqual(['b']);
    expect(recovered.slice(2).map((result) => result.verdict)).toEqual(['pass', 'pass']);
  });

  it('does not reuse across a changed tree, definition, toolchain or declared environment', async () => {
    const store = new InMemoryGateReceiptRecordStore();
    const baseline = new RecordingExecutor();
    await makeAdapter(baseline, 2, { receiptReuse: wiring(store) }).evaluateGatePredicates(requestWith(['a']));

    const changedTree = new RecordingExecutor();
    changedTree.treeHash = 'd'.repeat(40);
    await makeAdapter(changedTree, 2, { receiptReuse: wiring(store) }).evaluateGatePredicates(requestWith(['a']));
    expect(changedTree.commandRuns).toBe(1);

    const changedScript = new RecordingExecutor();
    const otherArgv: EvaluateGatePredicatesRequest = {
      ...requestWith(['a']),
      spec: { commitRequired: true, diffCheck: true, commands: [{ argv: ['a', '--changed'] }] },
    };
    await makeAdapter(changedScript, 2, { receiptReuse: wiring(store) }).evaluateGatePredicates(otherArgv);
    expect(changedScript.started).toHaveLength(1);

    const changedToolchain = new RecordingExecutor();
    await makeAdapter(changedToolchain, 2, {
      receiptReuse: wiring(store, { toolchainVersions: async () => ({ ...TOOLCHAIN, node: '24.0.0' }) }),
    }).evaluateGatePredicates(requestWith(['a']));
    expect(changedToolchain.commandRuns).toBe(1);

    const changedEnv = new RecordingExecutor();
    await makeAdapter(changedEnv, 2, {
      receiptReuse: wiring(store, { declaredEnvironmentDigest: async () => '9'.repeat(64) }),
    }).evaluateGatePredicates(requestWith(['a']));
    expect(changedEnv.commandRuns).toBe(1);
  });

  it('treats an unreadable component or a throwing provider as a miss, never a reuse and never a throw', async () => {
    const store = new InMemoryGateReceiptRecordStore();
    await makeAdapter(new RecordingExecutor(), 2, { receiptReuse: wiring(store) }).evaluateGatePredicates(
      requestWith(['a']),
    );
    const variants: Array<Partial<NonNullable<GatePredicateAdapterOptions['receiptReuse']>>> = [
      { toolchainVersions: async () => 'junk' },
      { toolchainVersions: async () => ({ node: '1' }) },
      {
        toolchainVersions: async () => {
          throw new Error('no node');
        },
      },
      { declaredEnvironmentDigest: async () => 'not-a-digest' },
      {
        declaredEnvironmentDigest: async () => {
          throw new Error('no env');
        },
      },
    ];
    for (const variant of variants) {
      const executor = new RecordingExecutor();
      const results = evaluated(
        await makeAdapter(executor, 2, { receiptReuse: wiring(store, variant) }).evaluateGatePredicates(
          requestWith(['a']),
        ),
      );
      expect(executor.commandRuns).toBe(1);
      expect(results[2]).toMatchObject({ verdict: 'pass', detail: 'exit 0' });
    }
    const noTree = new RecordingExecutor();
    noTree.treeHash = 'not a tree';
    await makeAdapter(noTree, 2, { receiptReuse: wiring(store) }).evaluateGatePredicates(requestWith(['a']));
    expect(noTree.commandRuns).toBe(1);
  });

  it('reuses a receipt for a coverage-declaring command only when the stored coverage meets the declaration', async () => {
    const store = new InMemoryGateReceiptRecordStore();
    const request = (minUnits: number): EvaluateGatePredicatesRequest => ({
      ...requestWith(['a']),
      spec: {
        commitRequired: true,
        diffCheck: true,
        commands: [{ argv: ['a'], coverage: { reader: 'vitest-summary', unitKind: 'tests', minUnits } }],
      },
    });
    const summary = { stdout: ' Tests  7 passed (7)\n' };
    const first = new RecordingExecutor({ a: { result: summary } });
    const ran = evaluated(
      await makeAdapter(first, 2, { receiptReuse: wiring(store) }).evaluateGatePredicates(request(5)),
    );
    expect(ran[2]).toMatchObject({ verdict: 'pass' });
    expect(store.size).toBe(1);
    // The same declaration reuses the receipt.
    const second = new RecordingExecutor({ a: { result: summary } });
    await makeAdapter(second, 2, { receiptReuse: wiring(store) }).evaluateGatePredicates(request(5));
    expect(second.commandRuns).toBe(0);
  });

  it('never records or reuses a command that did not pass', async () => {
    const store = new InMemoryGateReceiptRecordStore();
    const failing = new RecordingExecutor({ a: { result: { exitCode: 1 } }, b: { result: { exitCode: null, error: 'timed out' } } });
    await makeAdapter(failing, 2, { receiptReuse: wiring(store) }).evaluateGatePredicates(requestWith(['a', 'b']));
    expect(store.size).toBe(0);
    const again = new RecordingExecutor({ a: { result: { exitCode: 1 } }, b: { result: { exitCode: null, error: 'timed out' } } });
    const results = evaluated(
      await makeAdapter(again, 2, { receiptReuse: wiring(store) }).evaluateGatePredicates(requestWith(['a', 'b'])),
    );
    expect(again.commandRuns).toBe(2);
    expect(results.slice(2).map((result) => result.verdict)).toEqual(['fail', 'unknown']);
  });

  it('runs an identical predicate once across concurrent lanes and records it once', async () => {
    const store = new InMemoryGateReceiptRecordStore();
    const executor = new RecordingExecutor({ a: { delayMs: 25 } });
    const adapter = makeAdapter(executor, 4, { receiptReuse: wiring(store) });
    const lanes = await Promise.all([
      adapter.evaluateGatePredicates(requestWith(['a'])),
      adapter.evaluateGatePredicates(requestWith(['a'])),
      adapter.evaluateGatePredicates(requestWith(['a'])),
    ]);
    expect(executor.started).toEqual(['a']);
    expect(store.size).toBe(1);
    for (const lane of lanes) {
      expect(evaluated(lane)[2]).toMatchObject({ verdict: 'pass', name: 'command 1: a' });
    }
  });

  it('lets a waiting lane run its own command when the shared run did not pass', async () => {
    const store = new InMemoryGateReceiptRecordStore();
    const executor = new RecordingExecutor({ a: { delayMs: 15, result: { exitCode: null, error: 'timed out' } } });
    const adapter = makeAdapter(executor, 4, { receiptReuse: wiring(store) });
    const lanes = await Promise.all([
      adapter.evaluateGatePredicates(requestWith(['a'])),
      adapter.evaluateGatePredicates(requestWith(['a'])),
    ]);
    expect(executor.commandRuns).toBe(2);
    for (const lane of lanes) {
      expect(evaluated(lane)[2]).toMatchObject({ verdict: 'unknown' });
    }
    expect(store.size).toBe(0);
  });

  it('still returns the result when the receipt store fails', async () => {
    const broken: GateReceiptRecordStore = {
      get: async () => {
        throw new Error('disk gone');
      },
      putIfAbsent: async () => {
        throw new Error('disk gone');
      },
    };
    const executor = new RecordingExecutor();
    const results = evaluated(
      await makeAdapter(executor, 2, { receiptReuse: wiring(broken) }).evaluateGatePredicates(requestWith(['a'])),
    );
    expect(executor.commandRuns).toBe(1);
    expect(results[2]).toMatchObject({ verdict: 'pass' });
  });

  it('never exceeds the slot budget while reading receipt inputs and running commands together', async () => {
    const executor = new RecordingExecutor();
    const adapter = makeAdapter(executor, 2, { receiptReuse: wiring(new InMemoryGateReceiptRecordStore()) });
    await Promise.all(
      ['x', 'y', 'z'].map((lane) =>
        adapter.evaluateGatePredicates(requestWith([lane + '1', lane + '2'], '/lanes/' + lane)),
      ),
    );
    expect(executor.peak).toBeLessThanOrEqual(2);
  });
});
