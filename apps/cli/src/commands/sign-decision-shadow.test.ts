// KEY1c — `coordination sign-decision --pre-sign` end-to-end tests.
/**
 * The pre-sign path writes the standing `merge:import-shadow` grant's signed
 * answer file from its coordinates BEFORE `request-decision` records the
 * awaiting request; the round trip continues through `request-decision`,
 * `resolve-auth` and `merge import --apply`. Every refusal here writes
 * nothing and reads no key. The merge import's train-state use case is
 * stubbed: this suite proves authorization, not the import itself. Nothing
 * here dispatches or touches the network.
 */

import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli } from '../index.js';
import type { CliIo } from '../index.js';

const PROJECT_ID = 'proj-shadow-pre';
const REPOSITORY = 'octo/repo';
const PROPOSAL_DIGEST = 'sha256-proposal';
const POLICY_REVISION = 'pol-rev-1';
const DAY_MS = 86_400_000;

interface CapturedIo extends CliIo {
  readonly outLines: string[];
  readonly errLines: string[];
}

function captureIo(): CapturedIo {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    stdout: (text: string) => {
      outLines.push(text);
    },
    stderr: (text: string) => {
      errLines.push(text);
    },
  };
}

async function runCoordination(
  runtime: FleetCliRuntime,
  args: readonly string[],
  stateDir: string,
): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  const io = captureIo();
  const code = await runCli(
    ['coordination', ...args],
    io,
    runtime,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { now: () => new Date().toISOString(), stateDir },
  );
  return { code, stdout: io.outLines, stderr: io.errLines };
}

async function runMergeImport(
  runtime: FleetCliRuntime,
  args: readonly string[],
): Promise<{ code: number; stdout: string[] }> {
  const io = captureIo();
  const code = await runCli(['merge', ...args], io, runtime);
  return { code, stdout: io.outLines };
}

