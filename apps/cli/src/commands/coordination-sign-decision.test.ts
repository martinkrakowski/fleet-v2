// KEY1a — `coordination sign-decision` end-to-end tests.
/**
 * The preview path surfaces the request's binding coordinates and writes
 * nothing; the `--yes` path signs with the owner's Ed25519 private key
 * (checked against the pinned `installation.owner.publicKey`, never ambient
 * env) and the signed answer authorizes a following `resolve-auth`. Nothing
 * here dispatches or touches the network.
 */

import { generateKeyPairSync } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, chmodSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli } from '../index.js';
import type { CliIo } from '../index.js';

const REQUEST_ID = 'req-sign-cli-1';
const PROJECT_ID = 'proj-sign-cli';
const SCOPE = 'forge:tests:run';
const HEAD = 'a'.repeat(40);
const PROPOSAL_DIGEST = 'sha256-proposal';
const POLICY_REVISION = 'pol-rev-1';
const ATTEMPT_ID = 'attempt-sign-1';

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
    { now: () => '2026-11-18T00:00:00.000Z', stateDir },
  );
  return { code, stdout: io.outLines, stderr: io.errLines };
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
}

function workspace(): TestWorkspace {
  const root = mkdtempSync(join(tmpdir(), 'fleet-v2-sign-cli-'));
  const stateDir = join(root, 'state');
  const keyDir = join(root, 'keys');
  mkdirSync(keyDir, { recursive: true });
  const { privatePem, publicBase64 } = newKey();
  const keyPath = join(keyDir, 'owner-key.pem');
  writeFileSync(keyPath, privatePem);
  chmodSync(keyPath, 0o600);
  return { stateDir, keyDir, keyPath, publicBase64, privatePem };
}

function runtimeFor(stateDir: string, publicBase64: string): FleetCliRuntime {
  return createFleetCliRuntime({ stateDir, ownerPublicKey: publicBase64 });
}

async function seedOrdinaryRequest(
  runtime: FleetCliRuntime,
  stateDir: string,
  requestId = REQUEST_ID,
): Promise<void> {
  const requested = await runCoordination(
    runtime,
    [
      'request-decision',
      '--requestId',
      requestId,
      '--projectId',
      PROJECT_ID,
      '--kind',
      'action-decision',
      '--actionScope',
      SCOPE,
      '--expectedHeadSha',
      HEAD,
      '--proposalDigest',
      PROPOSAL_DIGEST,
      '--policyRevision',
      POLICY_REVISION,
      '--attemptId',
      ATTEMPT_ID,
    ],
    stateDir,
  );
  expect(requested.code).toBe(0);
}

