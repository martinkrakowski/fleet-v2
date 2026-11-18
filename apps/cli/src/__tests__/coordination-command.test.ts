// Coordination command tests — GR1a2.
/**
 * `coordination request-decision` derives the shadow import grant's request
 * id from its coordinates and refuses a mismatching hand-typed one;
 * `coordination revoke-grant` revokes the standing grant by its non-secret
 * handle. Nothing here dispatches or touches the network.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
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
  it('records a shadow import grant with its derived request id', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const expiresAtIso = futureExpiry();
    const requestId = derivedRequestId(expiresAtIso);
    const recorded = await runCoordination(
      runtime,
      [
        'request-decision',
        '--request-id', requestId,
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
});
