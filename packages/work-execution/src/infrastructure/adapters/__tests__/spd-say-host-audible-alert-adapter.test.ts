/**
 * SpdSayHostAudibleAlertAdapter tests (lane CO-WD8): the sentence is untrusted
 * input, validated (length and fixed character set) before anything spawns;
 * the binary resolves from fixed absolute candidates; the sentence reaches the
 * child as ONE argv element of a fixed command with no shell and no PATH
 * lookup; the child sees only the allow-listed environment plus a validated
 * `XDG_RUNTIME_DIR`; and every spawn outcome maps onto the port's result
 * without echoing stdout or stderr. Subprocess tests run the REAL
 * `runSpawnOutcome` against a real `/bin/sh` script in a fresh temp directory.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TRAIN_HEALTH_ANNOUNCEMENT_FALLBACK_SENTENCE } from '../../../domain/train-health-announcements.js';
import {
  SPD_SAY_BINARY_CANDIDATES,
  SPD_SAY_MAX_CANDIDATES,
  SPD_SAY_TIMEOUT_MS,
  SpdSayHostAudibleAlertAdapter,
  parseHostAudibleAlertRequest,
  validateHostAudibleAlertSentence,
} from '../SpdSayHostAudibleAlertAdapter.adapter.js';
import type { SpawnRunOutcome } from '../spawn-run.js';
import type { SpdSayHostAudibleAlertAdapterOptions } from '../SpdSayHostAudibleAlertAdapter.adapter.js';

const REFUSED = { outcome: 'refused', reasonCode: 'invalid-request' };
const INVALID = { ok: false, reasonCode: 'invalid-request' };
const UNAVAILABLE = { outcome: 'unavailable', reasonCode: 'binary-missing' };

let workDir: string;
let scriptPath: string;
let seenPath: string;

/** Write the probe script: it records its argument count, arguments and the
 * two watched environment variables, then exits with the given code. */
function writeProbeScript(exitCode: number, noise: boolean, delaySeconds: number): string {
  const target = path.join(workDir, `probe-${Math.random().toString(36).slice(2)}.sh`);
  const lines = [
    '#!/bin/sh',
    'printf \'%s\\n\' "$#" >> "$(dirname "$0")/seen.txt"',
    'printf \'%s\\n\' "$@" >> "$(dirname "$0")/seen.txt"',
    'printf \'%s\\n\' "${XDG_RUNTIME_DIR-unset}" >> "$(dirname "$0")/seen.txt"',
    'printf \'%s\\n\' "${FLEET_TEST_MARKER-unset}" >> "$(dirname "$0")/seen.txt"',
  ];
  if (noise) {
    lines.push("printf 'noise\\n'", "printf 'noise\\n' >&2");
  }
  if (delaySeconds > 0) {
    lines.push(`sleep ${String(delaySeconds)}`);
  }
  lines.push(`exit ${String(exitCode)}`);
  writeFileSync(target, `${lines.join('\n')}\n`, { mode: 0o755 });
  return target;
}

function seenLines(): string[] {
  return readFileSync(seenPath, 'utf8').split('\n').filter((line) => line.length > 0);
}

function adapterWith(extra: Partial<SpdSayHostAudibleAlertAdapterOptions> = {}): SpdSayHostAudibleAlertAdapter {
  return new SpdSayHostAudibleAlertAdapter({ candidates: [scriptPath], ...extra });
}

function fakeRun(answer: unknown): { run: () => Promise<SpawnRunOutcome>; calls: () => number } {
  let calls = 0;
  return {
    run: async () => {
      calls += 1;
      return answer as SpawnRunOutcome;
    },
    calls: () => calls,
  };
}

function getterCounts(source: object, key: string): { calls: () => number } {
  let calls = 0;
  Object.defineProperty(source, key, {
    enumerable: true,
    configurable: true,
    get() {
      calls += 1;
      return 'got';
    },
  });
  return { calls: () => calls };
}

