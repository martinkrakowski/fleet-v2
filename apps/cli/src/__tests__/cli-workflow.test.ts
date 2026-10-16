/**
 * End-to-end CLI workflow tests across all four bounded contexts.
 *
 * The suite drives `runCli` against a single composed runtime with a real
 * stateDir, real git worktrees and the real subprocess adapters. The two
 * reviewed subprocess boundaries (`ocm-run` and `gh`) are exercised through
 * stub scripts placed on PATH, so dispatch, reconciliation, collection and the
 * forge action run through the genuine adapter plumbing without touching live
 * hosts or credentials.
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  assessmentIdForAttempt,
  createFleetCliRuntime,
  type FleetCliRuntime,
} from '../composition.js';
import { runCli, type CliIo } from '../index.js';

/** Canonical decision bytes, written out here so the test pins the signed format independently. */
function canonicalDecisionBytes(fields: {
  requestId: string;
  projectId: string;
  actionScope: string;
  expectedHeadSha: string | null;
  decisionRevision: string | null;
  grantId: string | null;
  state: string;
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      requestId: fields.requestId,
      projectId: fields.projectId,
      actionScope: fields.actionScope,
      expectedHeadSha: fields.expectedHeadSha ?? null,
      decisionRevision: fields.decisionRevision ?? null,
      grantId: fields.grantId ?? null,
      state: fields.state,
    }),
    'utf8',
  );
}


const PROJECT_ID = 'proj-cli-1';
const WORK_ORDER_ID = 'wo-1';
const LANE_ID = 'lane-cli-1';
const ATTEMPT_ID = 'attempt-1';
const POLICY_REVISION = 'policy-1';
const SESSION_ID = 'ses_cli_workflow_1';

/** One CLI invocation: exit code, raw stdout text and captured stderr. */
interface Invocation {
  readonly code: number;
  readonly text: string;
  readonly stderr: string;
}

function jsonOf<T>(invocation: Invocation): T {
  return JSON.parse(invocation.text) as T;
}