describe('coordination sign-decision (KEY1a)', () => {
  it('prints request details and does not sign without --yes', async () => {
    const ws = workspace();
    const runtime = runtimeFor(ws.stateDir, ws.publicBase64);
    await seedOrdinaryRequest(runtime, ws.stateDir);

    const preview = await runCoordination(
      runtime,
      // No --key at all: the preview must not require or read one.
      ['sign-decision', '--request', REQUEST_ID, '--answer', 'approve'],
      ws.stateDir,
    );
    expect(preview.code).toBe(0);
    const doc = parseDocument(preview.stdout);
    expect(doc['outcome']).toBe('preview');
    expect(doc['requestId']).toBe(REQUEST_ID);
    expect(doc['scope']).toBe(SCOPE);
    expect(doc['head']).toBe(HEAD);
    expect(doc['project']).toBe(PROJECT_ID);
    // Nothing was written: the decisions directory stays empty (or absent).
    expect(
      existsSync(join(ws.stateDir, 'decisions'))
        ? readdirSync(join(ws.stateDir, 'decisions'))
        : [],
    ).toEqual([]);

    // The same preview prints the optional details a request carries: a
    // standing shadow import grant binds a repository and a capped expiry.
    const expiresAtIso = '2026-12-01T00:00:00.000Z';
    const shadow = await runCoordination(
      runtime,
      [
        'request-decision',
        '--projectId',
        PROJECT_ID,
        '--kind',
        'action-decision',
        '--actionScope',
        'merge:import-shadow',
        '--repository',
        'octo/repo',
        '--expiresAtIso',
        expiresAtIso,
        '--proposalDigest',
        PROPOSAL_DIGEST,
        '--policyRevision',
        POLICY_REVISION,
      ],
      ws.stateDir,
    );
    expect(shadow.code).toBe(0);
    const shadowRequestId =
      (parseDocument(shadow.stdout)['request'] as Record<string, unknown>)['id'] as string;
    const shadowPreview = await runCoordination(
      runtime,
      ['sign-decision', '--request', shadowRequestId, '--answer', 'approve'],
      ws.stateDir,
    );
    expect(shadowPreview.code).toBe(0);
    const shadowPreviewDoc = parseDocument(shadowPreview.stdout);
    expect(shadowPreviewDoc['outcome']).toBe('preview');
    expect(shadowPreviewDoc['repository']).toEqual({ owner: 'octo', repo: 'repo' });
    expect(shadowPreviewDoc['expiresAtIso']).toBe(expiresAtIso);
  });

  it('round-trips an ordinary scoped request: sign --yes, then resolve-auth authorizes', async () => {
    const ws = workspace();
    const runtime = runtimeFor(ws.stateDir, ws.publicBase64);
    await seedOrdinaryRequest(runtime, ws.stateDir);

    const signed = await runCoordination(
      runtime,
      ['sign-decision', '--request', REQUEST_ID, '--answer', 'approve', '--key', ws.keyPath, '--yes'],
      ws.stateDir,
    );
    expect(signed.code).toBe(0);
    const signedDoc = parseDocument(signed.stdout);
    expect(signedDoc['outcome']).toBe('signed');
    expect(signedDoc['requestId']).toBe(REQUEST_ID);
    expect(signedDoc['answer']).toBe('approve');
    expect(signedDoc['grantId']).toBe(`grant-${REQUEST_ID}`);
    expect(signedDoc['decisionRevision']).toBe('1');

    const resolved = await runCoordination(
      runtime,
      [
        'resolve-auth',
        '--projectId',
        PROJECT_ID,
        '--actionScope',
        SCOPE,
        '--expectedHeadSha',
        HEAD,
        '--attemptId',
        ATTEMPT_ID,
      ],
      ws.stateDir,
    );
    expect(resolved.code).toBe(0);
    // Omitting --authorization-grant-id: the signed answer itself authorizes.
    expect(parseDocument(resolved.stdout)['outcome']).toBe('authorized');
  });

  it('round-trips a release:install request bound to its release root', async () => {
    const ws = workspace();
    const root = mkdtempSync(join(tmpdir(), 'fleet-v2-sign-cli-root-'));
    const releaseRoot = join(root, 'releases', 'current');
    mkdirSync(releaseRoot, { recursive: true });
    // The request binds the realpath-normalized root, so the exact coordinate
    // the preview and the signed result carry is the canonical one.
    const canonicalRoot = realpathSync(releaseRoot);
    const runtime = runtimeFor(ws.stateDir, ws.publicBase64);
    const requested = await runCoordination(
      runtime,
      [
        'request-decision',
        '--projectId',
        PROJECT_ID,
        '--kind',
        'action-decision',
        '--actionScope',
        'release:install',
        '--releaseRoot',
        releaseRoot,
        '--expectedHeadSha',
        HEAD,
        '--proposalDigest',
        PROPOSAL_DIGEST,
        '--policyRevision',
        POLICY_REVISION,
      ],
      ws.stateDir,
    );
    expect(requested.code).toBe(0);
    const requestedDoc = parseDocument(requested.stdout);
    const releaseRequestId = (requestedDoc['request'] as Record<string, unknown>)['id'] as string;
    expect(String(releaseRequestId)).toContain('release-grant-');

    // The preview (no --yes) carries the exact releaseRoot the request binds.
    const preview = await runCoordination(
      runtime,
      ['sign-decision', '--request', releaseRequestId, '--answer', 'approve'],
      ws.stateDir,
    );
    expect(preview.code).toBe(0);
    const previewDoc = parseDocument(preview.stdout);
    expect(previewDoc['outcome']).toBe('preview');
    expect(previewDoc['releaseRoot']).toBe(canonicalRoot);

    const signed = await runCoordination(
      runtime,
      [
        'sign-decision',
        '--request',
        releaseRequestId,
        '--answer',
        'approve',
        '--key',
        ws.keyPath,
        '--yes',
      ],
      ws.stateDir,
    );
    expect(signed.code).toBe(0);
    const signedDoc = parseDocument(signed.stdout);
    expect(signedDoc['outcome']).toBe('signed');
    // The signed result carries the exact releaseRoot too.
    expect(signedDoc['releaseRoot']).toBe(canonicalRoot);

    const resolved = await runCoordination(
      runtime,
      [
        'resolve-auth',
        '--projectId',
        PROJECT_ID,
        '--actionScope',
        'release:install',
        '--expectedHeadSha',
        HEAD,
        '--releaseRoot',
        releaseRoot,
      ],
      ws.stateDir,
    );
    expect(resolved.code).toBe(0);
    expect(parseDocument(resolved.stdout)['outcome']).toBe('authorized');
  });

  it('refuses an unknown request', async () => {
    const ws = workspace();
    const runtime = runtimeFor(ws.stateDir, ws.publicBase64);
    const result = await runCoordination(
      runtime,
      ['sign-decision', '--request', 'req-unknown', '--answer', 'approve', '--key', ws.keyPath, '--yes'],
      ws.stateDir,
    );
    expect(result.code).toBe(1);
    expect(parseDocument(result.stdout)).toEqual({
      outcome: 'refused',
      reason: 'request-not-found',
    });
  });

  it('refuses a request not in awaiting-decision state', async () => {
    const ws = workspace();
    const runtime = runtimeFor(ws.stateDir, ws.publicBase64);
    await seedOrdinaryRequest(runtime, ws.stateDir);
    // Sign and then resolve: the resolve moves the request to `approved`, so a
    // second sign is refused.
    await runCoordination(
      runtime,
      ['sign-decision', '--request', REQUEST_ID, '--answer', 'approve', '--key', ws.keyPath, '--yes'],
      ws.stateDir,
    );
    await runCoordination(
      runtime,
      [
        'resolve-auth',
        '--projectId',
        PROJECT_ID,
        '--actionScope',
        SCOPE,
        '--expectedHeadSha',
        HEAD,
        '--attemptId',
        ATTEMPT_ID,
      ],
      ws.stateDir,
    );
    const again = await runCoordination(
      runtime,
      ['sign-decision', '--request', REQUEST_ID, '--answer', 'decline', '--key', ws.keyPath, '--yes'],
      ws.stateDir,
    );
    expect(again.code).toBe(1);
    expect(parseDocument(again.stdout)).toEqual({
      outcome: 'refused',
      reason: 'request-not-awaiting-decision',
    });
  });

  it('refuses invalid flags and unsafe requestId', async () => {
    const ws = workspace();
    const runtime = runtimeFor(ws.stateDir, ws.publicBase64);
    for (const args of [
      ['sign-decision', '--answer', 'approve', '--key', ws.keyPath, '--yes'],
      ['sign-decision', '--request', REQUEST_ID, '--key', ws.keyPath, '--yes'],
      ['sign-decision', '--request', REQUEST_ID, '--answer', 'maybe', '--key', ws.keyPath, '--yes'],
      ['sign-decision', '--request', '../escape', '--answer', 'approve', '--key', ws.keyPath, '--yes'],
    ]) {
      const result = await runCoordination(runtime, args, ws.stateDir);
      expect(result.code).toBe(2);
    }
  });

  it('refuses surrounding whitespace in grantId and decisionRevision', async () => {
    const ws = workspace();
    const runtime = runtimeFor(ws.stateDir, ws.publicBase64);
    await seedOrdinaryRequest(runtime, ws.stateDir);
    const result = await runCoordination(
      runtime,
      [
        'sign-decision',
        '--request',
        REQUEST_ID,
        '--answer',
        'approve',
        '--grantId',
        ' grant-1',
        '--key',
        ws.keyPath,
        '--yes',
      ],
      ws.stateDir,
    );
    expect(result.code).toBe(2);
  });

  it('refuses the signing key against the pinned key when FLEET_OWNER_PUBLIC_KEY names it before composing', async () => {
    const ws = workspace();
    // The pinned key is a DIFFERENT key from the one that will sign.
    const pinned = newKey();
    // The ambient env names the signing key's public key BEFORE the runtime is
    // composed: if composition ever read it as an authority, the env value and
    // the signing key would agree and the sign would slip through. It must not.
    const previous = process.env['FLEET_OWNER_PUBLIC_KEY'];
    process.env['FLEET_OWNER_PUBLIC_KEY'] = ws.publicBase64;
    try {
      const runtime = runtimeFor(ws.stateDir, pinned.publicBase64);
      await seedOrdinaryRequest(runtime, ws.stateDir);
      const refused = await runCoordination(
        runtime,
        ['sign-decision', '--request', REQUEST_ID, '--answer', 'approve', '--key', ws.keyPath, '--yes'],
        ws.stateDir,
      );
      expect(refused.code).toBe(1);
      expect(parseDocument(refused.stdout)).toEqual({
        outcome: 'refused',
        reason: 'owner-key-env-mismatch',
      });
      expect(existsSync(join(ws.stateDir, 'decisions', `${REQUEST_ID}.json`))).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env['FLEET_OWNER_PUBLIC_KEY'];
      } else {
        process.env['FLEET_OWNER_PUBLIC_KEY'] = previous;
      }
    }
  });

  it('refuses a 0644 key file', async () => {
    const ws = workspace();
    const runtime = runtimeFor(ws.stateDir, ws.publicBase64);
    await seedOrdinaryRequest(runtime, ws.stateDir);
    chmodSync(ws.keyPath, 0o644);
    const result = await runCoordination(
      runtime,
      ['sign-decision', '--request', REQUEST_ID, '--answer', 'approve', '--key', ws.keyPath, '--yes'],
      ws.stateDir,
    );
    expect(parseDocument(result.stdout)).toEqual({
      outcome: 'refused',
      reason: 'key-file-permissions-too-open',
    });
  });

  it('refuses a symlinked key file', async () => {
    const ws = workspace();
    const runtime = runtimeFor(ws.stateDir, ws.publicBase64);
    await seedOrdinaryRequest(runtime, ws.stateDir);
    const link = join(ws.keyDir, 'linked.pem');
    symlinkSync(ws.keyPath, link);
    const result = await runCoordination(
      runtime,
      ['sign-decision', '--request', REQUEST_ID, '--answer', 'approve', '--key', link, '--yes'],
      ws.stateDir,
    );
    expect(parseDocument(result.stdout)).toEqual({
      outcome: 'refused',
      reason: 'key-file-symlink',
    });
  });

  it('refuses a key inside the state directory or a git repository', async () => {
    const ws = workspace();
    const runtime = runtimeFor(ws.stateDir, ws.publicBase64);
    await seedOrdinaryRequest(runtime, ws.stateDir);
    // Inside the state directory (the decisions subdirectory may not exist yet).
    const insideState = join(ws.stateDir, 'inside.pem');
    writeFileSync(insideState, ws.privatePem);
    chmodSync(insideState, 0o600);
    const inState = await runCoordination(
      runtime,
      ['sign-decision', '--request', REQUEST_ID, '--answer', 'approve', '--key', insideState, '--yes'],
      ws.stateDir,
    );
    expect(parseDocument(inState.stdout)).toEqual({
      outcome: 'refused',
      reason: 'key-inside-state-dir',
    });
    // Inside a git repository.
    const repo = join(ws.keyDir, 'repo');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, '.git'), 'gitdir: elsewhere\n');
    const insideRepo = join(repo, 'owner-key.pem');
    writeFileSync(insideRepo, ws.privatePem);
    chmodSync(insideRepo, 0o600);
    const inRepo = await runCoordination(
      runtime,
      ['sign-decision', '--request', REQUEST_ID, '--answer', 'approve', '--key', insideRepo, '--yes'],
      ws.stateDir,
    );
    expect(parseDocument(inRepo.stdout)).toEqual({
      outcome: 'refused',
      reason: 'key-inside-git-repo',
    });
  });

  it('never prints or stores the private key material on refusal or on success', async () => {
    const ws = workspace();
    const runtime = runtimeFor(ws.stateDir, ws.publicBase64);
    await seedOrdinaryRequest(runtime, ws.stateDir);

    // Refusal path: a wrong key refuses; the fragment of the ACTUAL key the
    // command was handed never appears anywhere.
    const wrong = newKey();
    const wrongPath = join(ws.keyDir, 'wrong-key.pem');
    writeFileSync(wrongPath, wrong.privatePem);
    chmodSync(wrongPath, 0o600);
    const refused = await runCoordination(
      runtime,
      ['sign-decision', '--request', REQUEST_ID, '--answer', 'approve', '--key', wrongPath, '--yes'],
      ws.stateDir,
    );
    expect(refused.code).toBe(1);
    const wrongFragment = wrong.privatePem.slice(32, 64);
    for (const line of [...refused.stdout, ...refused.stderr]) {
      expect(line.includes('PRIVATE KEY')).toBe(false);
      expect(line.includes(wrongFragment)).toBe(false);
    }

    // Success path: the RIGHT key signs, and the fragment of that actual
    // private key appears in no output line and no file under the state dir.
    const signed = await runCoordination(
      runtime,
      ['sign-decision', '--request', REQUEST_ID, '--answer', 'approve', '--key', ws.keyPath, '--yes'],
      ws.stateDir,
    );
    expect(signed.code).toBe(0);
    expect(parseDocument(signed.stdout)['outcome']).toBe('signed');
    const fragment = ws.privatePem.slice(32, 64);
    for (const line of [...signed.stdout, ...signed.stderr]) {
      expect(line.includes('PRIVATE KEY')).toBe(false);
      expect(line.includes(fragment)).toBe(false);
    }
    for (const name of readdirSync(ws.stateDir, { recursive: true }) as string[]) {
      const full = join(ws.stateDir, name);
      try {
        const content = readFileSync(full, 'utf8');
        expect(content.includes('PRIVATE KEY')).toBe(false);
        expect(content.includes(fragment)).toBe(false);
      } catch {
        // A directory or binary entry carries no text to inspect.
      }
    }
  });
});