beforeEach(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'spd-say-adapter-'));
  seenPath = path.join(workDir, 'seen.txt');
  scriptPath = writeProbeScript(0, false, 0);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('validateHostAudibleAlertSentence', () => {
  it('accepts the fallback sentence, a full 120-character sentence, and allowed punctuation', () => {
    expect(validateHostAudibleAlertSentence(TRAIN_HEALTH_ANNOUNCEMENT_FALLBACK_SENTENCE)).toEqual({
      ok: true,
      sentence: TRAIN_HEALTH_ANNOUNCEMENT_FALLBACK_SENTENCE,
    });
    const full = 'a b,c-d\'e#f '.repeat(10); // 120 characters, fixed set only
    expect(full.length).toBe(120);
    expect(validateHostAudibleAlertSentence(full)).toEqual({ ok: true, sentence: full });
    expect(
      validateHostAudibleAlertSentence("Pull request #42, stalled-head's check."),
    ).toEqual({ ok: true, sentence: "Pull request #42, stalled-head's check." });
  });

  it('refuses a non-string sentence', () => {
    for (const bad of [123, null, undefined, {}, [], true]) {
      expect(validateHostAudibleAlertSentence(bad)).toEqual(INVALID);
    }
  });

  it('refuses an empty or whitespace-only sentence', () => {
    expect(validateHostAudibleAlertSentence('')).toEqual(INVALID);
    expect(validateHostAudibleAlertSentence('   ')).toEqual(INVALID);
  });

  it('refuses a sentence longer than 120 characters', () => {
    expect(validateHostAudibleAlertSentence('a'.repeat(121))).toEqual(INVALID);
    expect(validateHostAudibleAlertSentence('a'.repeat(1000))).toEqual(INVALID);
  });

  it('refuses control characters and newlines', () => {
    for (const bad of ['a\nb', 'a\rb', 'a\tb', 'a\x00b', 'a\x1bb', 'a\x7fb']) {
      expect(validateHostAudibleAlertSentence(bad)).toEqual(INVALID);
    }
  });

  it('refuses characters outside the fixed set', () => {
    for (const bad of ['a/b', 'a=b', 'a$b', 'a`b', 'a;b', 'aéb']) {
      expect(validateHostAudibleAlertSentence(bad)).toEqual(INVALID);
    }
  });

  it('refuses a sentence whose first character is a hyphen (option injection)', () => {
    for (const bad of ['-h', '-C', '--help', '-e x']) {
      expect(validateHostAudibleAlertSentence(bad)).toEqual(INVALID);
    }
  });

  it('accepts a sentence with a hyphen that is not the first character', () => {
    expect(validateHostAudibleAlertSentence('all-clear')).toEqual({ ok: true, sentence: 'all-clear' });
  });
});

describe('parseHostAudibleAlertRequest', () => {
  it('parses a plain request and delegates sentence validation', () => {
    expect(parseHostAudibleAlertRequest({ sentence: 'all clear' })).toEqual({ ok: true, sentence: 'all clear' });
    expect(parseHostAudibleAlertRequest({ sentence: 'a\nb' })).toEqual(INVALID);
  });

  it('refuses non-objects, null and arrays', () => {
    for (const bad of [null, undefined, 42, 'text', [], true]) {
      expect(parseHostAudibleAlertRequest(bad)).toEqual(INVALID);
    }
  });

  it('refuses an object with a prototype-polluting own key', () => {
    const hostile: Record<string, unknown> = JSON.parse('{"__proto__": {}, "sentence": "all clear"}');
    expect(parseHostAudibleAlertRequest(hostile)).toEqual(INVALID);
    expect(
      parseHostAudibleAlertRequest(JSON.parse('{"constructor": 1, "sentence": "all clear"}')),
    ).toEqual(INVALID);
    expect(
      parseHostAudibleAlertRequest(JSON.parse('{"prototype": 1, "sentence": "all clear"}')),
    ).toEqual(INVALID);
  });

  it('reads the sentence through its own descriptor so the getter never runs', () => {
    const request: Record<string, unknown> = {};
    let calls = 0;
    Object.defineProperty(request, 'sentence', {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        return 'all clear';
      },
    });
    expect(parseHostAudibleAlertRequest(request)).toEqual(INVALID);
    expect(calls).toBe(0);
  });

  it('refuses a Proxy over a valid request without running the get trap', () => {
    const valid = { sentence: 'all clear' };
    let getTraps = 0;
    const hostile = new Proxy(valid, {
      get() {
        getTraps += 1;
        return undefined;
      },
    });
    expect(parseHostAudibleAlertRequest(hostile)).toEqual(INVALID);
    expect(getTraps).toBe(0);
  });
});

