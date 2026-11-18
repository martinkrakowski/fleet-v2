/**
 * RR1: `releaseRoot` is forwarded and digest-bound for release grants.
 *
 * `coordination request-decision --action-scope release:install --release-root <path>`
 * derives the request id from the grant's exact coordinates ({ scope,
 * projectId, expectedHeadSha, releaseRoot, nonce }; the nonce is random per
 * request, so the id is read back from the recorded request), requires and normalizes the root
 * through `realpath` exactly like `release.ts`, and refuses `--release-root`
 * on every non-release scope. `release install --apply` passes the
 * realpath-resolved root to the grant resolution, so a grant bound to one root
 * never authorizes an install on another (`release-grant-root-mismatch`).
 *
 * The matching case reaches the AUTHORIZED outcome: the owner's Ed25519-signed
 * approval covers the digest-bound request id (the signature's own fields do
 * not name the root), the recorded grant resolves for its root through the
 * same authorization port `ManageReleaseUseCase` uses, and its consumption is
 * recorded once. Nothing here dispatches or touches the network.
 */

import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { RELEASE_GRANT_DIGEST_PREFIX } from '@fleet/operator-coordination';

import { createFleetCliRuntime, type FleetCliRuntime } from './composition.js';
import { runCli } from './index.js';
import type { CliIo } from './index.js';
import { releaseAuthorization } from './release.js';

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

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Existing roots are realpath-normalized by the CLI; mkdtemp paths already are. */
function realRootOf(path: string): string {
  return realpathSync(path);
}

function parseDocument(lines: readonly string[]): Record<string, unknown> {
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

const SHA = 'a'.repeat(40);
const PROJECT = 'proj-release';
const PROPOSAL_DIGEST = 'sha256-proposal';
const POLICY_REVISION = 'pol-rev-1';

/**
 * The digest-bound id of a recorded release request, recomputed from its
 * recorded coordinates including the per-request nonce the CLI generated.
 */
function recomputedRequestId(request: Record<string, unknown>): string {
  const payload = JSON.stringify({
    scope: request.actionScope,
    projectId: request.projectId,
    expectedHeadSha: request.expectedHeadSha,
    releaseRoot: request.releaseRoot,
    nonce: request.releaseNonce,
  });
  return `${RELEASE_GRANT_DIGEST_PREFIX}${createHash('sha256').update(payload).digest('hex')}`;
}

/** A runtime whose installation serves `root` through `daemon.cliPath`. */
function runtimeServingRoot(root: string, stateDir: string, ownerPublicKey: string): FleetCliRuntime {
  return createFleetCliRuntime({
    stateDir,
    ownerPublicKey,
    installation: {
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: {},
      daemon: {
        nodePath: '/usr/bin/node',
        cliPath: `${root}/current/apps/cli/dist/bin.js`,
        stateDir,
        unitDir: join(stateDir, 'units'),
        installationFile: join(stateDir, 'fleet.json'),
      },
    } as never,
  });
}

async function runArgs(
  runtime: FleetCliRuntime,
  args: readonly string[],
): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  const io = captureIo();
  const code = await runCli(args, io, runtime);
  return { code, stdout: io.outLines, stderr: io.errLines };
}

/** An owner keypair whose public key is the raw 32-byte base64 the verifier expects. */
function ownerKeys(): { ownerPublicKey: string; privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'] } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    ownerPublicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64'),
    privateKey,
  };
}

/** The owner's signed approval over `canonicalDecisionBytes` (DecisionSignature.adapter). */
function signedDecision(requestId: string, grantId: string, privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']): string {
  const bytes = Buffer.from(
    JSON.stringify({
      requestId,
      projectId: PROJECT,
      actionScope: 'release:install',
      expectedHeadSha: SHA,
      decisionRevision: 'dec-1',
      grantId,
      state: 'approved',
    }),
    'utf8',
  );
  return sign(null, bytes, privateKey).toString('base64');
}

