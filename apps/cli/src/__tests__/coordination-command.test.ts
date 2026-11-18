// Coordination command tests — GR1a2.
/**
 * `coordination request-decision` derives the shadow import grant's request
 * id from its coordinates and refuses a mismatching hand-typed one;
 * `coordination revoke-grant` revokes the standing grant by its non-secret
 * handle. Nothing here dispatches or touches the network.
 */

import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SHADOW_IMPORT_ACTION_SCOPE } from '@fleet/operator-coordination';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli } from '../index.js';
import type { CliIo } from '../index.js';

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

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'fleet-v2-coordination-test-'));
}

/** Run one CLI invocation and return its exit code and output lines. */
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
    { now: () => '2026-11-18T10:00:00.000Z', stateDir },
  );
  return { code, stdout: io.outLines, stderr: io.errLines };
}

function parseDocument(lines: readonly string[]): Record<string, unknown> {
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

/** An expiry 28 days out: inside the 30-day TTL cap from the run instant. */
function futureExpiry(): string {
  return new Date(Date.now() + 28 * 86_400_000).toISOString();
}

function derivedRequestId(expiresAtIso: string): string {
  const payload = JSON.stringify({
    scope: SHADOW_IMPORT_ACTION_SCOPE,
    owner: 'octo',
    repo: 'hello',
    expiresAtIso,
  });
  return `shadow-import-${createHash('sha256').update(payload).digest('hex')}`;
}

describe('coordination request-decision and revoke-grant (GR1a2)', () => {
  it('derives the request id from the grant coordinates when none is supplied', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const expiresAtIso = futureExpiry();
    const requestId = derivedRequestId(expiresAtIso);
    const recorded = await runCoordination(
      runtime,
      [
        'request-decision',
        '--project-id', 'proj-alpha',
        '--kind', 'action-decision',
        '--action-scope', SHADOW_IMPORT_ACTION_SCOPE,
        '--proposal-digest', 'sha256-proposal',
        '--policy-revision', 'pol-rev-1',
        '--repository', 'octo/hello',
        '--expires-at-iso', expiresAtIso,
      ],
      stateDir,
    );
    expect(recorded.code).toBe(0);
    const doc = parseDocument(recorded.stdout);
    expect((doc.request as Record<string, unknown>).id).toBe(requestId);
    expect((doc.request as Record<string, unknown>).expectedHeadSha).toBeNull();
  });

  it('refuses a hand-typed requestId that does not match the derived id (non-zero exit)', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const refused = await runCoordination(
      runtime,
      [
        'request-decision',
        '--request-id', 'hand-typed-request-id',
        '--project-id', 'proj-alpha',
        '--kind', 'action-decision',
        '--action-scope', SHADOW_IMPORT_ACTION_SCOPE,
        '--proposal-digest', 'sha256-proposal',
        '--policy-revision', 'pol-rev-1',
        '--repository', 'octo/hello',
        '--expires-at-iso', futureExpiry(),
      ],
      stateDir,
    );
    expect(refused.code).not.toBe(0);
  });

  it('refuses revoke-grant on a missing grant with a typed refused result (exit 1)', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const refused = await runCoordination(runtime, ['revoke-grant', '--grant-id', 'grant-nope'], stateDir);
    expect(refused.code).toBe(1);
    const doc = parseDocument(refused.stdout);
    expect(doc.outcome).toBe('refused');
    expect(doc.reason).toBe('grant-missing');
  });

  it('runs the documented head-free resolve-auth command end to end', async () => {
    const stateDir = tempStateDir();
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const ownerPublicKey = publicKey
      .export({ format: 'der', type: 'spki' })
      .subarray(12)
      .toString('base64');
    const runtime = createFleetCliRuntime({ stateDir, ownerPublicKey });
    const expiresAtIso = futureExpiry();
    const requestId = derivedRequestId(expiresAtIso);
    const grantId = 'grant-shadow-e2e';
    const decisionRevision = 'rev-e2e-1';
    // The owner's signed approval is in place before the decision is asked,
    // so `request-decision` records the request and binds the answer's grant
    // in one call, exactly as an owner's pre-recorded answer would.
    const bytes = Buffer.from(
      JSON.stringify({
        requestId,
        projectId: 'proj-alpha',
        actionScope: SHADOW_IMPORT_ACTION_SCOPE,
        expectedHeadSha: null,
        decisionRevision,
        grantId,
        state: 'approved',
      }),
      'utf8',
    );
    const signature = sign(null, bytes, privateKey).toString('base64');
    mkdirSync(join(stateDir, 'decisions'), { recursive: true });
    writeFileSync(
      join(stateDir, 'decisions', `${requestId}.json`),
      JSON.stringify({ state: 'approved', decisionRevision, grantId, signature }),
    );
    const recorded = await runCoordination(
      runtime,
      [
        'request-decision',
        '--project-id', 'proj-alpha',
        '--kind', 'action-decision',
        '--action-scope', SHADOW_IMPORT_ACTION_SCOPE,
        '--proposal-digest', 'sha256-proposal',
        '--policy-revision', 'pol-rev-1',
        '--repository', 'octo/hello',
        '--expires-at-iso', expiresAtIso,
      ],
      stateDir,
    );
    expect(recorded.code).toBe(0);
    const decided = parseDocument(recorded.stdout);
    expect((decided.request as Record<string, unknown>).state).toBe('approved');
    expect((decided.request as Record<string, unknown>).grantId).toBe(grantId);

    // The documented command (cutover runbook): project, scope, grant id and
    // repository — no `--expected-head-sha` is taken.
    const resolved = await runCoordination(
      runtime,
      [
        'resolve-auth',
        '--project-id', 'proj-alpha',
        '--action-scope', SHADOW_IMPORT_ACTION_SCOPE,
        '--authorization-grant-id', grantId,
        '--repository', 'octo/hello',
      ],
      stateDir,
    );
    expect(resolved.code).toBe(0);
    const doc = parseDocument(resolved.stdout);
    expect(doc.outcome).toBe('authorized');
    expect(doc.grantId).toBe(grantId);
    expect(doc.requestId).toBe(requestId);
    expect(doc.expectedHeadSha).toBe('');
  });

  it('keeps the head requirement for a non-shadow resolve-auth scope', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const refused = await runCoordination(
      runtime,
      [
        'resolve-auth',
        '--project-id', 'proj-alpha',
        '--action-scope', 'forge:merge-pr',
        '--authorization-grant-id', 'grant-1',
        '--repository', 'octo/hello',
      ],
      stateDir,
    );
    expect(refused.code).not.toBe(0);
  });

  it('never resolves a non-shadow scope head-free (host:restart without a head, GR1a2 fix round)', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const refused = await runCoordination(
      runtime,
      [
        'resolve-auth',
        '--project-id', 'proj-alpha',
        '--action-scope', 'host:restart',
        '--authorization-grant-id', 'grant-1',
        '--repository', 'octo/hello',
      ],
      stateDir,
    );
    // Main throws 'Not implemented' for the missing head, so the error reaches
    // stderr and nothing is printed as a resolve result. If the head-free
    // branch were applied to every scope, this resolve would come back as a
    // typed (or even authorized) result on stdout instead — never allowed.
    expect(refused.code).not.toBe(0);
    expect(refused.stderr.join('\n')).toContain(
      'Not implemented: ResolveActionAuthorizationUseCase',
    );
    expect(refused.stdout.join('\n')).not.toContain('"authorized"');
  });

  it('refuses a hostile repository value on request-decision (non-zero exit, no throw)', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const refused = await runCoordination(
      runtime,
      [
        'request-decision',
        '--project-id', 'proj-alpha',
        '--kind', 'action-decision',
        '--action-scope', SHADOW_IMPORT_ACTION_SCOPE,
        '--proposal-digest', 'sha256-proposal',
        '--policy-revision', 'pol-rev-1',
        '--repository', 'octo//hello',
        '--expires-at-iso', futureExpiry(),
      ],
      stateDir,
    );
    expect(refused.code).not.toBe(0);
    expect(refused.stderr.join('\n')).toContain('--repository');
  });

  it('refuses a non-instant expires-at-iso on request-decision (non-zero exit, no throw)', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const refused = await runCoordination(
      runtime,
      [
        'request-decision',
        '--project-id', 'proj-alpha',
        '--kind', 'action-decision',
        '--action-scope', SHADOW_IMPORT_ACTION_SCOPE,
        '--proposal-digest', 'sha256-proposal',
        '--policy-revision', 'pol-rev-1',
        '--repository', 'octo/hello',
        '--expires-at-iso', 'not-an-instant',
      ],
      stateDir,
    );
    expect(refused.code).not.toBe(0);
  });

  it('resolves a hostile repository on shadow resolve-auth to a typed blocked result', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const blocked = await runCoordination(
      runtime,
      [
        'resolve-auth',
        '--project-id', 'proj-alpha',
        '--action-scope', SHADOW_IMPORT_ACTION_SCOPE,
        '--authorization-grant-id', 'grant-shadow-hostile',
        '--repository', 'no-segment',
      ],
      stateDir,
    );
    expect(blocked.code).toBe(1);
    const doc = parseDocument(blocked.stdout);
    expect(doc.outcome).toBe('blocked');
    expect(doc.reason).toBe('grant-wrong-repository');
  });

  it('refuses revoke-grant with an empty grant id as a typed refused result (exit 1)', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const refused = await runCoordination(runtime, ['revoke-grant', '--grant-id', ''], stateDir);
    expect(refused.code).toBe(1);
    const doc = parseDocument(refused.stdout);
    expect(doc.outcome).toBe('refused');
  });
});