describe('SpdSayHostAudibleAlertAdapter.speak refusals', () => {
  it('refuses malformed or hostile input with zero isExecutable and zero spawn calls', async () => {
    let probes = 0;
    let spawns = 0;
    const adapter = adapterWith({
      isExecutable: () => {
        probes += 1;
        return true;
      },
      run: async () => {
        spawns += 1;
        return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      },
    });
    for (const bad of [
      null,
      undefined,
      42,
      'text',
      [],
      { sentence: 123 },
      { sentence: null },
      { sentence: undefined },
      { sentence: {} },
      { sentence: '' },
      { sentence: '   ' },
      { sentence: 'a'.repeat(121) },
      { sentence: 'a\nb' },
      { sentence: 'a\rb' },
      { sentence: 'a\tb' },
      { sentence: 'a\x00b' },
      { sentence: 'a\x1bb' },
      { sentence: 'a/b' },
      { sentence: 'a=b' },
      { sentence: 'a$b' },
      JSON.parse('{"__proto__": {}, "sentence": "all clear"}'),
    ]) {
      expect(await adapter.speak(bad)).toEqual(REFUSED);
    }
    expect(probes).toBe(0);
    expect(spawns).toBe(0);
  });

  it('refuses a hostile request without running its sentence getter', async () => {
    const request: Record<string, unknown> = {};
    let calls = 0;
    Object.defineProperty(request, 'sentence', {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        return 'all clear';
      },
    });
    expect(await adapterWith().speak(request)).toEqual(REFUSED);
    expect(calls).toBe(0);
  });

  it('refuses a Proxy over a valid request without spawning or running the get trap', async () => {
    let getTraps = 0;
    let runs = 0;
    const hostile = new Proxy({ sentence: 'all clear' }, {
      get() {
        getTraps += 1;
        return undefined;
      },
    });
    const adapter = adapterWith({ run: async () => {
      runs += 1;
      return { exitCode: 0, signal: null, stdout: '', stderr: '' };
    } });
    expect(await adapter.speak(hostile)).toEqual(REFUSED);
    expect(getTraps).toBe(0);
    expect(runs).toBe(0);
  });

  it('refuses a revoked Proxy request with zero probes and zero spawns', async () => {
    const { proxy, revoke } = Proxy.revocable({ sentence: 'all clear' }, {});
    revoke();
    let probes = 0;
    let runs = 0;
    const adapter = adapterWith({
      isExecutable: () => {
        probes += 1;
        return true;
      },
      run: async () => {
        runs += 1;
        return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      },
    });
    expect(await adapter.speak(proxy)).toEqual(REFUSED);
    expect(probes).toBe(0);
    expect(runs).toBe(0);
  });

  it('refuses a request with a custom prototype even with an own sentence', async () => {
    let probes = 0;
    let runs = 0;
    const custom = Object.create({ marker: 'custom' }) as Record<string, unknown>;
    custom.sentence = 'all clear';
    const adapter = adapterWith({
      isExecutable: () => {
        probes += 1;
        return true;
      },
      run: async () => {
        runs += 1;
        return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      },
    });
    expect(await adapter.speak(custom)).toEqual(REFUSED);
    expect(probes).toBe(0);
    expect(runs).toBe(0);
  });

  it('refuses a candidate list whose later entry is malformed before probing or spawning', async () => {
    let probes = 0;
    let runs = 0;
    const adapter = new SpdSayHostAudibleAlertAdapter({
      candidates: ['/tmp/executable', 123] as unknown as readonly string[],
      isExecutable: () => {
        probes += 1;
        return true;
      },
      run: async () => {
        runs += 1;
        return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      },
    });
    expect(await adapter.speak({ sentence: 'all clear' })).toEqual(REFUSED);
    expect(probes).toBe(0);
    expect(runs).toBe(0);
  });

  it('refuses sentence longer than 120 characters without resolving or spawning', async () => {
    let probes = 0;
    let runs = 0;
    const adapter = adapterWith({
      isExecutable: () => {
        probes += 1;
        return true;
      },
      run: async () => {
        runs += 1;
        return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      },
    });
    expect(await adapter.speak({ sentence: 'a'.repeat(121) })).toEqual(REFUSED);
    expect(probes).toBe(0);
    expect(runs).toBe(0);
  });

  it('refuses sentence containing control characters or newlines without resolving or spawning', async () => {
    let probes = 0;
    let runs = 0;
    const adapter = adapterWith({
      isExecutable: () => {
        probes += 1;
        return true;
      },
      run: async () => {
        runs += 1;
        return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      },
    });
    for (const sentence of ['a\nb', 'a\rb', 'a\tb', 'a\x00b', 'a\x1bb']) {
      expect(await adapter.speak({ sentence })).toEqual(REFUSED);
    }
    expect(probes).toBe(0);
    expect(runs).toBe(0);
  });

  it('refuses sentence containing a character outside the fixed set without any spawn', async () => {
    let probes = 0;
    let runs = 0;
    const adapter = adapterWith({
      isExecutable: () => {
        probes += 1;
        return true;
      },
      run: async () => {
        runs += 1;
        return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      },
    });
    for (const sentence of ['a/b', 'a=b', 'a$b', 'a\nb']) {
      expect(await adapter.speak({ sentence })).toEqual(REFUSED);
    }
    expect(probes).toBe(0);
    expect(runs).toBe(0);
  });

  it('refuses empty or whitespace-only sentence without resolving or spawning', async () => {
    let probes = 0;
    let runs = 0;
    const adapter = adapterWith({
      isExecutable: () => {
        probes += 1;
        return true;
      },
      run: async () => {
        runs += 1;
        return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      },
    });
    for (const sentence of ['', '   ']) {
      expect(await adapter.speak({ sentence })).toEqual(REFUSED);
    }
    expect(probes).toBe(0);
    expect(runs).toBe(0);
  });

  it('refuses non-string sentence without resolving or spawning', async () => {
    let probes = 0;
    let runs = 0;
    const adapter = adapterWith({
      isExecutable: () => {
        probes += 1;
        return true;
      },
      run: async () => {
        runs += 1;
        return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      },
    });
    for (const sentence of [123, null, undefined, {}]) {
      expect(await adapter.speak({ sentence })).toEqual(REFUSED);
    }
    expect(probes).toBe(0);
    expect(runs).toBe(0);
  });

  it('refuses a malformed injected candidate list without probing or spawning', async () => {
    let probes = 0;
    let runs = 0;
    const arrayLike = { length: 1, 0: scriptPath };
    const sparse: unknown[] = new Array(2);
    sparse[0] = scriptPath;
    const accessorList: string[] = [];
    let accessorCalls = 0;
    Object.defineProperty(accessorList, 0, {
      enumerable: true,
      configurable: true,
      get() {
        accessorCalls += 1;
        return scriptPath;
      },
    });
    const overLong: string[] = new Array(SPD_SAY_MAX_CANDIDATES + 1).fill(scriptPath);
    for (const bad of [
      'spd-say',
      42,
      arrayLike,
      sparse,
      accessorList,
      overLong,
      [42, scriptPath],
      new Proxy([scriptPath], {}),
    ]) {
      const adapter = new SpdSayHostAudibleAlertAdapter({
        candidates: bad as readonly string[],
        isExecutable: () => {
          probes += 1;
          return true;
        },
        run: async () => {
          runs += 1;
          return { exitCode: 0, signal: null, stdout: '', stderr: '' };
        },
      });
      expect(await adapter.speak({ sentence: 'all clear' })).toEqual(REFUSED);
    }
    // The candidate-element getter never ran while the list was inspected.
    expect(accessorCalls).toBe(0);
    expect(probes).toBe(0);
    expect(runs).toBe(0);
  });

  it('refuses a sparse candidates array of length 2**32 - 1 without probing or spawning', async () => {
    let probes = 0;
    let runs = 0;
    const sparse: unknown[] = new Array(2 ** 32 - 1);
    sparse[0] = scriptPath;
    const adapter = new SpdSayHostAudibleAlertAdapter({
      candidates: sparse as readonly string[],
      isExecutable: () => {
        probes += 1;
        return true;
      },
      run: async () => {
        runs += 1;
        return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      },
    });
    expect(await adapter.speak({ sentence: 'all clear' })).toEqual(REFUSED);
    expect(probes).toBe(0);
    expect(runs).toBe(0);
  });

  it('refuses a request with an unexpected extra own key without spawning', async () => {
    let runs = 0;
    const adapter = adapterWith({
      run: async () => {
        runs += 1;
        return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      },
    });
    expect(await adapter.speak({ sentence: 'all clear', extra: 1 })).toEqual(REFUSED);
    expect(runs).toBe(0);
  });

  it('refuses a sentence starting with a hyphen (option injection) with zero spawns', async () => {
    let runs = 0;
    let probes = 0;
    const adapter = adapterWith({
      isExecutable: () => {
        probes += 1;
        return true;
      },
      run: async () => {
        runs += 1;
        return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      },
    });
    for (const sentence of ['-h', '-C', '--help', '-e x']) {
      expect(await adapter.speak({ sentence })).toEqual(REFUSED);
    }
    expect(probes).toBe(0);
    expect(runs).toBe(0);
  });

  it('refuses a valid candidates array with an own Symbol.iterator getter without running the getter or probing', async () => {
    let probes = 0;
    let runs = 0;
    let iteratorGetterCalls = 0;
    const candidates: string[] = [scriptPath];
    Object.defineProperty(candidates, Symbol.iterator, {
      configurable: true,
      enumerable: false,
      get() {
        iteratorGetterCalls += 1;
        return function* () {
          yield '/tmp/evil-unvalidated';
        };
      },
    });
    const adapter = new SpdSayHostAudibleAlertAdapter({
      candidates: candidates as readonly string[],
      isExecutable: () => {
        probes += 1;
        return true;
      },
      run: async () => {
        runs += 1;
        return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      },
    });
    expect(await adapter.speak({ sentence: 'all clear' })).toEqual(REFUSED);
    expect(iteratorGetterCalls).toBe(0);
    expect(probes).toBe(0);
    expect(runs).toBe(0);
  });

  it('refuses a candidates array whose Symbol.iterator is an overridden data property yielding an unvalidated path', async () => {
    let probes = 0;
    let runs = 0;
    const candidates: string[] = [scriptPath];
    Object.defineProperty(candidates, Symbol.iterator, {
      configurable: true,
      enumerable: false,
      value: function* () {
        yield '/tmp/evil-unvalidated';
      },
    });
    const adapter = new SpdSayHostAudibleAlertAdapter({
      candidates: candidates as readonly string[],
      isExecutable: () => {
        probes += 1;
        return true;
      },
      run: async () => {
        runs += 1;
        return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      },
    });
    expect(await adapter.speak({ sentence: 'all clear' })).toEqual(REFUSED);
    expect(probes).toBe(0);
    expect(runs).toBe(0);
  });

  it('probes exactly the validated paths of a normal valid array, in order', async () => {
    const probed: string[] = [];
    const runs: string[][] = [];
    const first = path.join(workDir, 'first-probe');
    const second = path.join(workDir, 'second-probe');
    writeFileSync(first, '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(second, '#!/bin/sh\n', { mode: 0o755 });
    const adapter = new SpdSayHostAudibleAlertAdapter({
      candidates: [first, second],
      isExecutable: (candidate) => {
        probed.push(candidate);
        // Probe every validated path in order, but only accept the second.
        return candidate === second;
      },
      run: async (file, args) => {
        runs.push([file, ...args]);
        return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      },
    });
    expect(await adapter.speak({ sentence: 'all clear' })).toEqual({ outcome: 'spoken' });
    expect(probed).toEqual([first, second]);
    expect(runs).toEqual([[second, 'all clear']]);
  });
});