function placeDecision(
  stateDir: string,
  requestId: string,
  grantId: string,
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
): void {
  mkdirSync(join(stateDir, 'decisions'), { recursive: true });
  writeFileSync(
    join(stateDir, 'decisions', `${requestId}.json`),
    JSON.stringify({
      state: 'approved',
      decisionRevision: 'dec-1',
      grantId,
      signature: signedDecision(requestId, grantId, privateKey),
    }),
  );
}

describe('release grants through the CLI (RR1)', () => {
  it('records a digest-bound release grant and reaches the AUTHORIZED outcome for its root', async () => {
    const stateDir = tempDir('rr1-round-state-');
    const rootDir = realRootOf(tempDir('rr1-round-root-'));
    const { ownerPublicKey, privateKey } = ownerKeys();
    const runtime = runtimeServingRoot(rootDir, stateDir, ownerPublicKey);
    const grantId = 'grant-rr1-round';
    // The request is recorded first (the nonce, hence the id, is the CLI's
    // own); the owner's signed approval over that id is then placed and read
    // back when the grant resolves.
    const recorded = await runArgs(runtime, [
      'coordination', 'request-decision',
      '--kind', 'action-decision',
      '--action-scope', 'release:install',
      '--project-id', PROJECT,
      '--expected-head-sha', SHA,
      '--proposal-digest', PROPOSAL_DIGEST,
      '--policy-revision', POLICY_REVISION,
      '--release-root', rootDir,
    ]);
    expect(recorded.stderr.join('')).toBe('');
    expect(recorded.code).toBe(0);
    const doc = parseDocument(recorded.stdout);
    const request = doc.request as Record<string, unknown>;
    const requestId = request.id as string;
    expect(request.releaseRoot).toBe(rootDir);
    expect(request.releaseNonce).toMatch(/^[0-9a-f]{32}$/);
    expect(requestId).toBe(recomputedRequestId(request));
    placeDecision(stateDir, requestId, grantId, privateKey);

    // The same authorization port `ManageReleaseUseCase` resolves through:
    // the matching root reaches AUTHORIZED, and the consumption of that
    // grant is recorded once.
    const authorization = releaseAuthorization(runtime);
    const resolved = await authorization.resolveActionAuthorization({
      actionId: `release-install-${SHA}`,
      projectId: PROJECT,
      workOrderId: 'w',
      attemptId: 'a',
      actionKind: 'release-install',
      expectedHeadSha: SHA,
      policyRevision: POLICY_REVISION,
      releaseRoot: rootDir,
    });
    expect(resolved.outcome).toBe('granted');
    if (resolved.outcome === 'granted') {
      expect(resolved.authorizationGrantId).toBe(grantId);
      expect(resolved.releaseRoot).toBe(rootDir);
    }
    const consumed = await authorization.consumeActionAuthorization({
      actionId: `release-install-${SHA}`,
      actionKind: 'release-install',
      expectedHeadSha: SHA,
      authorizationGrantId: grantId,
      releaseRoot: rootDir,
    });
    expect(consumed).toEqual({ outcome: 'consumed', actionId: `release-install-${SHA}` });
  });

  it('refuses an install on the configured root when the grant was recorded for another root', async () => {
    const stateDir = tempDir('rr1-mismatch-state-');
    const configuredRoot = realRootOf(tempDir('rr1-mismatch-configured-'));
    const otherRoot = realRootOf(tempDir('rr1-mismatch-other-'));
    const { ownerPublicKey, privateKey } = ownerKeys();
    const runtime = runtimeServingRoot(configuredRoot, stateDir, ownerPublicKey);
    // The grant is recorded for ANOTHER existing root.
    const recorded = await runArgs(runtime, [
      'coordination', 'request-decision',
      '--kind', 'action-decision',
      '--action-scope', 'release:install',
      '--project-id', PROJECT,
      '--expected-head-sha', SHA,
      '--proposal-digest', PROPOSAL_DIGEST,
      '--policy-revision', POLICY_REVISION,
      '--release-root', otherRoot,
    ]);
    expect(recorded.code).toBe(0);
    const requestId = (parseDocument(recorded.stdout).request as Record<string, unknown>).id as string;
    placeDecision(stateDir, requestId, 'grant-rr1-mismatch', privateKey);
    // The install names the configured root: the grant for the other root
    // never authorizes it.
    const install = await runArgs(runtime, [
      'release', 'install', '--apply',
      '--root', configuredRoot,
      '--sha', SHA,
      '--source', configuredRoot,
      '--project', PROJECT,
    ]);
    expect(install.stderr.join('')).toBe('');
    expect(install.code).toBe(1);
    expect(parseDocument(install.stdout)).toEqual({
      outcome: 'refused',
      reason: 'release-grant-root-mismatch',
    });
  });

  it('authorizes a release install through the REAL handler when --root is a symlink to the configured root', async () => {
    const stateDir = tempDir('rr1-symlink-state-');
    const rootDir = realRootOf(tempDir('rr1-symlink-root-'));
    const linkBase = realRootOf(tempDir('rr1-symlink-link-'));
    const link = join(linkBase, 'root-link');
    symlinkSync(rootDir, link);
    const { ownerPublicKey, privateKey } = ownerKeys();
    const runtime = runtimeServingRoot(rootDir, stateDir, ownerPublicKey);
    // The grant is requested by the symlink: the CLI normalizes it through
    // realpath, so the recorded root is the configured one.
    const recorded = await runArgs(runtime, [
      'coordination', 'request-decision',
      '--kind', 'action-decision',
      '--action-scope', 'release:install',
      '--project-id', PROJECT,
      '--expected-head-sha', SHA,
      '--proposal-digest', PROPOSAL_DIGEST,
      '--policy-revision', POLICY_REVISION,
      '--release-root', link,
    ]);
    expect(recorded.code).toBe(0);
    const request = parseDocument(recorded.stdout).request as Record<string, unknown>;
    expect(request.releaseRoot).toBe(rootDir);
    placeDecision(stateDir, request.id as string, 'grant-rr1-symlink', privateKey);
    // The install itself is driven by the symlink too. The real handler
    // resolves the symlink to the configured root, finds the grant recorded
    // for that root and consumes it. The stand-in source is not a repository,
    // so the build then fails: `build-failed-grant-spent` is the AUTHORIZED
    // outcome (the grant was granted and spent before the build ran), never
    // `release-grant-root-mismatch` or `authority-refused`.
    const install = await runArgs(runtime, [
      'release', 'install', '--apply',
      '--root', link,
      '--sha', SHA,
      '--source', rootDir,
      '--project', PROJECT,
    ]);
    expect(install.stderr.join('')).toBe('');
    expect(parseDocument(install.stdout)).toEqual({
      outcome: 'refused',
      reason: 'build-failed-grant-spent',
    });
  });

  it('refuses --release-root on a non-release scope with a usage error (exit 2)', async () => {
    const stateDir = tempDir('rr1-nonrelease-state-');
    const rootDir = realRootOf(tempDir('rr1-nonrelease-root-'));
    const { ownerPublicKey } = ownerKeys();
    const runtime = runtimeServingRoot(rootDir, stateDir, ownerPublicKey);
    const refused = await runArgs(runtime, [
      'coordination', 'request-decision',
      '--kind', 'action-decision',
      '--action-scope', 'forge:merge-pr',
      '--project-id', PROJECT,
      '--expected-head-sha', SHA,
      '--proposal-digest', PROPOSAL_DIGEST,
      '--policy-revision', POLICY_REVISION,
      '--attempt-id', 'att-1',
      '--release-root', rootDir,
    ]);
    expect(refused.code).toBe(2);
    expect(refused.stderr.join('')).toContain('--release-root is only allowed for release:* scopes');
  });

  it('refuses a release scope without --release-root with a usage error (exit 2)', async () => {
    const stateDir = tempDir('rr1-missing-root-state-');
    const { ownerPublicKey } = ownerKeys();
    const runtime = createFleetCliRuntime({ stateDir, ownerPublicKey });
    for (const actionScope of ['release:install', 'release:swap']) {
      const refused = await runArgs(runtime, [
        'coordination', 'request-decision',
        '--kind', 'action-decision',
        '--action-scope', actionScope,
        '--project-id', PROJECT,
        '--expected-head-sha', SHA,
        '--proposal-digest', PROPOSAL_DIGEST,
        '--policy-revision', POLICY_REVISION,
      ]);
      expect(refused.code).toBe(2);
      expect(refused.stderr.join('')).toContain('--release-root is required for release:* scopes');
    }
  });

  it('refuses an unresolvable --release-root with a usage error (exit 2), never echoing the path', async () => {
    const stateDir = tempDir('rr1-missing-dir-state-');
    const { ownerPublicKey } = ownerKeys();
    const runtime = createFleetCliRuntime({ stateDir, ownerPublicKey });
    const missingRoot = join(realRootOf(tempDir('rr1-missing-dir-base-')), 'does-not-exist');
    const refused = await runArgs(runtime, [
      'coordination', 'request-decision',
      '--kind', 'action-decision',
      '--action-scope', 'release:install',
      '--project-id', PROJECT,
      '--expected-head-sha', SHA,
      '--proposal-digest', PROPOSAL_DIGEST,
      '--policy-revision', POLICY_REVISION,
      '--release-root', missingRoot,
    ]);
    expect(refused.code).toBe(2);
    expect(refused.stderr.join('')).toContain('--release-root must resolve to an existing directory');
    expect(refused.stderr.join('')).not.toContain('does-not-exist');
  });

  it('refuses --release-root pointing at an existing regular file with a usage error (exit 2)', async () => {
    const stateDir = tempDir('rr1-regular-file-state-');
    const fileRoot = join(tempDir('rr1-regular-file-dir-'), 'release-root.txt');
    writeFileSync(fileRoot, 'not a directory\n');
    const { ownerPublicKey } = ownerKeys();
    const runtime = createFleetCliRuntime({ stateDir, ownerPublicKey });
    const refused = await runArgs(runtime, [
      'coordination', 'request-decision',
      '--kind', 'action-decision',
      '--action-scope', 'release:install',
      '--project-id', PROJECT,
      '--expected-head-sha', SHA,
      '--proposal-digest', PROPOSAL_DIGEST,
      '--policy-revision', POLICY_REVISION,
      '--release-root', fileRoot,
    ]);
    expect(refused.code).toBe(2);
    expect(refused.stderr.join('')).toContain('--release-root must resolve to an existing directory');
  });

  it("refuses a hand-typed --request-id that does not match the digest (exit 2)", async () => {
    const stateDir = tempDir('rr1-hand-typed-state-');
    const rootDir = realRootOf(tempDir('rr1-hand-typed-root-'));
    const { ownerPublicKey } = ownerKeys();
    const runtime = createFleetCliRuntime({ stateDir, ownerPublicKey });
    const refused = await runArgs(runtime, [
      'coordination', 'request-decision',
      '--kind', 'action-decision',
      '--action-scope', 'release:install',
      '--request-id', 'release-grant-hand-typed',
      '--project-id', PROJECT,
      '--expected-head-sha', SHA,
      '--proposal-digest', PROPOSAL_DIGEST,
      '--policy-revision', POLICY_REVISION,
      '--release-root', rootDir,
    ]);
    expect(refused.code).toBe(2);
    expect(refused.stderr.join('')).toContain("does not match the id derived from the grant's coordinates");
  });
});