function parseDocument(lines: readonly string[]): Record<string, unknown> {
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

function newKey(): { privatePem: string; publicBase64: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return { privatePem, publicBase64: spki.subarray(spki.length - 32).toString('base64') };
}

interface TestWorkspace {
  stateDir: string;
  keyDir: string;
  keyPath: string;
  publicBase64: string;
  privatePem: string;
  legacyDir: string;
}

function workspace(): TestWorkspace {
  const root = mkdtempSync(join(tmpdir(), 'fleet-v2-pre-sign-'));
  const stateDir = join(root, 'state');
  const keyDir = join(root, 'keys');
  const legacyDir = join(root, 'legacy');
  mkdirSync(keyDir, { recursive: true });
  mkdirSync(legacyDir, { recursive: true });
  const { privatePem, publicBase64 } = newKey();
  const keyPath = join(keyDir, 'owner-key.pem');
  writeFileSync(keyPath, privatePem);
  chmodSync(keyPath, 0o600);
  return { stateDir, keyDir, keyPath, publicBase64, privatePem, legacyDir };
}

function runtimeFor(stateDir: string | undefined, publicBase64: string): FleetCliRuntime {
  return createFleetCliRuntime({
    ...(stateDir !== undefined ? { stateDir } : {}),
    ownerPublicKey: publicBase64,
  });
}

/** An expiry 10 days out: inside the 30-day cap, strictly in the future. */
function futureExpiry(): string {
  return new Date(Date.now() + 10 * DAY_MS).toISOString();
}

function preSignArgs(expiresAtIso: string, extra: readonly string[] = []): string[] {
  return [
    'sign-decision',
    '--pre-sign',
    '--action-scope',
    'merge:import-shadow',
    '--repository',
    REPOSITORY,
    '--project',
    PROJECT_ID,
    '--expires-at',
    expiresAtIso,
    ...extra,
  ];
}

function decisionFiles(stateDir: string): string[] {
  const decisions = join(stateDir, 'decisions');
  return existsSync(decisions) ? readdirSync(decisions) : [];
}

async function requestShadowDecision(
  runtime: FleetCliRuntime,
  stateDir: string,
  expiresAtIso: string,
  repository = REPOSITORY,
): Promise<{ code: number; requestId: string; doc: Record<string, unknown> }> {
  const result = await runCoordination(
    runtime,
    [
      'request-decision',
      '--kind',
      'action-decision',
      '--action-scope',
      'merge:import-shadow',
      '--project-id',
      PROJECT_ID,
      '--proposal-digest',
      PROPOSAL_DIGEST,
      '--policy-revision',
      POLICY_REVISION,
      '--repository',
      repository,
      '--expires-at-iso',
      expiresAtIso,
    ],
    stateDir,
  );
  const doc = parseDocument(result.stdout);
  const requestId = (doc['request'] as Record<string, unknown>)['id'] as string;
  return { code: result.code, requestId, doc };
}

describe('coordination sign-decision --pre-sign (KEY1c)', () => {
  it('round-trips: pre-sign, request-decision, resolve-auth authorized, merge import applies', async () => {
    const ws = workspace();
    const runtime = runtimeFor(ws.stateDir, ws.publicBase64);
    const expiresAtIso = futureExpiry();

    const signed = await runCoordination(
      runtime,
      preSignArgs(expiresAtIso, ['--key', ws.keyPath, '--yes']),
      ws.stateDir,
    );
    expect(signed.code).toBe(0);
    const signedDoc = parseDocument(signed.stdout);
    expect(signedDoc['outcome']).toBe('signed');
    const requestId = signedDoc['requestId'] as string;
    const grantId = signedDoc['grantId'] as string;
    expect(requestId.startsWith('shadow-import-')).toBe(true);
    expect(grantId).toBe(`shadow-import-grant-${requestId.slice('shadow-import-'.length, 'shadow-import-'.length + 16)}`);
    expect(signedDoc['projectId']).toBe(PROJECT_ID);
    expect(signedDoc['actionScope']).toBe('merge:import-shadow');
    expect(signedDoc['repository']).toEqual({ owner: 'octo', repo: 'repo' });
    expect(signedDoc['expiresAtIso']).toBe(expiresAtIso);
    expect(signedDoc['decisionRevision']).toBe('1');
    expect(String(signedDoc['answerPath']).endsWith(join('decisions', `${requestId}.json`))).toBe(true);
    expect(decisionFiles(ws.stateDir)).toEqual([`${requestId}.json`]);

    const requested = await requestShadowDecision(runtime, ws.stateDir, expiresAtIso);
    expect(requested.code).toBe(0);
    // The pre-signed answer binds the exact request the coordinates derive.
    expect(requested.requestId).toBe(requestId);
    expect(requested.doc['request']).toBeTruthy();

    const resolved = await runCoordination(
      runtime,
      [
        'resolve-auth',
        '--project-id',
        PROJECT_ID,
        '--action-scope',
        'merge:import-shadow',
        '--authorization-grant-id',
        grantId,
        '--repository',
        REPOSITORY,
      ],
      ws.stateDir,
    );
    expect(resolved.code).toBe(0);
    expect(parseDocument(resolved.stdout)['outcome']).toBe('authorized');

    const applied = await runMergeImport(runtime, [
      'import',
      '--repository',
      REPOSITORY,
      '--legacy-state-dir',
      ws.legacyDir,
      '--apply',
      '--grant',
      grantId,
      '--project',
      PROJECT_ID,
    ]);
    expect(applied.code).toBe(0);
    expect(parseDocument(applied.stdout)['outcome']).toBe('applied');
  });

  it('refuses with shadow-request-already-recorded when the request already exists, writing nothing', async () => {
    const ws = workspace();
    const runtime = runtimeFor(ws.stateDir, ws.publicBase64);
    const expiresAtIso = futureExpiry();
    const requested = await requestShadowDecision(runtime, ws.stateDir, expiresAtIso);
    expect(requested.code).toBe(0);

    // The key path does not exist: if the refusal were reached only after a
    // key read, this run would fail with a key error instead of the typed
    // already-recorded refusal — so this also proves the key is never read.
    const missingKeyPath = join(ws.keyDir, 'owner-key-that-does-not-exist.pem');
    const refused = await runCoordination(
      runtime,
      preSignArgs(expiresAtIso, ['--key', missingKeyPath, '--yes']),
      ws.stateDir,
    );
    expect(refused.code).toBe(1);
    expect(parseDocument(refused.stdout)['reason']).toBe('shadow-request-already-recorded');
    expect(decisionFiles(ws.stateDir)).toEqual([]);
  });

  it('refuses --decision-revision with --pre-sign as a usage error (exit 2), writing nothing', async () => {
    const ws = workspace();
    const runtime = runtimeFor(ws.stateDir, ws.publicBase64);
    const refused = await runCoordination(
      runtime,
      [...preSignArgs(futureExpiry(), ['--key', ws.keyPath, '--yes']), '--decision-revision', 'decision-2'],
      ws.stateDir,
    );
    expect(refused.code).toBe(2);
    expect(decisionFiles(ws.stateDir)).toEqual([]);
  });

  it('refuses a projectId with surrounding whitespace before reading any key or writing', async () => {
    const ws = workspace();
    const runtime = runtimeFor(ws.stateDir, ws.publicBase64);
    const refused = await runCoordination(
      runtime,
      ['sign-decision', '--pre-sign', '--action-scope', 'merge:import-shadow', '--repository', REPOSITORY, '--project', ' proj ', '--expires-at', futureExpiry(), '--key', ws.keyPath, '--yes'],
      ws.stateDir,
    );
    expect(refused.code).toBe(1);
    expect(parseDocument(refused.stdout)['reason']).toBe('pre-sign-invalid-project');
    expect(decisionFiles(ws.stateDir)).toEqual([]);
  });

  it('ignores --now-iso: the trusted clock is used', async () => {
    const ws = workspace();
    const runtime = runtimeFor(ws.stateDir, ws.publicBase64);
    const expiresAtIso = futureExpiry();
    // A `--now-iso` past the expiry would refuse `pre-sign-expired` if it were
    // honoured; the trusted clock is used instead, so the sign succeeds.
    const signed = await runCoordination(
      runtime,
      [...preSignArgs(expiresAtIso, ['--key', ws.keyPath, '--yes']), '--now-iso', '2099-01-01T00:00:00.000Z'],
      ws.stateDir,
    );
    expect(signed.code).toBe(0);
    expect(parseDocument(signed.stdout)['outcome']).toBe('signed');
  });

  it('refuses different coordinates: a differently formatted equivalent instant digests differently', async () => {
    const ws = workspace();
    const runtime = runtimeFor(ws.stateDir, ws.publicBase64);
    const expiresAtIso = futureExpiry();
    const signed = await runCoordination(
      runtime,
      preSignArgs(expiresAtIso, ['--key', ws.keyPath, '--yes']),
      ws.stateDir,
    );
    expect(signed.code).toBe(0);
    const signedDoc = parseDocument(signed.stdout);
    const requestId = signedDoc['requestId'] as string;
    const grantId = signedDoc['grantId'] as string;

    // The original coordinates are requested, so the grant is recorded and
    // resolvable; then differently spelled or different coordinates refuse.
    const requested = await requestShadowDecision(runtime, ws.stateDir, expiresAtIso);
    expect(requested.code).toBe(0);
    expect(requested.requestId).toBe(requestId);

    // The equivalent instant in a `+00:00` spelling keeps its own text in the
    // digest payload, so it derives a DIFFERENT request id and the pre-signed
    // answer never covers it: the request stays awaiting.
    const shifted = await requestShadowDecision(
      runtime,
      ws.stateDir,
      `${expiresAtIso.slice(0, -1)}+00:00`,
    );
    expect(shifted.code).toBe(0);
    expect(shifted.requestId).not.toBe(requestId);

    const resolved = await runCoordination(
      runtime,
      [
        'resolve-auth',
        '--project-id',
        PROJECT_ID,
        '--action-scope',
        'merge:import-shadow',
        '--authorization-grant-id',
        `shadow-import-grant-${shifted.requestId.slice('shadow-import-'.length, 'shadow-import-'.length + 16)}`,
        '--repository',
        REPOSITORY,
      ],
      ws.stateDir,
    );
    expect(resolved.code).toBe(1);
    expect(parseDocument(resolved.stdout)['outcome']).toBe('blocked');

    // A different repository is refused on the resolve's coordinate match.
    const otherRepo = await runCoordination(
      runtime,
      [
        'resolve-auth',
        '--project-id',
        PROJECT_ID,
        '--action-scope',
        'merge:import-shadow',
        '--authorization-grant-id',
        grantId,
        '--repository',
        'octo/other',
      ],
      ws.stateDir,
    );
    expect(otherRepo.code).toBe(1);
    expect(parseDocument(otherRepo.stdout)['reason']).toBe('grant-wrong-repository');
  });

  it('refuses an expiry beyond the 30-day cap before anything is written', async () => {
    const ws = workspace();
    const runtime = runtimeFor(ws.stateDir, ws.publicBase64);
    const tooLong = new Date(Date.now() + 40 * DAY_MS).toISOString();
    const refused = await runCoordination(
      runtime,
      preSignArgs(tooLong, ['--key', ws.keyPath, '--yes']),
      ws.stateDir,
    );
    expect(refused.code).toBe(1);
    expect(parseDocument(refused.stdout)['reason']).toBe('pre-sign-ttl-exceeded');
    expect(decisionFiles(ws.stateDir)).toEqual([]);
  });

  it('refuses a wrong key, an unsafe key mode and a key inside the state dir before anything is written', async () => {
    const ws = workspace();
    const runtime = runtimeFor(ws.stateDir, ws.publicBase64);
    const expiresAtIso = futureExpiry();
    // A wrong but safe key.
    const wrong = newKey();
    const wrongPath = join(ws.keyDir, 'wrong-key.pem');
    writeFileSync(wrongPath, wrong.privatePem);
    chmodSync(wrongPath, 0o600);
    const mismatch = await runCoordination(
      runtime,
      preSignArgs(expiresAtIso, ['--key', wrongPath, '--yes']),
      ws.stateDir,
    );
    expect(mismatch.code).toBe(1);
    expect(parseDocument(mismatch.stdout)['reason']).toBe('key-mismatch');
    // A 0644 key file.
    chmodSync(ws.keyPath, 0o644);
    const tooOpen = await runCoordination(
      runtime,
      preSignArgs(expiresAtIso, ['--key', ws.keyPath, '--yes']),
      ws.stateDir,
    );
    expect(tooOpen.code).toBe(1);
    expect(parseDocument(tooOpen.stdout)['reason']).toBe('key-file-permissions-too-open');
    chmodSync(ws.keyPath, 0o600);
    // A key inside the state directory.
    const insideState = join(ws.stateDir, 'inside.pem');
    writeFileSync(insideState, ws.privatePem);
    chmodSync(insideState, 0o600);
    const inState = await runCoordination(
      runtime,
      preSignArgs(expiresAtIso, ['--key', insideState, '--yes']),
      ws.stateDir,
    );
    expect(inState.code).toBe(1);
    expect(parseDocument(inState.stdout)['reason']).toBe('key-inside-state-dir');
    expect(decisionFiles(ws.stateDir)).toEqual([]);
  });

  it('exits 2 for --pre-sign with a non-shadow scope or missing flags, writing nothing', async () => {
    const ws = workspace();
    const runtime = runtimeFor(ws.stateDir, ws.publicBase64);
    for (const args of [
      ['sign-decision', '--pre-sign', '--action-scope', 'forge:tests:run', '--repository', REPOSITORY, '--project', PROJECT_ID, '--expires-at', futureExpiry(), '--key', ws.keyPath, '--yes'],
      ['sign-decision', '--pre-sign', '--action-scope', 'merge:import-shadow', '--project', PROJECT_ID, '--expires-at', futureExpiry(), '--key', ws.keyPath, '--yes'],
      ['sign-decision', '--pre-sign', '--action-scope', 'merge:import-shadow', '--repository', REPOSITORY, '--expires-at', futureExpiry(), '--key', ws.keyPath, '--yes'],
      ['sign-decision', '--pre-sign', '--action-scope', 'merge:import-shadow', '--repository', REPOSITORY, '--project', PROJECT_ID, '--key', ws.keyPath, '--yes'],
      ['sign-decision', '--pre-sign', '--action-scope', 'merge:import-shadow', '--repository', REPOSITORY, '--project', PROJECT_ID, '--expires-at', futureExpiry(), '--yes'],
      ['sign-decision', '--pre-sign', '--action-scope', 'merge:import-shadow', '--repository', 'not-a-repo', '--project', PROJECT_ID, '--expires-at', futureExpiry(), '--key', ws.keyPath, '--yes'],
      ['sign-decision', '--pre-sign', '--action-scope', 'merge:import-shadow', '--repository', REPOSITORY, '--project', PROJECT_ID, '--expires-at', 'not-a-date', '--key', ws.keyPath, '--yes'],
    ]) {
      const result = await runCoordination(runtime, args, ws.stateDir);
      expect(result.code).toBe(2);
    }
    expect(decisionFiles(ws.stateDir)).toEqual([]);
  });

  it('prints the non-secret coordinates and refuses without --yes, reading no key', async () => {
    const ws = workspace();
    const runtime = runtimeFor(ws.stateDir, ws.publicBase64);
    const expiresAtIso = futureExpiry();
    // A nonexistent key path proves no key is read on the preview path.
    const refused = await runCoordination(
      runtime,
      preSignArgs(expiresAtIso, ['--key', join(ws.keyDir, 'absent.pem')]),
      ws.stateDir,
    );
    expect(refused.code).toBe(1);
    const doc = parseDocument(refused.stdout);
    expect(doc['reason']).toBe('yes-required');
    expect(doc['actionScope']).toBe('merge:import-shadow');
    expect(doc['projectId']).toBe(PROJECT_ID);
    expect(doc['repository']).toEqual({ owner: 'octo', repo: 'repo' });
    expect(doc['expiresAtIso']).toBe(expiresAtIso);
    expect(String(doc['requestId'])).toMatch(/^shadow-import-/);
    expect(String(doc['grantId'])).toMatch(/^shadow-import-grant-/);
    expect(decisionFiles(ws.stateDir)).toEqual([]);
  });

  it('refuses state-dir-required without a state directory', async () => {
    const ws = workspace();
    const runtime = runtimeFor(undefined, ws.publicBase64);
    const refused = await runCoordination(
      runtime,
      preSignArgs(futureExpiry(), ['--key', ws.keyPath, '--yes']),
      '',
    );
    expect(refused.code).toBe(1);
    expect(parseDocument(refused.stdout)['reason']).toBe('state-dir-required');
  });
});