describe('SpdSayHostAudibleAlertAdapter binary resolution', () => {
  it('returns unavailable binary-missing when candidate path does not exist', async () => {
    const adapter = new SpdSayHostAudibleAlertAdapter({ candidates: [path.join(workDir, 'absent')] });
    expect(await adapter.speak({ sentence: 'all clear' })).toEqual(UNAVAILABLE);
  });

  it('returns unavailable binary-missing when candidate is mode 0o644', async () => {
    chmodSync(scriptPath, 0o644);
    const adapter = adapterWith();
    expect(await adapter.speak({ sentence: 'all clear' })).toEqual(UNAVAILABLE);
  });

  it('ignores relative candidate even when isExecutable accepts it', async () => {
    let probes = 0;
    const adapter = new SpdSayHostAudibleAlertAdapter({
      candidates: ['spd-say'],
      isExecutable: () => {
        probes += 1;
        return true;
      },
    });
    expect(await adapter.speak({ sentence: 'all clear' })).toEqual(UNAVAILABLE);
    // A relative candidate is skipped before any probe runs.
    expect(probes).toBe(0);
  });

  it('returns unavailable binary-missing when isExecutable throws', async () => {
    const adapter = adapterWith({
      isExecutable: () => {
        throw new Error('probe exploded');
      },
    });
    expect(await adapter.speak({ sentence: 'all clear' })).toEqual(UNAVAILABLE);
  });

  it('resolves the first executable absolute candidate from fixed defaults', async () => {
    const probes: string[] = [];
    const adapter = new SpdSayHostAudibleAlertAdapter({
      isExecutable: (candidate) => {
        probes.push(candidate);
        return candidate === SPD_SAY_BINARY_CANDIDATES[0];
      },
      run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
    });
    expect(await adapter.speak({ sentence: 'all clear' })).toEqual({ outcome: 'spoken' });
    expect(probes).toEqual([SPD_SAY_BINARY_CANDIDATES[0]]);
  });

  it('speaks twice for the same request and resolves the binary on every call', async () => {
    const probeCalls: string[] = [];
    const adapter = adapterWith({
      isExecutable: (candidate) => {
        probeCalls.push(candidate);
        return true;
      },
    });
    expect(await adapter.speak({ sentence: 'first sentence' })).toEqual({ outcome: 'spoken' });
    expect(await adapter.speak({ sentence: 'first sentence' })).toEqual({ outcome: 'spoken' });
    expect(probeCalls.length).toBe(2);
    // Two real spawns are recorded: each run appended its four lines.
    expect(seenLines().filter((line) => line === '1')).toHaveLength(2);
  });
});

