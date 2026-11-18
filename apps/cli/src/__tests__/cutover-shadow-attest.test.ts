// AT1: the `cutover shadow attest` command — wired through the real CLI
// driver against a real temporary state directory (where the attestation
// ledger and the cutover journal land). `attested` and `unchanged` complete
// (0), every refusal or unknown outcome exits 1, malformed flags are usage
// (2). There is no `--now-iso`: the daemon clock timestamps every fact.
import { existsSync, mkdtempSync, promises as fs, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createFleetCliRuntime } from '../composition.js';
import { runCli, type CliIo } from '../index.js';
import {
  evaluateShadowOneTimeCriteria,
  SHADOW_ATTESTATION_FACTS,
} from '@fleet/work-execution';

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function cli(
  runtime: ReturnType<typeof createFleetCliRuntime>,
  argv: string[],
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  const code = await runCli(argv, io, runtime);
  return { code, out: out.join(''), err: err.join('') };
}

function newDirs(): { stateDir: string; fixtureDir: string } {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-shadow-attest-'));
  const fixtureDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-shadow-attest-shell-'));
  tempDirs.push(stateDir, fixtureDir);
  return { stateDir, fixtureDir };
}

function runtimeFor(stateDir?: string): ReturnType<typeof createFleetCliRuntime> {
  return createFleetCliRuntime({ ...(stateDir !== undefined ? { stateDir } : {}), daemonSleep: async () => {} });
}

function attestArgs(extra: readonly string[]): string[] {
  return ['cutover', 'shadow', 'attest', ...extra];
}

const BASE_FLAGS = [
  '--note',
  'verified against the release tree',
  '--expected-revision',
  '0',
  '--operation-id',
  'op-1',
  '--authority',
  'ops-lead-7',
];