describe('Fleet CLI workflow', () => {
  let runtime: FleetCliRuntime;
  let suiteDir: string;
  let binDir: string;
  let stateDir: string;
  let laneRepoDir: string;
  let briefRepoDir: string;
  let briefFilePath: string;
  let laneHead: string;
  let entryId: string;
  let briefDigest: string;
  let acceptanceReceiptId: string;
  let originalPath: string | undefined;
  let originalOcmRunBin: string | undefined;
  let testOwnerPublicKey: string;
  let testOwnerPrivateKey: KeyObject;
  let originalOwnerKey: string | undefined;

  function signDecisionForWorkflow(fields: {
    requestId: string;
    projectId: string;
    actionScope: string;
    expectedHeadSha: string | null;
    decisionRevision: string | null;
    grantId: string | null;
    state: string;
  }): string {
    return sign(null, canonicalDecisionBytes(fields), testOwnerPrivateKey).toString('base64');
  }

  beforeEach(() => {
    originalOwnerKey = process.env.FLEET_OWNER_PUBLIC_KEY;
    process.env.FLEET_OWNER_PUBLIC_KEY = testOwnerPublicKey;
  });

  afterEach(() => {
    if (originalOwnerKey !== undefined) {
      process.env.FLEET_OWNER_PUBLIC_KEY = originalOwnerKey;
    } else {
      delete process.env.FLEET_OWNER_PUBLIC_KEY;
    }
  });

  const cli = async (argv: readonly string[]): Promise<Invocation> => {
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = {
      stdout: (text) => {
        out.push(text);
      },
      stderr: (text) => {
        err.push(text);
      },
    };
    const code = await runCli([...argv], io, runtime);
    return { code, text: out.join(''), stderr: err.join('') };
  };

  const jsonArg = (payload: unknown): string => JSON.stringify(payload);

  function initGitRepo(dir: string, gitignore: readonly string[]): string {
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['-C', dir, 'init', '-q']);
    execFileSync('git', ['-C', dir, 'config', 'user.email', 'fleet@example.invalid']);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'Fleet CLI Test']);
    execFileSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
    writeFileSync(path.join(dir, 'README.md'), '# demo package\n');
    if (gitignore.length > 0) {
      writeFileSync(path.join(dir, '.gitignore'), `${gitignore.join('\n')}\n`);
    }
    execFileSync('git', ['-C', dir, 'add', '.']);
    execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  }

  beforeAll(() => {
    suiteDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-workflow-'));
    binDir = path.join(suiteDir, 'bin');
    stateDir = path.join(suiteDir, 'state');
    laneRepoDir = path.join(suiteDir, 'lane-repo');
    briefRepoDir = path.join(suiteDir, 'brief-repo');
    briefFilePath = path.join(suiteDir, 'handwritten-brief.md');
    mkdirSync(binDir);
    mkdirSync(stateDir);

    // Stub for the reviewed `ocm-run` runner subprocess: a detached start
    // reports a session id, --status reports an authoritative ended receipt,
    // and --abort confirms termination.
    writeFileSync(
      path.join(binDir, 'ocm-run'),
      [
        '#!/bin/sh',
        'for arg in "$@"; do',
        '  if [ "$arg" = "--status" ]; then',
        `    printf '%s\\n' '{"active":false,"endedAtIso":"2026-10-15T08:30:00.000Z","exitStatus":0,"artifactsCollected":true}'`,
        '    exit 0',
        '  fi',
        '  if [ "$arg" = "--abort" ]; then',
        '    exit 0',
        '  fi',
        'done',
        `printf '%s\\n' '{"sessionID":"${SESSION_ID}"}'`,
        'exit 0',
        '',
      ].join('\n'),
    );
    // Stub for the reviewed `gh` subprocess behind the forge adapter.
    writeFileSync(
      path.join(binDir, 'gh'),
      [
        '#!/bin/sh',
        `printf '%s\\n' 'https://github.com/org/repo/pull/123'`,
        'exit 0',
        '',
      ].join('\n'),
    );
    chmodSync(path.join(binDir, 'ocm-run'), 0o755);
    chmodSync(path.join(binDir, 'gh'), 0o755);
    originalPath = process.env.PATH;
    originalOcmRunBin = process.env.FLEET_OCM_RUN_BIN;
    process.env.FLEET_OCM_RUN_BIN = path.join(binDir, 'ocm-run');
    process.env.PATH = `${binDir}:${originalPath ?? ''}`;

    // The lane worktree stays pristine: it must match the base commit with no
    // untracked files and no earlier-attempt residue when dispatch inspects it.
    laneHead = initGitRepo(laneRepoDir, []);
    // The brief worktree ignores the frozen-brief targets and the expected
    // artifact path, which prepare-brief-package proves before placement.
    initGitRepo(briefRepoDir, ['.lane/', 'docs/demo-summary.md']);

    writeFileSync(
      briefFilePath,
      [
        '# Work order wo-1',
        '',
        'Run yarn lint and yarn build for the demo package, then summarize',
        'the result in docs/demo-summary.md.',
        '',
      ].join('\n'),
    );

    // Owner-recorded decision answers, read by the decision transport when a
    // scoped decision is requested. Only an approved answer with a recorded
    // grant authorizes anything.
    const { publicKey: pubKeyObj, privateKey: privKeyObj } = generateKeyPairSync('ed25519');
    testOwnerPublicKey = pubKeyObj.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
    testOwnerPrivateKey = privKeyObj;

    const decisionsDir = path.join(stateDir, 'decisions');
    mkdirSync(decisionsDir);
    const dec1Signature = signDecisionForWorkflow({
      requestId: 'dec-1',
      projectId: PROJECT_ID,
      actionScope: 'forge:merge-pr',
      expectedHeadSha: laneHead,
      decisionRevision: 'dec-1-r1',
      grantId: 'grant-1',
      state: 'approved',
    });
    writeFileSync(
      path.join(decisionsDir, 'dec-1.json'),
      `${JSON.stringify({ state: 'approved', decisionRevision: 'dec-1-r1', grantId: 'grant-1', signature: dec1Signature }, null, 2)}\n`,
    );
    const dec2Signature = signDecisionForWorkflow({
      requestId: 'dec-2',
      projectId: PROJECT_ID,
      actionScope: 'forge:push-and-open-pr',
      expectedHeadSha: laneHead,
      decisionRevision: 'dec-2-r1',
      grantId: 'grant-2',
      state: 'approved',
    });
    writeFileSync(
      path.join(decisionsDir, 'dec-2.json'),
      `${JSON.stringify({ state: 'approved', decisionRevision: 'dec-2-r1', grantId: 'grant-2', signature: dec2Signature }, null, 2)}\n`,
    );

    runtime = createFleetCliRuntime({
      stateDir,
      ocmRunBin: path.join(binDir, 'ocm-run'),
      ownerPublicKey: testOwnerPublicKey,
    });
  });

  afterAll(() => {
    if (originalPath !== undefined) {
      process.env.PATH = originalPath;
    }
    if (originalOcmRunBin !== undefined) {
      process.env.FLEET_OCM_RUN_BIN = originalOcmRunBin;
    } else {
      delete process.env.FLEET_OCM_RUN_BIN;
    }
    rmSync(suiteDir, { recursive: true, force: true });
  });

  it('walks the full four-context workflow from profile to merge', async () => {
    // --- operator-coordination: register the project profile ----------------
    const profile = await cli([
      'coordination',
      'register-profile',
      '--json',
      jsonArg({
        projectId: PROJECT_ID,
        displayName: 'CLI Workflow Project',
        repository: 'github.com/org/repo',
        designatedDispatcherHost: 'host-1',
        policyRevision: POLICY_REVISION,
        maxConcurrentLanes: 2,
        runnerCapabilities: { 'scoped-worktree': true, networkEgressRestricted: true },
      }),
    ]);
    expect(profile.code).toBe(0);
    expect(jsonOf(profile)).toMatchObject({
      outcome: 'registered',
      profile: { projectId: PROJECT_ID, policyRevision: POLICY_REVISION, revision: 0 },
    });

    // --- work-execution: register the work order (flags path) --------------
    const workOrder = await cli([
      'work-order',
      'register',
      '--work-order-id',
      WORK_ORDER_ID,
      '--project-id',
      PROJECT_ID,
      '--task-id',
      'task-1',
      '--lane-id',
      LANE_ID,
      '--repository',
      'github.com/org/repo',
      '--base-commit',
      laneHead,
      '--owned-paths',
      'packages/demo/src',
      '--policy-revision',
      POLICY_REVISION,
    ]);
    expect(workOrder.code).toBe(0);
    expect(jsonOf(workOrder)).toMatchObject({
      outcome: 'registered',
      workOrder: { id: WORK_ORDER_ID, state: 'approved', baseCommit: laneHead },
    });

    // --- brief-knowledge: capture, check and promote a keeper lesson --------
    const capture = await cli([
      'knowledge',
      'capture-notes',
      '--json',
      jsonArg({
        projectId: PROJECT_ID,
        attemptId: 'attempt-seed-1',
        workOrderId: WORK_ORDER_ID,
        headCommitSha: laneHead,
        notesMarkdown: [
          '- Run yarn lint before yarn build in the demo package',
          '- The demo package build must run with node 22',
          '',
        ].join('\n'),
        pathPrefixes: ['packages/demo'],
      }),
    ]);
    expect(capture.code).toBe(0);
    const captured = jsonOf<{
      outcome: string;
      notesStatus: string;
      candidateEntries: { id: string; claimText: string; disposition: string }[];
    }>(capture);
    expect(captured).toMatchObject({ outcome: 'captured', notesStatus: 'present' });
    expect(captured.candidateEntries).toHaveLength(2);
    entryId = captured.candidateEntries[0].id;
    expect(captured.candidateEntries[0]).toMatchObject({
      claimText: 'Run yarn lint before yarn build in the demo package',
      disposition: 'candidate',
    });

    const check = await cli([
      'knowledge',
      'check-claim',
      '--json',
      jsonArg({
        checkId: 'check-1',
        entryId,
        checkerId: 'checker-1',
        procedureName: 'confirm-path-exists',
        targetPath: briefFilePath,
      }),
    ]);
    expect(check.code).toBe(0);
    expect(jsonOf(check)).toMatchObject({
      outcome: 'checked',
      entry: { id: entryId, verification: 'supported' },
      check: { verification: 'supported' },
    });

    const decide = await cli([
      'knowledge',
      'decide',
      '--json',
      jsonArg({
        entryId,
        disposition: 'accepted',
        checkerId: 'checker-1',
        reason: 'Verified against the repository layout',
      }),
    ]);
    expect(decide.code).toBe(0);
    expect(jsonOf(decide)).toMatchObject({
      outcome: 'decided',
      entry: { id: entryId, disposition: 'accepted' },
    });

    const proposals = await cli([
      'knowledge',
      'propose-context',
      '--json',
      jsonArg({
        projectId: PROJECT_ID,
        laneId: LANE_ID,
        taskSummary: 'Run yarn lint before yarn build in the demo package',
      }),
    ]);
    expect(proposals.code).toBe(0);
    const proposed = jsonOf<{
      outcome: string;
      proposals: { proposalId: string; knowledgeEntryId: string; version: string }[];
    }>(proposals);
    expect(proposed.outcome).toBe('proposed');
    expect(proposed.proposals.length).toBeGreaterThan(0);
    expect(proposed.proposals[0].knowledgeEntryId).toBe(entryId);
    const proposalId = proposed.proposals[0].proposalId;

    // --- work-execution: freeze the brief package ---------------------------
    const brief = await cli([
      'brief',
      'prepare',
      '--json',
      jsonArg({
        workOrderId: WORK_ORDER_ID,
        projectId: PROJECT_ID,
        taskId: 'task-1',
        laneId: LANE_ID,
        repository: 'github.com/org/repo',
        baseCommit: laneHead,
        policyRevision: POLICY_REVISION,
        modelAssignment: {
          model: 'nvidia/z-ai/glm-5.3',
          variant: 'default',
          fallbackModel: 'openrouter/z-ai/glm-5.3-flash',
        },
        independentReviewer: 'openrouter/anthropic/claude-sonnet-4.5',
        ownedPaths: ['packages/demo/src'],
        permissions: ['edit'],
        acceptanceChecks: ['yarn build'],
        stepLimit: 50,
        timeLimitSeconds: 900,
        resourceBounds: { cpu: '2' },
        expectedArtifacts: ['docs/demo-summary.md'],
        ownerDecisionReferences: [],
        contextDecisions: [
          {
            proposalId,
            knowledgeEntryId: entryId,
            version: '1.0.0',
            proposedBecause: 'lexical match on the lane task',
            accepted: true,
            decisionBecause: 'Matches this lane task exactly',
          },
        ],
        attemptId: ATTEMPT_ID,
        worktreePath: briefRepoDir,
        handWrittenBriefPath: briefFilePath,
      }),
    ]);
    expect(brief.code).toBe(0);
    const prepared = jsonOf<{
      outcome: string;
      prepared: {
        attemptId: string;
        briefDigest: string;
        prosePath: string;
        manifestPath: string;
        selectedKnowledgeVersions: { knowledgeEntryId: string; version: string }[];
      };
    }>(brief);
    expect(prepared.outcome).toBe('prepared');
    expect(prepared.prepared.attemptId).toBe(ATTEMPT_ID);
    expect(prepared.prepared.selectedKnowledgeVersions).toEqual([
      { knowledgeEntryId: entryId, version: '1.0.0' },
    ]);
    briefDigest = prepared.prepared.briefDigest;
    expect(prepared.prepared.prosePath).toBe(path.join(briefRepoDir, '.lane', 'brief.md'));

    // --- work-execution: reserve capacity and dispatch ----------------------
    const reserve = await cli([
      'capacity',
      'reserve',
      '--json',
      jsonArg({
        reservationId: 'res-1',
        attemptId: ATTEMPT_ID,
        workOrderId: WORK_ORDER_ID,
        hostId: 'host-1',
        worktreePath: laneRepoDir,
        maxSlots: 2,
      }),
    ]);
    expect(reserve.code).toBe(0);
    expect(jsonOf(reserve)).toMatchObject({
      outcome: 'reserved',
      reservation: { attemptId: ATTEMPT_ID, hostId: 'host-1', held: true },
    });

    const dispatch = await cli([
      'attempt',
      'dispatch',
      '--json',
      jsonArg({
        attemptId: ATTEMPT_ID,
        workOrderId: WORK_ORDER_ID,
        worktreePath: laneRepoDir,
        briefPackagePath: prepared.prepared.prosePath,
        briefDigest,
        baseCommit: laneHead,
        stepLimit: 50,
        timeLimitSeconds: 900,
        expectedArtifacts: ['docs/demo-summary.md'],
      }),
    ]);
    expect(dispatch.code).toBe(0);
    expect(jsonOf(dispatch)).toMatchObject({
      outcome: 'started',
      sessionId: SESSION_ID,
      attempt: { id: ATTEMPT_ID, state: 'running', briefDigest },
    });

    const reconcile = await cli([
      'attempt',
      'reconcile',
      '--json',
      jsonArg({ attemptId: ATTEMPT_ID }),
    ]);
    expect(reconcile.code).toBe(0);
    expect(jsonOf(reconcile)).toMatchObject({
      outcome: 'ended',
      attempt: { id: ATTEMPT_ID, state: 'ended' },
      receipt: { attemptId: ATTEMPT_ID, sessionId: SESSION_ID, exitStatus: 0 },
    });

    const collect = await cli([
      'attempt',
      'collect',
      '--json',
      jsonArg({ attemptId: ATTEMPT_ID }),
    ]);
    expect(collect.code).toBe(0);
    expect(jsonOf(collect)).toMatchObject({
      outcome: 'collected',
      artifacts: { headCommit: laneHead, commitsSinceBase: [], notes: 'missing' },
    });

    // --- evidence-and-acceptance: verification, review, assessment ----------
    const requestVerification = await cli([
      'evidence',
      'request-verification',
      '--json',
      jsonArg({
        attemptId: ATTEMPT_ID,
        projectId: PROJECT_ID,
        candidateHeadSha: laneHead,
        policyRevision: POLICY_REVISION,
        hostId: 'verify-host-1',
        requiredChecks: ['yarn build'],
      }),
    ]);
    expect(requestVerification.code).toBe(0);
    // No verification host is allow-listed, so the executed check honestly
    // reports `unknown` and the assessment stays blocked until a receipt is
    // recorded.
    expect(jsonOf(requestVerification)).toMatchObject({
      outcome: 'completed',
      assessment: {
        id: assessmentIdForAttempt(ATTEMPT_ID),
        candidateHeadSha: laneHead,
        requiredChecks: ['yarn build'],
        state: 'blocked',
      },
      receipts: [{ procedureName: 'yarn build', result: 'unknown' }],
    });

    const recordVerification = await cli([
      'evidence',
      'record-verification',
      '--json',
      jsonArg({
        attemptId: ATTEMPT_ID,
        receipt: {
          id: 'vr-1',
          assessmentId: assessmentIdForAttempt(ATTEMPT_ID),
          projectId: PROJECT_ID,
          attemptId: ATTEMPT_ID,
          candidateHeadSha: laneHead,
          hostId: 'verify-host-1',
          procedureName: 'yarn build',
          result: 'pass',
          exitCode: 0,
          evidenceRef: 'evidence://verify-host-1/yarn-build',
          policyRevision: POLICY_REVISION,
          completedAtIso: '2026-10-15T08:40:00.000Z',
        },
      }),
    ]);
    expect(recordVerification.code).toBe(0);
    expect(jsonOf(recordVerification)).toMatchObject({
      outcome: 'recorded',
      assessment: { id: assessmentIdForAttempt(ATTEMPT_ID), state: 'pending', blockers: [] },
    });

    const recordReview = await cli([
      'evidence',
      'record-review',
      '--json',
      jsonArg({
        attemptId: ATTEMPT_ID,
        receipt: {
          id: 'rr-1',
          assessmentId: assessmentIdForAttempt(ATTEMPT_ID),
          projectId: PROJECT_ID,
          attemptId: ATTEMPT_ID,
          candidateHeadSha: laneHead,
          reviewerModel: 'openrouter/anthropic/claude-sonnet-4.5',
          implementerModel: 'nvidia/z-ai/glm-5.3',
          readOnlyVerified: true,
          result: 'pass',
          findings: [],
          evidenceRef: 'evidence://independent-review/rr-1',
          policyRevision: POLICY_REVISION,
          completedAtIso: '2026-10-15T08:45:00.000Z',
        },
      }),
    ]);
    expect(recordReview.code).toBe(0);
    expect(jsonOf(recordReview)).toMatchObject({
      outcome: 'recorded',
      assessment: {
        id: assessmentIdForAttempt(ATTEMPT_ID),
        reviewReceipts: [{ id: 'rr-1', result: 'pass' }],
      },
    });

    const assess = await cli([
      'evidence',
      'assess',
      '--json',
      jsonArg({
        attemptId: ATTEMPT_ID,
        candidateHeadSha: laneHead,
        policyRevision: POLICY_REVISION,
      }),
    ]);
    expect(assess.code).toBe(0);
    const assessed = jsonOf<{ outcome: string; receiptId: string; candidateHeadSha: string }>(
      assess,
    );
    expect(assessed).toMatchObject({ outcome: 'accepted', candidateHeadSha: laneHead });
    acceptanceReceiptId = assessed.receiptId;

    // --- work-execution: accept the collected head --------------------------
    const accept = await cli([
      'attempt',
      'accept',
      '--json',
      jsonArg({
        attemptId: ATTEMPT_ID,
        reviewerModel: 'openrouter/anthropic/claude-sonnet-4.5',
      }),
    ]);
    expect(accept.code).toBe(0);
    expect(jsonOf(accept)).toEqual({
      outcome: 'accepted',
      candidateHeadSha: laneHead,
      receiptId: acceptanceReceiptId,
    });

    const inspectedEvidence = await cli([
      'evidence',
      'inspect',
      '--candidate-head-sha',
      laneHead,
    ]);
    expect(inspectedEvidence.code).toBe(0);
    expect(jsonOf(inspectedEvidence)).toMatchObject({
      outcome: 'found',
      assessment: { acceptanceReceiptId: acceptanceReceiptId, state: 'accepted' },
    });

    const inspected = await cli(['work-order', 'inspect', `--work-order-id=${WORK_ORDER_ID}`]);
    expect(inspected.code).toBe(0);
    expect(jsonOf(inspected)).toMatchObject({
      outcome: 'found',
      workOrder: { id: WORK_ORDER_ID, state: 'ready-to-merge' },
      attempts: [expect.objectContaining({ id: ATTEMPT_ID, state: 'collected', outcome: 'no-commit' })],
    });

    // --- operator-coordination: authorize the merge, then execute it --------
    const decision = await cli([
      'coordination',
      'request-decision',
      '--json',
      jsonArg({
        requestId: 'dec-1',
        projectId: PROJECT_ID,
        kind: 'action-decision',
        actionScope: 'forge:merge-pr',
        expectedHeadSha: laneHead,
        proposalDigest: `merge ${ATTEMPT_ID} at ${laneHead}`,
        policyRevision: POLICY_REVISION,
      }),
    ]);
    expect(decision.code).toBe(0);
    // The owner-recorded approved answer carries the grant that authorizes
    // exactly this action scope and expected head.
    expect(jsonOf(decision)).toMatchObject({
      outcome: 'requested',
      request: { id: 'dec-1', state: 'approved', grantId: 'grant-1', expectedHeadSha: laneHead },
    });

    const forge = await cli([
      'forge',
      'execute',
      '--json',
      jsonArg({
        actionId: 'forge-action-1',
        attemptId: ATTEMPT_ID,
        workOrderId: WORK_ORDER_ID,
        kind: 'merge-pr',
        expectedHeadSha: laneHead,
        authorizationGrantId: 'grant-1',
      }),
    ]);
    expect(forge.code).toBe(0);
    expect(jsonOf(forge)).toEqual({ outcome: 'executed', headSha: laneHead });

    const merged = await cli(['work-order', 'inspect', '--work-order-id', WORK_ORDER_ID]);
    expect(merged.code).toBe(0);
    expect(jsonOf(merged)).toMatchObject({
      outcome: 'found',
      workOrder: { id: WORK_ORDER_ID, state: 'merged' },
    });
  });

  it('exposes the coordination surface', async () => {
    const relay = await cli([
      'coordination',
      'send-relay',
      '--json',
      jsonArg({
        requestId: 'relay-1',
        projectId: PROJECT_ID,
        recipientId: 'fleet-owner',
        summary: 'lane update',
        policyRevision: POLICY_REVISION,
      }),
    ]);
    expect(relay.code).toBe(0);
    expect(jsonOf(relay)).toMatchObject({
      outcome: 'delivered',
      request: { id: 'relay-1', kind: 'relay', deliveryStatus: 'delivered' },
    });

    const ack = await cli([
      'coordination',
      'ack-relay',
      '--json',
      jsonArg({
        acknowledgementId: 'ack-1',
        requestId: 'relay-1',
        recipientId: 'fleet-owner',
        responseSummary: 'seen',
        provenance: 'operator-channel',
      }),
    ]);
    expect(ack.code).toBe(0);
    expect(jsonOf(ack)).toMatchObject({
      outcome: 'acknowledged',
      acknowledgement: { acknowledgementId: 'ack-1' },
    });

    const observation = await cli([
      'coordination',
      'publish-observation',
      '--json',
      jsonArg({
        observationId: 'obs-1',
        projectId: PROJECT_ID,
        eventKind: 'note',
        sourceAttemptId: ATTEMPT_ID,
        payloadSummary: 'attempt collected',
      }),
    ]);
    expect(observation.code).toBe(0);
    expect(jsonOf(observation)).toEqual({ outcome: 'published', observationId: 'obs-1' });

    // No attention reader is configured, so the read reports absence instead
    // of inventing a healthy summary; that is a non-zero exit.
    const attention = await cli(['coordination', 'attention', '--project-id', PROJECT_ID]);
    expect(attention.code).toBe(1);
    expect(jsonOf(attention)).toMatchObject({
      outcome: 'unavailable',
      reason: expect.stringContaining('no attention summary is readable'),
    });

    const capabilities = await cli([
      'coordination',
      'capabilities',
      '--json',
      jsonArg({
        projectId: PROJECT_ID,
        requiredCapabilities: ['scoped-worktree', 'networkEgressRestricted'],
      }),
    ]);
    expect(capabilities.code).toBe(0);
    expect(jsonOf(capabilities)).toMatchObject({
      outcome: 'inspected',
      profile: { projectId: PROJECT_ID },
      missingRequirements: [],
      explicitUnknowns: [],
    });

    const outstanding = await cli([
      'coordination',
      'outstanding',
      '--json',
      jsonArg({ projectId: PROJECT_ID }),
    ]);
    expect(outstanding.code).toBe(0);
    expect(jsonOf(outstanding)).toEqual({
      undecidedProposals: [],
      unknownActions: [],
      undeliveredObservations: [],
      unacknowledgedRelays: [],
    });
  });

  it('authorizes, consumes and blocks scoped action decisions', async () => {
    const decision = await cli([
      'coordination',
      'request-decision',
      '--json',
      jsonArg({
        requestId: 'dec-2',
        projectId: PROJECT_ID,
        kind: 'action-decision',
        actionScope: 'forge:push-and-open-pr',
        expectedHeadSha: laneHead,
        proposalDigest: `open a pull request for ${ATTEMPT_ID}`,
        policyRevision: POLICY_REVISION,
      }),
    ]);
    expect(decision.code).toBe(0);
    expect(jsonOf(decision)).toMatchObject({
      outcome: 'requested',
      request: { id: 'dec-2', grantId: 'grant-2' },
    });

    const resolved = await cli([
      'coordination',
      'resolve-auth',
      '--json',
      jsonArg({
        projectId: PROJECT_ID,
        actionScope: 'forge:push-and-open-pr',
        expectedHeadSha: laneHead,
      }),
    ]);
    expect(resolved.code).toBe(0);
    expect(jsonOf(resolved)).toMatchObject({
      outcome: 'authorized',
      grantId: 'grant-2',
      expectedHeadSha: laneHead,
    });

    const consumed = await cli([
      'coordination',
      'consume-auth',
      '--json',
      jsonArg({
        consumptionId: 'consumption-direct-1',
        grantId: 'grant-2',
        actionId: 'action-direct-1',
        attemptId: ATTEMPT_ID,
        expectedHeadSha: laneHead,
      }),
    ]);
    expect(consumed.code).toBe(0);
    expect(jsonOf(consumed)).toMatchObject({
      outcome: 'consumed',
      consumption: { actionId: 'action-direct-1', attemptId: ATTEMPT_ID },
    });

    // A consumed grant never authorizes a second action.
    const blocked = await cli([
      'coordination',
      'resolve-auth',
      '--json',
      jsonArg({
        projectId: PROJECT_ID,
        actionScope: 'forge:push-and-open-pr',
        expectedHeadSha: laneHead,
      }),
    ]);
    expect(blocked.code).toBe(1);
    expect(jsonOf(blocked)).toMatchObject({
      outcome: 'blocked',
      reason: expect.stringContaining('no recorded decision authorizes'),
    });
  });

  it('manages the knowledge lifecycle beyond the workflow', async () => {
    const selection = await cli([
      'knowledge',
      'select-context',
      '--json',
      jsonArg({
        attemptId: ATTEMPT_ID,
        selections: [
          {
            proposalId: 'bkp-manual-1',
            knowledgeEntryId: entryId,
            version: '1.0.0',
            accepted: true,
            decisionBecause: 'reused for the fix round',
          },
        ],
      }),
    ]);
    expect(selection.code).toBe(0);
    expect(jsonOf(selection)).toEqual({ outcome: 'recorded', recordedCount: 1 });

    const reuse = await cli([
      'knowledge',
      'record-reuse',
      '--json',
      jsonArg({
        reuseId: 'reuse-1',
        entryId,
        attemptId: ATTEMPT_ID,
        outcome: 'included',
        evidenceRef: 'brief manifest',
      }),
    ]);
    expect(reuse.code).toBe(0);
    expect(jsonOf(reuse)).toMatchObject({
      outcome: 'recorded',
      reuse: { id: 'reuse-1', outcome: 'included' },
      entry: { id: entryId },
    });

    const published = await cli(['knowledge', 'publish', '--entry-id', entryId]);
    expect(published.code).toBe(0);
    expect(jsonOf(published)).toMatchObject({
      outcome: 'published',
      entry: { id: entryId },
      externalRef: expect.stringContaining('keepers-shelf.json'),
    });

    // A second captured lesson supersedes the first after its own check and
    // deliberate acceptance.
    const capture = await cli([
      'knowledge',
      'capture-notes',
      '--json',
      jsonArg({
        projectId: PROJECT_ID,
        attemptId: 'attempt-seed-2',
        workOrderId: WORK_ORDER_ID,
        headCommitSha: laneHead,
        notesMarkdown: '- Run yarn lint and yarn build together with node 22 in the demo package\n',
        pathPrefixes: ['packages/demo'],
      }),
    ]);
    expect(capture.code).toBe(0);
    const captured = jsonOf<{ candidateEntries: { id: string }[] }>(capture);
    const newerEntryId = captured.candidateEntries[0].id;

    const check = await cli([
      'knowledge',
      'check-claim',
      '--json',
      jsonArg({
        checkId: 'check-2',
        entryId: newerEntryId,
        checkerId: 'checker-1',
        procedureName: 'confirm-path-exists',
        targetPath: briefFilePath,
      }),
    ]);
    expect(check.code).toBe(0);
    expect(jsonOf(check)).toMatchObject({ outcome: 'checked', entry: { verification: 'supported' } });

    const decide = await cli([
      'knowledge',
      'decide',
      '--json',
      jsonArg({
        entryId: newerEntryId,
        disposition: 'accepted',
        checkerId: 'checker-1',
        reason: 'Corrected lesson verified against the build pipeline',
      }),
    ]);
    expect(decide.code).toBe(0);
    expect(jsonOf(decide)).toMatchObject({ outcome: 'decided', entry: { disposition: 'accepted' } });

    const superseded = await cli([
      'knowledge',
      'supersede',
      '--json',
      jsonArg({
        olderEntryId: entryId,
        newerEntryId,
        checkerId: 'checker-1',
        reason: 'The newer lesson records the node version requirement',
      }),
    ]);
    expect(superseded.code).toBe(0);
    expect(jsonOf(superseded)).toMatchObject({
      outcome: 'superseded',
      olderEntry: { id: entryId, disposition: 'superseded', supersededById: newerEntryId },
      newerEntry: { id: newerEntryId },
    });
  });

  it('prepares fix rounds, refuses unavailable evidence and stops attempts', async () => {
    const fix = await cli([
      'attempt',
      'fix',
      '--json',
      jsonArg({
        fixAttemptId: `${ATTEMPT_ID}-fix-1`,
        workOrderId: WORK_ORDER_ID,
        priorAttemptId: ATTEMPT_ID,
        worktreePath: laneRepoDir,
        baseCommit: laneHead,
        numberedFixes: ['1. Re-run yarn build'],
      }),
    ]);
    expect(fix.code).toBe(0);
    expect(jsonOf(fix)).toMatchObject({
      outcome: 'prepared',
      attempt: {
        id: `${ATTEMPT_ID}-fix-1`,
        kind: 'fix',
        fixNumber: 1,
        priorAttemptId: ATTEMPT_ID,
        state: 'intent-recorded',
      },
    });

    // No independent review transport is configured, so the request is
    // rejected rather than fabricated as evidence.
    const review = await cli([
      'evidence',
      'request-review',
      '--json',
      jsonArg({
        attemptId: ATTEMPT_ID,
        projectId: PROJECT_ID,
        candidateHeadSha: laneHead,
        policyRevision: POLICY_REVISION,
        implementerModel: 'nvidia/z-ai/glm-5.3',
        reviewerModel: 'openrouter/anthropic/claude-sonnet-4.5',
      }),
    ]);
    expect(review.code).toBe(1);
    expect(jsonOf(review)).toMatchObject({
      outcome: 'rejected',
      reason: expect.stringContaining('No independent review transport is configured'),
    });

    // No finding was raised for this assessment, so there is nothing to
    // dispose; the command reports that instead of inventing a resolution.
    const disposition = await cli([
      'evidence',
      'disposition',
      '--json',
      jsonArg({
        attemptId: ATTEMPT_ID,
        disposition: {
          id: 'fd-1',
          assessmentId: assessmentIdForAttempt(ATTEMPT_ID),
          findingId: 'finding-1',
          candidateHeadSha: laneHead,
          state: 'fixed',
          reason: 'addressed',
          evidenceRef: 'evidence://fd-1',
          recordedBy: 'checker-1',
          recordedAtIso: '2026-10-15T09:00:00.000Z',
        },
      }),
    ]);
    expect(disposition.code).toBe(1);
    expect(jsonOf(disposition)).toMatchObject({
      outcome: 'rejected',
      reason: expect.stringContaining("No finding 'finding-1' was raised"),
    });

    const stop = await cli(['attempt', 'stop', '--json', jsonArg({ attemptId: ATTEMPT_ID })]);
    expect(stop.code).toBe(0);
    expect(jsonOf(stop)).toMatchObject({
      outcome: 'terminated',
      attempt: { id: ATTEMPT_ID, state: 'cancelled', outcome: 'stopped' },
      receipt: { attemptId: ATTEMPT_ID, sessionId: SESSION_ID, stoppedByRequest: true },
      capacityReleased: false,
    });
  });

  it('reports help, usage errors and refusal exit codes', async () => {
    const help = await cli(['--help']);
    expect(help.code).toBe(0);
    expect(help.text).toContain('work-order register|inspect');
    expect(help.text).toContain('coordination register-profile|capabilities|request-decision');

    const helpWord = await cli(['help']);
    expect(helpWord.code).toBe(0);
    expect(helpWord.text).toBe(help.text);

    const none = await cli([]);
    expect(none.code).toBe(2);
    expect(none.stderr).toContain('Usage');

    const unknownCommand = await cli(['warp-drive']);
    expect(unknownCommand.code).toBe(2);
    expect(unknownCommand.stderr).toContain("Unknown command: warp-drive");

    const missingSubcommand = await cli(['work-order']);
    expect(missingSubcommand.code).toBe(2);
    expect(missingSubcommand.stderr).toContain('Subcommands:');

    const unknownSubcommand = await cli(['work-order', 'frobnicate']);
    expect(unknownSubcommand.code).toBe(2);
    expect(unknownSubcommand.stderr).toContain('Unknown work-order subcommand: frobnicate');

    const badJson = await cli(['work-order', 'register', '--json', '{oops']);
    expect(badJson.code).toBe(2);
    expect(badJson.stderr).toContain('--json payload is not valid JSON');

    const nonObjectJson = await cli(['work-order', 'register', '--json', '[1,2]']);
    expect(nonObjectJson.code).toBe(2);
    expect(nonObjectJson.stderr).toContain('--json payload must be a JSON object');

    const badKind = await cli([
      'forge',
      'execute',
      '--json',
      jsonArg({ attemptId: ATTEMPT_ID, kind: 'delete-everything', authorizationGrantId: 'g' }),
    ]);
    expect(badKind.code).toBe(2);
    expect(badKind.stderr).toContain("forge kind must be 'push-and-open-pr' or 'merge-pr'");

    // A duplicate identity is refused by the work order use case and exits 1.
    const duplicate = await cli([
      'work-order',
      'register',
      '--json',
      jsonArg({
        workOrderId: WORK_ORDER_ID,
        projectId: PROJECT_ID,
        taskId: 'task-1',
        laneId: LANE_ID,
        repository: 'github.com/org/repo',
        baseCommit: laneHead,
        ownedPaths: ['packages/demo/src'],
        policyRevision: POLICY_REVISION,
      }),
    ]);
    expect(duplicate.code).toBe(1);
    expect(jsonOf(duplicate)).toMatchObject({
      outcome: 'rejected',
      reason: expect.stringContaining('already registered'),
    });

    // An invalid capacity request is refused with its reason.
    const refusedReserve = await cli([
      'capacity',
      'reserve',
      '--json',
      jsonArg({
        reservationId: 'res-x',
        attemptId: 'attempt-x',
        workOrderId: WORK_ORDER_ID,
        hostId: 'host-1',
        worktreePath: laneRepoDir,
        maxSlots: 0,
      }),
    ]);
    expect(refusedReserve.code).toBe(1);
    expect(jsonOf(refusedReserve)).toMatchObject({
      outcome: 'refused',
      reason: 'maxSlots must be a positive number',
    });

    // Missing evidence identity is reported as not-found, never as a pass.
    const notFoundEvidence = await cli(['evidence', 'inspect', '--json', '{}']);
    expect(notFoundEvidence.code).toBe(1);
    expect(jsonOf(notFoundEvidence)).toEqual({ outcome: 'not-found', query: '' });
  });

  it('completes the merge across separate runCli processes on one state dir', async () => {
    // Cutover pilot: every invocation below omits the injected `runtime`
    // argument, so each command composes a brand-new FleetCliRuntime loaded
    // solely from `multiProcStateDir` on disk. Receipts and coordinates
    // recorded by an earlier invocation must be reloaded from
    // `<stateDir>/accepted-receipts.json` and
    // `<stateDir>/authorization-coordinates.json` for the final merge to pass.
    const multiProcStateDir = path.join(suiteDir, 'mp-state');
    const multiProcLaneRepo = path.join(suiteDir, 'mp-lane-repo');
    const multiProcBriefRepo = path.join(suiteDir, 'mp-brief-repo');
    const multiProcBriefFile = path.join(suiteDir, 'mp-handwritten-brief.md');
    const mpWorkOrderId = 'wo-mp-1';
    const mpAttemptId = 'attempt-mp-1';
    mkdirSync(multiProcStateDir);
    const mpLaneHead = initGitRepo(multiProcLaneRepo, []);
    initGitRepo(multiProcBriefRepo, ['.lane/', 'docs/demo-summary.md']);
    writeFileSync(
      multiProcBriefFile,
      [
        '# Work order wo-mp-1',
        '',
        'Run yarn lint and yarn build for the demo package, then summarize',
        'the result in docs/demo-summary.md.',
        '',
      ].join('\n'),
    );
    // Owner-recorded approved answer read by the decision transport of every
    // fresh runtime against this state dir.
    const mpDecisionsDir = path.join(multiProcStateDir, 'decisions');
    mkdirSync(mpDecisionsDir);
    const decMp1Signature = signDecisionForWorkflow({
      requestId: 'dec-mp-1',
      projectId: PROJECT_ID,
      actionScope: 'forge:merge-pr',
      expectedHeadSha: mpLaneHead,
      decisionRevision: 'dec-mp-1-r1',
      grantId: 'grant-mp-1',
      state: 'approved',
    });
    writeFileSync(
      path.join(mpDecisionsDir, 'dec-mp-1.json'),
      `${JSON.stringify({ state: 'approved', decisionRevision: 'dec-mp-1-r1', grantId: 'grant-mp-1', signature: decMp1Signature }, null, 2)}\n`,
    );

    const mpCli = async (argv: readonly string[]): Promise<Invocation> => {
      const out: string[] = [];
      const err: string[] = [];
      const io: CliIo = {
        stdout: (text) => {
          out.push(text);
        },
        stderr: (text) => {
          err.push(text);
        },
      };
      // No third argument: this invocation rebuilds the runtime from disk.
      const code = await runCli(['--state-dir', multiProcStateDir, ...argv], io);
      return { code, text: out.join(''), stderr: err.join('') };
    };

    // --- process: operator-coordination profile -----------------------------
    const profile = await mpCli([
      'coordination',
      'register-profile',
      '--json',
      jsonArg({
        projectId: PROJECT_ID,
        displayName: 'Multi-Process Project',
        repository: 'github.com/org/repo',
        designatedDispatcherHost: 'host-1',
        policyRevision: POLICY_REVISION,
        maxConcurrentLanes: 2,
        runnerCapabilities: { 'scoped-worktree': true, networkEgressRestricted: true },
      }),
    ]);
    expect(profile.code).toBe(0);
    expect(jsonOf(profile)).toMatchObject({ outcome: 'registered' });

    // --- process: work-execution work order ---------------------------------
    const workOrder = await mpCli([
      'work-order',
      'register',
      '--json',
      jsonArg({
        workOrderId: mpWorkOrderId,
        projectId: PROJECT_ID,
        taskId: 'task-mp-1',
        laneId: 'lane-mp-1',
        repository: 'github.com/org/repo',
        baseCommit: mpLaneHead,
        ownedPaths: ['packages/demo/src'],
        policyRevision: POLICY_REVISION,
      }),
    ]);
    expect(workOrder.code).toBe(0);
    expect(jsonOf(workOrder)).toMatchObject({
      outcome: 'registered',
      workOrder: { id: mpWorkOrderId, state: 'approved', baseCommit: mpLaneHead },
    });

    // --- process: brief-knowledge keeper lifecycle ---------------------------
    const capture = await mpCli([
      'knowledge',
      'capture-notes',
      '--json',
      jsonArg({
        projectId: PROJECT_ID,
        attemptId: 'attempt-mp-seed-1',
        workOrderId: mpWorkOrderId,
        headCommitSha: mpLaneHead,
        notesMarkdown: '- Run yarn lint before yarn build in the demo package\n',
        pathPrefixes: ['packages/demo'],
      }),
    ]);
    expect(capture.code).toBe(0);
    const captured = jsonOf<{ candidateEntries: { id: string }[] }>(capture);
    const mpEntryId = captured.candidateEntries[0].id;

    const check = await mpCli([
      'knowledge',
      'check-claim',
      '--json',
      jsonArg({
        checkId: 'check-mp-1',
        entryId: mpEntryId,
        checkerId: 'checker-1',
        procedureName: 'confirm-path-exists',
        targetPath: multiProcBriefFile,
      }),
    ]);
    expect(check.code).toBe(0);
    expect(jsonOf(check)).toMatchObject({ outcome: 'checked', entry: { verification: 'supported' } });

    const decide = await mpCli([
      'knowledge',
      'decide',
      '--json',
      jsonArg({
        entryId: mpEntryId,
        disposition: 'accepted',
        checkerId: 'checker-1',
        reason: 'Verified against the repository layout',
      }),
    ]);
    expect(decide.code).toBe(0);
    expect(jsonOf(decide)).toMatchObject({ outcome: 'decided', entry: { disposition: 'accepted' } });

    const proposals = await mpCli([
      'knowledge',
      'propose-context',
      '--json',
      jsonArg({
        projectId: PROJECT_ID,
        laneId: 'lane-mp-1',
        taskSummary: 'Run yarn lint before yarn build in the demo package',
      }),
    ]);
    expect(proposals.code).toBe(0);
    const proposed = jsonOf<{
      outcome: string;
      proposals: { proposalId: string; knowledgeEntryId: string; version: string }[];
    }>(proposals);
    expect(proposed.outcome).toBe('proposed');
    expect(proposed.proposals[0].knowledgeEntryId).toBe(mpEntryId);
    const mpProposalId = proposed.proposals[0].proposalId;

    // --- process: brief prepare ----------------------------------------------
    const brief = await mpCli([
      'brief',
      'prepare',
      '--json',
      jsonArg({
        workOrderId: mpWorkOrderId,
        projectId: PROJECT_ID,
        taskId: 'task-mp-1',
        laneId: 'lane-mp-1',
        repository: 'github.com/org/repo',
        baseCommit: mpLaneHead,
        policyRevision: POLICY_REVISION,
        modelAssignment: {
          model: 'nvidia/z-ai/glm-5.3',
          variant: 'default',
          fallbackModel: 'openrouter/z-ai/glm-5.3-flash',
        },
        independentReviewer: 'openrouter/anthropic/claude-sonnet-4.5',
        ownedPaths: ['packages/demo/src'],
        permissions: ['edit'],
        acceptanceChecks: ['yarn build'],
        stepLimit: 50,
        timeLimitSeconds: 900,
        resourceBounds: { cpu: '2' },
        expectedArtifacts: ['docs/demo-summary.md'],
        ownerDecisionReferences: [],
        contextDecisions: [
          {
            proposalId: mpProposalId,
            knowledgeEntryId: mpEntryId,
            version: '1.0.0',
            proposedBecause: 'lexical match on the lane task',
            accepted: true,
            decisionBecause: 'Matches this lane task exactly',
          },
        ],
        attemptId: mpAttemptId,
        worktreePath: multiProcBriefRepo,
        handWrittenBriefPath: multiProcBriefFile,
      }),
    ]);
    expect(brief.code).toBe(0);
    const prepared = jsonOf<{
      outcome: string;
      prepared: { attemptId: string; briefDigest: string; prosePath: string };
    }>(brief);
    expect(prepared.outcome).toBe('prepared');
    expect(prepared.prepared.attemptId).toBe(mpAttemptId);

    // --- process: capacity + attempt lifecycle -------------------------------
    const reserve = await mpCli([
      'capacity',
      'reserve',
      '--json',
      jsonArg({
        reservationId: 'res-mp-1',
        attemptId: mpAttemptId,
        workOrderId: mpWorkOrderId,
        hostId: 'host-1',
        worktreePath: multiProcLaneRepo,
        maxSlots: 2,
      }),
    ]);
    expect(reserve.code).toBe(0);
    expect(jsonOf(reserve)).toMatchObject({ outcome: 'reserved' });

    const dispatch = await mpCli([
      'attempt',
      'dispatch',
      '--json',
      jsonArg({
        attemptId: mpAttemptId,
        workOrderId: mpWorkOrderId,
        worktreePath: multiProcLaneRepo,
        briefPackagePath: prepared.prepared.prosePath,
        briefDigest: prepared.prepared.briefDigest,
        baseCommit: mpLaneHead,
        stepLimit: 50,
        timeLimitSeconds: 900,
        expectedArtifacts: ['docs/demo-summary.md'],
      }),
    ]);
    expect(dispatch.code).toBe(0);
    expect(jsonOf(dispatch)).toMatchObject({
      outcome: 'started',
      sessionId: SESSION_ID,
      attempt: { id: mpAttemptId, state: 'running' },
    });

    const reconcile = await mpCli([
      'attempt',
      'reconcile',
      '--json',
      jsonArg({ attemptId: mpAttemptId }),
    ]);
    expect(reconcile.code).toBe(0);
    expect(jsonOf(reconcile)).toMatchObject({
      outcome: 'ended',
      attempt: { id: mpAttemptId, state: 'ended' },
    });

    const collect = await mpCli([
      'attempt',
      'collect',
      '--json',
      jsonArg({ attemptId: mpAttemptId }),
    ]);
    expect(collect.code).toBe(0);
    expect(jsonOf(collect)).toMatchObject({
      outcome: 'collected',
      artifacts: { headCommit: mpLaneHead },
    });

    // --- process: evidence chain ---------------------------------------------
    const requestVerification = await mpCli([
      'evidence',
      'request-verification',
      '--json',
      jsonArg({
        attemptId: mpAttemptId,
        projectId: PROJECT_ID,
        candidateHeadSha: mpLaneHead,
        policyRevision: POLICY_REVISION,
        hostId: 'verify-host-1',
        requiredChecks: ['yarn build'],
      }),
    ]);
    expect(requestVerification.code).toBe(0);
    expect(jsonOf(requestVerification)).toMatchObject({
      outcome: 'completed',
      assessment: { state: 'blocked' },
    });

    const recordVerification = await mpCli([
      'evidence',
      'record-verification',
      '--json',
      jsonArg({
        attemptId: mpAttemptId,
        receipt: {
          id: 'vr-mp-1',
          assessmentId: assessmentIdForAttempt(mpAttemptId),
          projectId: PROJECT_ID,
          attemptId: mpAttemptId,
          candidateHeadSha: mpLaneHead,
          hostId: 'verify-host-1',
          procedureName: 'yarn build',
          result: 'pass',
          exitCode: 0,
          evidenceRef: 'evidence://verify-host-1/yarn-build',
          policyRevision: POLICY_REVISION,
          completedAtIso: '2026-10-15T10:40:00.000Z',
        },
      }),
    ]);
    expect(recordVerification.code).toBe(0);
    expect(jsonOf(recordVerification)).toMatchObject({
      outcome: 'recorded',
      assessment: { state: 'pending', blockers: [] },
    });

    const recordReview = await mpCli([
      'evidence',
      'record-review',
      '--json',
      jsonArg({
        attemptId: mpAttemptId,
        receipt: {
          id: 'rr-mp-1',
          assessmentId: assessmentIdForAttempt(mpAttemptId),
          projectId: PROJECT_ID,
          attemptId: mpAttemptId,
          candidateHeadSha: mpLaneHead,
          reviewerModel: 'openrouter/anthropic/claude-sonnet-4.5',
          implementerModel: 'nvidia/z-ai/glm-5.3',
          readOnlyVerified: true,
          result: 'pass',
          findings: [],
          evidenceRef: 'evidence://independent-review/rr-mp-1',
          policyRevision: POLICY_REVISION,
          completedAtIso: '2026-10-15T10:45:00.000Z',
        },
      }),
    ]);
    expect(recordReview.code).toBe(0);
    expect(jsonOf(recordReview)).toMatchObject({ outcome: 'recorded' });

    const assess = await mpCli([
      'evidence',
      'assess',
      '--json',
      jsonArg({
        attemptId: mpAttemptId,
        candidateHeadSha: mpLaneHead,
        policyRevision: POLICY_REVISION,
      }),
    ]);
    expect(assess.code).toBe(0);
    expect(jsonOf(assess)).toMatchObject({ outcome: 'accepted', candidateHeadSha: mpLaneHead });

    // --- process: accept writes the cross-process receipt registry -----------
    const accept = await mpCli([
      'attempt',
      'accept',
      '--json',
      jsonArg({
        attemptId: mpAttemptId,
        reviewerModel: 'openrouter/anthropic/claude-sonnet-4.5',
      }),
    ]);
    expect(accept.code).toBe(0);
    const accepted = jsonOf<{ outcome: string; candidateHeadSha: string; receiptId: string }>(
      accept,
    );
    expect(accepted).toMatchObject({ outcome: 'accepted', candidateHeadSha: mpLaneHead });
    const mpReceiptId = accepted.receiptId;

    // The accept process persisted the receipt registry for later processes.
    const receiptsPath = path.join(multiProcStateDir, 'accepted-receipts.json');
    expect(existsSync(receiptsPath)).toBe(true);
    const persistedReceipts = JSON.parse(readFileSync(receiptsPath, 'utf8')) as Record<
      string,
      string
    >;
    expect(persistedReceipts[mpLaneHead]).toBe(mpReceiptId);

    // --- process: coordination decision and authorization ---------------------
    const decision = await mpCli([
      'coordination',
      'request-decision',
      '--json',
      jsonArg({
        requestId: 'dec-mp-1',
        projectId: PROJECT_ID,
        kind: 'action-decision',
        actionScope: 'forge:merge-pr',
        expectedHeadSha: mpLaneHead,
        proposalDigest: `merge ${mpAttemptId} at ${mpLaneHead}`,
        policyRevision: POLICY_REVISION,
      }),
    ]);
    expect(decision.code).toBe(0);
    expect(jsonOf(decision)).toMatchObject({
      outcome: 'requested',
      request: { id: 'dec-mp-1', state: 'approved', grantId: 'grant-mp-1' },
    });

    const resolved = await mpCli([
      'coordination',
      'resolve-auth',
      '--json',
      jsonArg({
        projectId: PROJECT_ID,
        actionScope: 'forge:merge-pr',
        expectedHeadSha: mpLaneHead,
      }),
    ]);
    expect(resolved.code).toBe(0);
    expect(jsonOf(resolved)).toMatchObject({
      outcome: 'authorized',
      grantId: 'grant-mp-1',
      expectedHeadSha: mpLaneHead,
    });

    // Coordinates an earlier resolve process durably recorded for this grant:
    // the forge process below must reload them from disk because its fresh
    // runtime starts with empty in-memory maps.
    const coordinatesPath = path.join(multiProcStateDir, 'authorization-coordinates.json');
    writeFileSync(
      coordinatesPath,
      `${JSON.stringify(
        { 'grant-mp-1': { attemptId: mpAttemptId, expectedHeadSha: mpLaneHead } },
        null,
        2,
      )}\n`,
    );

    // --- process: forge the merge against reloaded state ----------------------
    const forge = await mpCli([
      'forge',
      'execute',
      '--json',
      jsonArg({
        actionId: 'forge-mp-action-1',
        attemptId: mpAttemptId,
        workOrderId: mpWorkOrderId,
        kind: 'merge-pr',
        expectedHeadSha: mpLaneHead,
        authorizationGrantId: 'grant-mp-1',
      }),
    ]);
    expect(forge.code).toBe(0);
    expect(jsonOf(forge)).toEqual({ outcome: 'executed', headSha: mpLaneHead });

    const merged = await mpCli(['work-order', 'inspect', '--work-order-id', mpWorkOrderId]);
    expect(merged.code).toBe(0);
    expect(jsonOf(merged)).toMatchObject({
      outcome: 'found',
      workOrder: { id: mpWorkOrderId, state: 'merged' },
    });

    // The reloaded coordinates survived the forge process untouched.
    const persistedCoordinates = JSON.parse(readFileSync(coordinatesPath, 'utf8')) as Record<
      string,
      { attemptId: string; expectedHeadSha: string }
    >;
    expect(persistedCoordinates['grant-mp-1']).toEqual({
      attemptId: mpAttemptId,
      expectedHeadSha: mpLaneHead,
    });
  });

  it('falls back to FLEET_STATE_DIR and rejects invalid --state-dir values', async () => {
    const envStateDir = path.join(suiteDir, 'env-state');
    const flagStateDir = path.join(suiteDir, 'flag-state');
    mkdirSync(envStateDir);
    mkdirSync(flagStateDir);

    const bareCli = async (argv: readonly string[]): Promise<Invocation> => {
      const out: string[] = [];
      const err: string[] = [];
      const io: CliIo = {
        stdout: (text) => {
          out.push(text);
        },
        stderr: (text) => {
          err.push(text);
        },
      };
      // No --state-dir token and no injected runtime: the environment decides.
      const code = await runCli([...argv], io);
      return { code, text: out.join(''), stderr: err.join('') };
    };

    const originalFleetStateDir = process.env.FLEET_STATE_DIR;
    process.env.FLEET_STATE_DIR = envStateDir;
    try {
      // With FLEET_STATE_DIR set, a command without --state-dir and without an
      // injected runtime composes its runtime from the environment directory.
      const registered = await bareCli([
        'coordination',
        'register-profile',
        '--json',
        jsonArg({
          projectId: 'proj-env-1',
          displayName: 'Env State Project',
          repository: 'github.com/org/repo',
          designatedDispatcherHost: 'host-1',
          policyRevision: POLICY_REVISION,
          maxConcurrentLanes: 1,
          runnerCapabilities: { 'scoped-worktree': true },
        }),
      ]);
      expect(registered.code).toBe(0);
      expect(jsonOf(registered)).toMatchObject({ outcome: 'registered' });

      // A second fresh runtime reads the profile back from the same directory.
      const inspected = await bareCli([
        'coordination',
        'capabilities',
        '--json',
        jsonArg({ projectId: 'proj-env-1', requiredCapabilities: ['scoped-worktree'] }),
      ]);
      expect(inspected.code).toBe(0);
      expect(jsonOf(inspected)).toMatchObject({
        outcome: 'inspected',
        profile: { projectId: 'proj-env-1' },
      });

      // An explicit --state-dir wins over the environment fallback and never
      // leaks into group dispatch or the command payload.
      const flagged = await bareCli([
        '--state-dir',
        flagStateDir,
        'coordination',
        'register-profile',
        '--json',
        jsonArg({
          projectId: 'proj-flag-1',
          displayName: 'Flag State Project',
          repository: 'github.com/org/repo',
          designatedDispatcherHost: 'host-1',
          policyRevision: POLICY_REVISION,
          maxConcurrentLanes: 1,
          runnerCapabilities: { 'scoped-worktree': true },
        }),
      ]);
      expect(flagged.code).toBe(0);
      expect(jsonOf(flagged)).toMatchObject({ outcome: 'registered' });

      // The flagged profile never landed in the environment directory.
      const envDirMiss = await bareCli([
        'coordination',
        'capabilities',
        '--json',
        jsonArg({ projectId: 'proj-flag-1' }),
      ]);
      expect(envDirMiss.code).toBe(1);
      expect(jsonOf(envDirMiss)).toMatchObject({ outcome: 'not-found' });

      // --state-dir in a later position is stripped before subcommand parsing.
      const midPosition = await bareCli([
        'coordination',
        'capabilities',
        '--state-dir',
        flagStateDir,
        '--json',
        jsonArg({ projectId: 'proj-flag-1' }),
      ]);
      expect(midPosition.code).toBe(0);
      expect(jsonOf(midPosition)).toMatchObject({ outcome: 'inspected' });
    } finally {
      if (originalFleetStateDir === undefined) {
        delete process.env.FLEET_STATE_DIR;
      } else {
        process.env.FLEET_STATE_DIR = originalFleetStateDir;
      }
    }

    // Invalid --state-dir values are usage errors with exit code 2.
    const missingValue = await bareCli(['forge', 'execute', '--state-dir']);
    expect(missingValue.code).toBe(2);
    expect(missingValue.stderr).toContain('Invalid --state-dir value');

    const emptyValue = await bareCli(['work-order', 'inspect', '--state-dir', '']);
    expect(emptyValue.code).toBe(2);
    expect(emptyValue.stderr).toContain('Invalid --state-dir value');

    const flagLikeValue = await bareCli([
      'work-order',
      'inspect',
      '--state-dir',
      '--work-order-id',
      'wo-1',
    ]);
    expect(flagLikeValue.code).toBe(2);
    expect(flagLikeValue.stderr).toContain('Invalid --state-dir value');

    const nulByteValue = await bareCli(['--state-dir=bad\0path']);
    expect(nulByteValue.code).toBe(2);
    expect(nulByteValue.stderr).toContain('Invalid --state-dir value');

    const emptyInlineValue = await bareCli(['--state-dir=']);
    expect(emptyInlineValue.code).toBe(2);
    expect(emptyInlineValue.stderr).toContain('Invalid --state-dir value');
  });
});