describe('SpdSayHostAudibleAlertAdapter spawn handling', () => {
  it('passes validated sentence as a single argv element with fixed command and no shell', async () => {
    const sentences = [
      TRAIN_HEALTH_ANNOUNCEMENT_FALLBACK_SENTENCE,
      "Pull request #42, stalled-head's check.",
      'a'.repeat(120),
    ];
    for (const sentence of sentences) {
      rmSync(seenPath, { force: true });
      const adapter = adapterWith();
      expect(await adapter.speak({ sentence })).toEqual({ outcome: 'spoken' });
      const lines = seenLines();
      expect(lines[0]).toBe('1');
      expect(lines[1]).toBe(sentence);
      expect(lines).toHaveLength(4);
    }
  });

  it('forwards XDG_RUNTIME_DIR only for valid /run/user/<uid> runtimeDir', async () => {
    const cases: Array<[string | undefined, string]> = [
      ['/run/user/1000', '/run/user/1000'],
      ['/tmp/x', 'unset'],
      [undefined, 'unset'],
      ['/run/user/1000/../x', 'unset'],
    ];
    for (const [runtimeDir, expected] of cases) {
      rmSync(seenPath, { force: true });
      const adapter = adapterWith({ runtimeDir: () => runtimeDir });
      expect(await adapter.speak({ sentence: 'all clear' })).toEqual({ outcome: 'spoken' });
      expect(seenLines()).toEqual(['1', 'all clear', expected, 'unset']);
    }
  });

  it('does not forward XDG_RUNTIME_DIR when runtimeDir returns a non-string', async () => {
    rmSync(seenPath, { force: true });
    const adapter = adapterWith({ runtimeDir: (() => ['/run/user/1000']) as unknown as () => string | undefined });
    expect(await adapter.speak({ sentence: 'all clear' })).toEqual({ outcome: 'spoken' });
    expect(seenLines()).toEqual(['1', 'all clear', 'unset', 'unset']);
  });

  it('does not leak FLEET_TEST_MARKER from process.env to real script', async () => {
    vi.stubEnv('FLEET_TEST_MARKER', 'present');
    rmSync(seenPath, { force: true });
    const adapter = adapterWith({ runtimeDir: () => undefined });
    expect(await adapter.speak({ sentence: 'all clear' })).toEqual({ outcome: 'spoken' });
    expect(seenLines()).toEqual(['1', 'all clear', 'unset', 'unset']);
  });

  it('does not return or leak script stdout or stderr', async () => {
    const noisy = writeProbeScript(0, true, 0);
    const adapter = new SpdSayHostAudibleAlertAdapter({ candidates: [noisy] });
    const result = await adapter.speak({ sentence: 'all clear' });
    expect(result).toEqual({ outcome: 'spoken' });
    expect(JSON.stringify(result)).not.toContain('noise');
  });

  it('returns failed spawn-failed without throwing when run throws', async () => {
    const adapter = adapterWith({
      run: () => Promise.reject(new Error('runner exploded')),
    });
    expect(await adapter.speak({ sentence: 'all clear' })).toEqual({ outcome: 'failed', reasonCode: 'spawn-failed' });
  });

  it('returns failed spawn-failed when run reports error without signal', async () => {
    const { run, calls } = fakeRun({ exitCode: null, signal: null, stdout: '', stderr: '', error: 'spawn ENOENT' });
    const adapter = adapterWith({ run });
    expect(await adapter.speak({ sentence: 'all clear' })).toEqual({ outcome: 'failed', reasonCode: 'spawn-failed' });
    expect(calls()).toBe(1);
  });

  it('returns failed killed in well under 5 seconds on timeout', async () => {
    const sleeper = writeProbeScript(0, false, 5);
    const adapter = new SpdSayHostAudibleAlertAdapter({ candidates: [sleeper], timeoutMs: 200 });
    const started = Date.now();
    expect(await adapter.speak({ sentence: 'all clear' })).toEqual({ outcome: 'failed', reasonCode: 'killed' });
    expect(Date.now() - started).toBeLessThan(4_500);
  }, 10_000);

  it('returns failed nonzero-exit when script exits 3', async () => {
    const failing = writeProbeScript(3, false, 0);
    const adapter = new SpdSayHostAudibleAlertAdapter({ candidates: [failing] });
    expect(await adapter.speak({ sentence: 'all clear' })).toEqual({ outcome: 'failed', reasonCode: 'nonzero-exit' });
  });

  it('returns failed nonzero-exit when run returns null', async () => {
    const adapter = adapterWith({ run: async () => null as unknown as SpawnRunOutcome });
    expect(await adapter.speak({ sentence: 'all clear' })).toEqual({ outcome: 'failed', reasonCode: 'nonzero-exit' });
  });

  it('uses the default timeout constant and passes a bounded max buffer', async () => {
    let observed: unknown;
    const adapter = adapterWith({
      run: async (_file, _args, options) => {
        observed = options;
        return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      },
    });
    expect(await adapter.speak({ sentence: 'all clear' })).toEqual({ outcome: 'spoken' });
    expect(observed).toMatchObject({ timeoutMs: SPD_SAY_TIMEOUT_MS, maxBufferBytes: 65_536 });
  });

  it('rejects an out-of-range injected timeout and clamps into the accepted range', async () => {
    const observed: unknown[] = [];
    const make = (timeoutMs: number | undefined): SpdSayHostAudibleAlertAdapter =>
      adapterWith({
        timeoutMs,
        run: async (_file, _args, options) => {
          observed.push(options);
          return { exitCode: 0, signal: null, stdout: '', stderr: '' };
        },
      });
    await make(undefined).speak({ sentence: 's' });
    await make(99).speak({ sentence: 's' });
    await make(60_001).speak({ sentence: 's' });
    await make(3_000).speak({ sentence: 's' });
    expect(observed.map((options) => (options as { timeoutMs: number }).timeoutMs)).toEqual([
      SPD_SAY_TIMEOUT_MS,
      SPD_SAY_TIMEOUT_MS,
      SPD_SAY_TIMEOUT_MS,
      3_000,
    ]);
  });
});