describe('cutover shadow attest (AT1)', () => {
  it('attests each one-time fact, then the evaluator reads them back as satisfied', async () => {
    const { stateDir, fixtureDir } = newDirs();
    await fs.writeFile(path.join(fixtureDir, 'queue'), '');
    const runtime = runtimeFor(stateDir);
    let revision = 0;
    let operation = 0;
    for (const fact of SHADOW_ATTESTATION_FACTS) {
      operation += 1;
      const result = await cli(
        runtime,
        attestArgs([
          '--fact',
          fact,
          ...BASE_FLAGS.slice(0, 2),
          '--expected-revision',
          String(revision),
          '--operation-id',
          `op-${operation}`,
          '--authority',
          'owner',
        ]),
      );
      expect(result.code).toBe(0);
      const body = JSON.parse(result.out) as { outcome: string; ledger: { revision: number } };
      expect(body.outcome).toBe('attested');
      revision = body.ledger.revision;
    }
    const file = path.join(stateDir, 'cutover-shadow-attestations.json');
    expect(existsSync(file)).toBe(true);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as {
      revision: number;
      attestations: ReadonlyArray<{ fact: string; observedDay: string; reason: string; digest: string }>;
    };
    expect(stored.revision).toBe(SHADOW_ATTESTATION_FACTS.length);
    expect(stored.attestations.map((item) => item.fact)).toEqual([...SHADOW_ATTESTATION_FACTS]);
    expect(stored.attestations.every((item) => item.reason === 'owner-attested')).toBe(true);
    // The note and the authority are hashed, never stored.
    expect(readFileSync(file, 'utf8')).not.toContain('verified against the release tree');
    expect(readFileSync(file, 'utf8')).not.toContain('ops-lead-7');

    // The day the facts were recorded on is today (the daemon clock); the
    // one-time evaluator must read them back as satisfied.
    const day = new Date().toISOString().slice(0, 10);
    const evaluations = evaluateShadowOneTimeCriteria({
      day,
      releaseSha: 'c'.repeat(40),
      attestations: stored,
      releaseTests: [],
    });
    expect(evaluations.S2.reason).not.toBe('not-yet-observed');
    expect(evaluations.S3.reason).not.toBe('not-yet-observed');
  });

  it('replays the same operation id and payload without bumping the revision', async () => {
    const { stateDir } = newDirs();
    const runtime = runtimeFor(stateDir);
    const first = await cli(runtime, attestArgs(['--fact', 's3-wake-after-outage', ...BASE_FLAGS]));
    expect(first.code).toBe(0);
    const second = await cli(runtime, attestArgs(['--fact', 's3-wake-after-outage', ...BASE_FLAGS]));
    expect(second.code).toBe(0);
    const firstBody = JSON.parse(first.out) as { ledger: { revision: number } };
    const secondBody = JSON.parse(second.out) as { outcome: string; ledger: { revision: number } };
    expect(secondBody.outcome).toBe('attested');
    expect(secondBody.ledger.revision).toBe(firstBody.ledger.revision);
  });

  it('refuses attest without state-dir with exit 1', async () => {
    const runtime = runtimeFor();
    const result = await cli(runtime, attestArgs(['--fact', 's3-wake-after-outage', ...BASE_FLAGS]));
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toEqual({ outcome: 'refused', reason: 'state-dir-required' });
  });

  it('refuses unknown fact id with exit 2', async () => {
    const { stateDir } = newDirs();
    const runtime = runtimeFor(stateDir);
    const result = await cli(runtime, attestArgs(['--fact', 's9-not-a-fact', ...BASE_FLAGS]));
    expect(result.code).toBe(2);
  });

  it('refuses invalid CLI flags and --now-iso with exit 2', async () => {
    const { stateDir } = newDirs();
    const runtime = runtimeFor(stateDir);
    expect((await cli(runtime, attestArgs(BASE_FLAGS))).code).toBe(2); // no --fact
    expect((await cli(runtime, attestArgs(['--fact', 's2-canary-parks']))).code).toBe(2); // no --note
    expect(
      (await cli(runtime, attestArgs(['--fact', 's2-canary-parks', '--note', 'n', '--operation-id', 'op-1', '--expected-revision', '-1', '--authority', 'owner'])))
        .code,
    ).toBe(2);
    const missingOperationId = await cli(
      runtime,
      attestArgs(['--fact', 's2-canary-parks', '--note', 'n', '--expected-revision', '0', '--authority', 'owner']),
    );
    expect(missingOperationId.code).toBe(2);
    const tooLongOperationId = await cli(
      runtime,
      attestArgs([
        '--fact',
        's2-canary-parks',
        '--note',
        'n',
        '--expected-revision',
        '0',
        '--operation-id',
        'a'.repeat(65),
        '--authority',
        'owner',
      ]),
    );
    expect(tooLongOperationId.code).toBe(2);
    const nowIso = await cli(
      runtime,
      attestArgs(['--fact', 's2-canary-parks', '--note', 'n', '--expected-revision', '0', '--operation-id', 'op-1', '--authority', 'owner', '--now-iso', '2026-06-15T00:00:00Z']),
    );
    expect(nowIso.code).toBe(2);
  });

  it('refuses missing authority without writing', async () => {
    const { stateDir } = newDirs();
    const runtime = runtimeFor(stateDir);
    const result = await cli(
      runtime,
      attestArgs(['--fact', 's2-canary-parks', '--note', 'n', '--expected-revision', '0', '--operation-id', 'op-1']),
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toEqual({ outcome: 'refused', reason: 'authority-required' });
    expect(existsSync(path.join(stateDir, 'cutover-shadow-attestations.json'))).toBe(false);
  });

  it('refuses stale revision with revision-conflict and exit 1', async () => {
    const { stateDir } = newDirs();
    const runtime = runtimeFor(stateDir);
    expect(
      (
        await cli(
          runtime,
          attestArgs(['--fact', 's2-canary-parks', '--note', 'n', '--expected-revision', '0', '--operation-id', 'op-1', '--authority', 'owner']),
        )
      ).code,
    ).toBe(0);
    const stale = await cli(
      runtime,
      attestArgs([
        '--fact',
        's3-wake-after-outage',
        '--note',
        'n',
        '--expected-revision',
        '0',
        '--operation-id',
        'op-2',
        '--authority',
        'owner',
      ]),
    );
    expect(stale.code).toBe(1);
    expect(JSON.parse(stale.out)).toEqual({ outcome: 'refused', reason: 'revision-conflict' });
    const stored = JSON.parse(readFileSync(path.join(stateDir, 'cutover-shadow-attestations.json'), 'utf8')) as {
      attestations: ReadonlyArray<{ fact: string }>;
    };
    expect(stored.attestations.map((item) => item.fact)).toEqual(['s2-canary-parks']);
  });

  it('refuses secret-shaped input without echoing it', async () => {
    const { stateDir } = newDirs();
    const runtime = runtimeFor(stateDir);
    const secret = `sk-${'c'.repeat(24)}`;
    const result = await cli(
      runtime,
      attestArgs(['--fact', 's2-canary-parks', '--note', secret, '--expected-revision', '0', '--operation-id', 'op-1', '--authority', 'owner']),
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toEqual({ outcome: 'refused', reason: 'secret-shaped' });
    expect(result.out).not.toContain(secret);
    expect(existsSync(path.join(stateDir, 'cutover-shadow-attestations.json'))).toBe(false);
  });

  it('record-day never writes cutover-shadow-attestations.json', async () => {
    const { stateDir, fixtureDir } = newDirs();
    await fs.writeFile(path.join(fixtureDir, 'queue'), '');
    const runtime = runtimeFor(stateDir);
    const result = await cli(runtime, [
      'cutover',
      'shadow',
      'record-day',
      '--repository',
      'fleet/v2',
      '--legacy-state-dir',
      fixtureDir,
    ]);
    expect(result.code).toBe(0);
    expect(existsSync(path.join(stateDir, 'cutover-shadow.json'))).toBe(true);
    expect(existsSync(path.join(stateDir, 'cutover-shadow-attestations.json'))).toBe(false);
  });
});