describe('boundary hardening meta-tests', () => {
  it('a validator returning a constant verdict would fail these tests', () => {
    // A constant-refusing implementation would reject the valid sentences the
    // first describe block accepts; a constant-accepting one would accept the
    // hostile sentences above. Both named cases exist and both directions are
    // asserted, so no constant verdict can satisfy the suite.
    expect(validateHostAudibleAlertSentence('all clear')).not.toEqual(INVALID);
    expect(validateHostAudibleAlertSentence('a\nb')).toEqual(INVALID);
  });

  it('an identity echo of the input would fail these tests', () => {
    // An identity echo would return the raw request (or the raw candidate
    // list) rather than a typed verdict; the typed-result assertions above
    // (`toEqual(REFUSED)`, `toEqual({ ok: true, sentence })`) reject that.
    const parsed = parseHostAudibleAlertRequest({ sentence: 'all clear' });
    expect(parsed).not.toEqual({ sentence: 'all clear' });
    expect(parsed).toEqual({ ok: true, sentence: 'all clear' });
  });
});

describe('getter-count helper guard', () => {
  it('counts getter calls only when the getter runs', () => {
    const source: Record<string, unknown> = {};
    const { calls } = getterCounts(source, 'sentence');
    expect(calls()).toBe(0);
    expect(source.sentence).toBe('got');
    expect(calls()).toBe(1);
  });
});
