// Lane CO17c: the `brief author` CLI command. One request, one use-case call,
// the result returned unchanged; a malformed invocation is a usage error
// (exit 2) and every seat, parse, lint, freeze or fact-pack failure is a
// refusal-family exit (1). The handler never freezes or dispatches directly.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AuthorBriefUseCase } from '@fleet/work-execution';
import type {
  AuthorBriefRequest,
  BuildFactPackPort,
  BuildFactPackResult,
} from '@fleet/work-execution';
import type {
  PrepareBriefPackagePort,
  PrepareBriefPackageRequest,
  PrepareBriefPackageResult,
} from '@fleet/work-execution';
import type {
  BriefAuthoringPort,
  BriefAuthorSessionRequest,
  BriefAuthorSessionResult,
} from '@fleet/work-execution';

import { runCli, exitCodeForResult } from '../index.js';
import { briefCommands } from '../commands/brief.js';
import { CliUsageError } from '../commands/payload.js';
import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';

const COMMIT = 'a'.repeat(40);
const AUTHOR_MODEL = 'author-model';
const IMPLEMENTER_MODEL = 'implementer-model';

function capturingIo(): { io: { stdout: (t: string) => void; stderr: (t: string) => void }; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { stdout: (t) => stdout.push(t), stderr: (t) => stderr.push(t) },
    stdout,
    stderr,
  };
}

/** Every required flag of a well-formed `brief author` invocation. */
function validPayload(): string[] {
  return [
    '--workOrderId', 'wo-1',
    '--laneId', 'lane-1',
    '--projectId', 'proj-1',
    '--taskId', 'task-1',
    '--repository', 'owner/repo',
    '--baseCommit', COMMIT,
    '--policyRevision', 'pol-1',
    '--model', IMPLEMENTER_MODEL,
    '--fallbackModel', 'fallback-model',
    '--independentReviewer', 'reviewer-model',
    '--authorModel', AUTHOR_MODEL,
    '--checkoutPath', '/checkout',
    '--repositoryPath', '/repo',
    '--worktreePath', '/worktree',
    '--briefsDir', '/briefs',
    '--seatTool', 'opencode',
    '--json', JSON.stringify({
      contextDecisions: [
        {
          proposalId: 'prop-1',
          knowledgeEntryId: 'ke-1',
          version: '1.0.0',
          proposedBecause: 'because',
          accepted: true,
          decisionBecause: 'why',
          extraKey: 'must-not-reach-the-use-case',
        },
      ],
    }),
    '--facts', '[{"kind":"file-list","label":"Sources","pathPrefix":"src"}]',
  ];
}

function briefAuthorArgs(extra: readonly string[] = []): string[] {
  return ['brief', 'author', ...validPayload(), ...extra];
}

/** A runtime whose author use case records its calls and whose direct freeze and dispatch paths refuse to run. */
function guardsRuntime(options: {
  authorBrief?: (request: unknown) => Promise<unknown>;
} = {}): {
  runtime: FleetCliRuntime;
  authorCalls: unknown[];
} {
  const authorCalls: unknown[] = [];
  const runtime = {
    execution: {
      authorBrief: {
        authorBrief: async (request: unknown) => {
          authorCalls.push(request);
          return options.authorBrief !== undefined
            ? options.authorBrief(request)
            : { outcome: 'authored', attemptId: 'att-1', briefDigest: 'digest-1', sessionKey: 'k' };
        },
      },
      prepareBriefPackage: {
        prepareBriefPackage: () => {
          throw new Error('handler must not freeze directly');
        },
      },
      dispatchAttempt: {
        dispatchAttempt: () => {
          throw new Error('handler must not dispatch');
        },
      },
    },
  } as unknown as FleetCliRuntime;
  return { runtime, authorCalls };
}

/** The dispatch text a lint-clean seat answer freezes. */
const LINT_CLEAN_DISPATCH = [
  '# Lane brief',
  'Tier 1. Size: about 45 minutes, one commit.',
  '## File list',
  '- src/a.ts',
  '## Commands',
  '- yarn test',
  '## Validity',
  'Valid at the base commit.',
  '## Hard to undo',
  'Nothing.',
  '## Assumptions',
  'None.',
  '## Challenge this',
  'The file list.',
].join('\n');

const ANSWER_OF = (dispatch: string, notes = 'orchestrator notes'): string =>
  ['===NOTES===', notes, '===DISPATCH===', dispatch].join('\n');

interface AuthoringHarness {
  readonly runtime: FleetCliRuntime;
  readonly packCalls: unknown[];
  readonly sessionCalls: BriefAuthorSessionRequest[];
  readonly prepareCalls: PrepareBriefPackageRequest[];
}

/**
 * A real AuthorBriefUseCase whose fact pack, session port and prepare port
 * are fakes, on a runtime whose direct freeze and dispatch paths refuse to
 * run.
 */
function authoringHarness(options: {
  pack?: BuildFactPackResult | 'throw';
  session?: BriefAuthorSessionResult | 'throw' | 'absent';
  prepare?: PrepareBriefPackageResult | 'throw';
} = {}): AuthoringHarness {
  const packCalls: unknown[] = [];
  const sessionCalls: BriefAuthorSessionRequest[] = [];
  const prepareCalls: PrepareBriefPackageRequest[] = [];
  const factPack: BuildFactPackPort = {
    async buildFactPack(request) {
      packCalls.push(request);
      if (options.pack === 'throw') {
        throw new Error('fact pack exploded');
      }
      return options.pack ?? { outcome: 'built', prompt: 'FACT-PACK-PROMPT', factCount: 1 };
    },
  };
  const briefAuthoring: BriefAuthoringPort = {
    async authorBrief() {
      return { outcome: 'unavailable', reason: 'unused' };
    },
    ...(options.session === 'absent' ? {} : {
      async authorBriefSession(request: BriefAuthorSessionRequest): Promise<BriefAuthorSessionResult> {
        sessionCalls.push(request);
        if (options.session === 'throw') {
          throw new Error('recorded brief answer is unreadable');
        }
        return options.session === undefined || options.session === 'absent'
          ? { outcome: 'answered', answer: ANSWER_OF(LINT_CLEAN_DISPATCH) }
          : options.session;
      },
    }),
  };
  const preparePort = {
    async prepareBriefPackage(request: PrepareBriefPackageRequest) {
      prepareCalls.push(request);
      if (options.prepare === 'throw') {
        throw new Error('freeze exploded');
      }
      return options.prepare ?? {
        outcome: 'prepared',
        prepared: {
          attemptId: 'att-1',
          briefDigest: 'digest-1',
          prosePath: 'x',
          manifestPath: 'y',
          selectedKnowledgeVersions: [],
        },
      };
    },
  } as unknown as PrepareBriefPackagePort;
  const useCase = new AuthorBriefUseCase({ factPack, briefAuthoring, prepareBriefPackage: preparePort });
  const runtime = {
    execution: {
      authorBrief: useCase,
      prepareBriefPackage: {
        prepareBriefPackage: () => {
          throw new Error('handler must not freeze directly');
        },
      },
      dispatchAttempt: {
        dispatchAttempt: () => {
          throw new Error('handler must not dispatch');
        },
      },
    },
  } as unknown as FleetCliRuntime;
  return { runtime, packCalls, sessionCalls, prepareCalls };
}

describe('brief author', () => {
  it('brief with no subcommand names author and prepare and exits 2', async () => {
    const { io, stdout, stderr } = capturingIo();
    const { runtime } = guardsRuntime();
    const exitCode = await runCli(['brief'], io, runtime);
    expect(exitCode).toBe(2);
    expect(stderr.join('')).toContain('author');
    expect(stderr.join('')).toContain('prepare');
    expect(stdout).toHaveLength(0);
  });

  it('the brief command map is exactly author and prepare', () => {
    expect(Object.keys(briefCommands).sort()).toEqual(['author', 'prepare']);
  });

  it('a missing workOrderId is a usage error naming that flag', async () => {
    const { io, stdout, stderr } = capturingIo();
    const { runtime, authorCalls } = guardsRuntime();
    const args = briefAuthorArgs().filter(
      (token, index, all) => !(token === '--workOrderId' || all[index - 1] === '--workOrderId'),
    );
    const exitCode = await runCli(args, io, runtime);
    expect(exitCode).toBe(2);
    expect(stderr.join('')).toContain('brief author requires --workOrderId');
    expect(stdout).toHaveLength(0);
    expect(authorCalls).toHaveLength(0);
  });

  it('a non-hex baseCommit is a usage error', async () => {
    const { io, stdout, stderr } = capturingIo();
    const { runtime, authorCalls } = guardsRuntime();
    const exitCode = await runCli(briefAuthorArgs(['--baseCommit', 'abc123']), io, runtime);
    expect(exitCode).toBe(2);
    expect(stderr.join('')).toContain('40 to 64 lowercase hex');
    expect(stdout).toHaveLength(0);
    expect(authorCalls).toHaveLength(0);
  });

  it('a relative briefsDir is a usage error', async () => {
    const { io, stdout, stderr } = capturingIo();
    const { runtime, authorCalls } = guardsRuntime();
    const exitCode = await runCli(briefAuthorArgs(['--briefsDir', 'relative/briefs']), io, runtime);
    expect(exitCode).toBe(2);
    expect(stderr.join('')).toContain('--briefsDir');
    expect(stdout).toHaveLength(0);
    expect(authorCalls).toHaveLength(0);
  });

  it('a filesystem-root worktreePath is a usage error', async () => {
    // Not only the literal `/`: `/.`, `/foo/..` and `//` all resolve to the
    // filesystem root and must be refused the same way.
    for (const root of ['/', '/.', '/foo/..', '//']) {
      const { io } = capturingIo();
      const { runtime, authorCalls } = guardsRuntime();
      const exitCode = await runCli(briefAuthorArgs(['--worktreePath', root]), io, runtime);
      expect(exitCode).toBe(2);
      expect(authorCalls).toHaveLength(0);
    }
  });

  it('operator prose is not accepted', async () => {
    const { io, stderr } = capturingIo();
    const { runtime, authorCalls } = guardsRuntime();
    const exitCode = await runCli(briefAuthorArgs(['--proseMarkdown', 'hello']), io, runtime);
    expect(exitCode).toBe(2);
    expect(stderr.join('')).toContain('--proseMarkdown');
    expect(authorCalls).toHaveLength(0);

    const second = capturingIo();
    const secondGuards = guardsRuntime();
    const secondExit = await runCli(
      briefAuthorArgs(['--handWrittenBriefPath', '/tmp/x']),
      second.io,
      secondGuards.runtime,
    );
    expect(secondExit).toBe(2);
    expect(second.stderr.join('')).toContain('--handWrittenBriefPath');
    expect(secondGuards.authorCalls).toHaveLength(0);
    expect(second.stdout).toHaveLength(0);
  });

  it('facts must be a JSON array', async () => {
    const { io, stdout, stderr } = capturingIo();
    const { runtime, authorCalls } = guardsRuntime();
    const exitCode = await runCli(briefAuthorArgs(['--facts', '{"length":1e9}']), io, runtime);
    expect(exitCode).toBe(2);
    expect(stderr.join('')).toContain("--facts");
    expect(stdout).toHaveLength(0);
    expect(authorCalls).toHaveLength(0);
  });

  it('more than 32 facts is a usage error and the elements are not read', async () => {
    const { io, stderr } = capturingIo();
    const { runtime, authorCalls } = guardsRuntime();
    const thirtyThree = JSON.stringify(
      Array.from({ length: 33 }, () => ({ kind: 'file-list', label: 'L', pathPrefix: 'src' })),
    );
    const exitCode = await runCli(briefAuthorArgs(['--facts', thirtyThree]), io, runtime);
    expect(exitCode).toBe(2);
    expect(stderr.join('')).toContain('at most 32');
    expect(authorCalls).toHaveLength(0);
  });

  it('a fact of an unknown kind is a usage error', async () => {
    const { io, stderr } = capturingIo();
    const { runtime, authorCalls } = guardsRuntime();
    const exitCode = await runCli(
      briefAuthorArgs(['--facts', '[{"kind":"mystery","label":"L"}]']),
      io,
      runtime,
    );
    expect(exitCode).toBe(2);
    expect(stderr.join('')).toContain('fact 0 is malformed');
    expect(authorCalls).toHaveLength(0);
  });

  it('a throwing facts getter is a usage error', async () => {
    const { runtime } = guardsRuntime();
    const payload: Record<string, unknown> = {
      workOrderId: 'wo-1',
      laneId: 'lane-1',
      projectId: 'proj-1',
      taskId: 'task-1',
      repository: 'owner/repo',
      baseCommit: COMMIT,
      policyRevision: 'pol-1',
      model: IMPLEMENTER_MODEL,
      fallbackModel: 'fallback-model',
      independentReviewer: 'reviewer-model',
      authorModel: AUTHOR_MODEL,
      checkoutPath: '/checkout',
      repositoryPath: '/repo',
      worktreePath: '/worktree',
      briefsDir: '/briefs',
      seatTool: 'opencode',
    };
    Object.defineProperty(payload, 'facts', {
      get() {
        throw new Error('hostile payload');
      },
    });
    let thrown: unknown = null;
    try {
      await briefCommands['author'](payload, runtime);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliUsageError);
    expect((thrown as CliUsageError).message).toBe('brief author could not read its arguments');
  });

  it('a throwing seatPlan getter is a usage error, not a raw escape', async () => {
    const payload: Record<string, unknown> = {
      workOrderId: 'wo-1',
      laneId: 'lane-1',
      projectId: 'proj-1',
      taskId: 'task-1',
      repository: 'owner/repo',
      baseCommit: COMMIT,
      policyRevision: 'pol-1',
      model: IMPLEMENTER_MODEL,
      fallbackModel: 'fallback-model',
      independentReviewer: 'reviewer-model',
      authorModel: AUTHOR_MODEL,
      checkoutPath: '/checkout',
      repositoryPath: '/repo',
      worktreePath: '/worktree',
      briefsDir: '/briefs',
      seatTool: 'opencode',
      facts: [{ kind: 'file-list', label: 'Sources', pathPrefix: 'src' }],
    };
    Object.defineProperty(payload, 'seatPlan', {
      get() {
        throw new Error('hostile seatPlan');
      },
    });
    const { runtime, authorCalls } = guardsRuntime();
    let thrown: unknown = null;
    try {
      await briefCommands['author'](payload, runtime);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliUsageError);
    expect((thrown as CliUsageError).message).toBe('brief author could not read its arguments');
    expect(authorCalls).toHaveLength(0);
  });

  it('model and the seat-plan fields are each read exactly once', async () => {
    const base: Record<string, unknown> = {
      workOrderId: 'wo-1',
      laneId: 'lane-1',
      projectId: 'proj-1',
      taskId: 'task-1',
      repository: 'owner/repo',
      baseCommit: COMMIT,
      policyRevision: 'pol-1',
      model: IMPLEMENTER_MODEL,
      fallbackModel: 'fallback-model',
      independentReviewer: 'reviewer-model',
      authorModel: AUTHOR_MODEL,
      checkoutPath: '/checkout',
      repositoryPath: '/repo',
      worktreePath: '/worktree',
      briefsDir: '/briefs',
      seatTool: 'opencode',
      facts: [{ kind: 'file-list', label: 'Sources', pathPrefix: 'src' }],
      // A seat plan with no modelAssignment makes the handler evaluate the
      // plan-selection branch, so a second `model` read would throw here.
      seatPlan: {
        version: 1,
        'first-pass': [{ id: 's1', model: 'plan-model', tool: 'opencode' }],
        fix: [{ id: 's2', model: 'plan-model', tool: 'opencode' }],
        review: [],
      },
    };
    const reads = new Map<string, number>();
    const payload = new Proxy(base, {
      get(target, key, receiver) {
        const name = String(key);
        reads.set(name, (reads.get(name) ?? 0) + 1);
        if (name === 'model' && (reads.get(name) ?? 0) > 1) {
          throw new Error('model was read twice');
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const { runtime } = guardsRuntime({
      authorBrief: async () => ({ outcome: 'authored', attemptId: 'att-1', briefDigest: 'digest-1', sessionKey: 'k' }),
    });
    const result = (await briefCommands['author'](payload, runtime)) as { outcome: string };
    expect(result.outcome).toBe('authored');
    expect(reads.get('model')).toBe(1);
  });

  it('authorModel and the implementer model stay distinct', async () => {
    const { io, stdout } = capturingIo();
    let captured: AuthorBriefRequest | undefined;
    const { runtime } = guardsRuntime({
      authorBrief: async (request) => {
        captured = request as AuthorBriefRequest;
        return { outcome: 'authored', attemptId: 'att-1', briefDigest: 'digest-1', sessionKey: 'k' };
      },
    });
    const exitCode = await runCli(briefAuthorArgs(), io, runtime);
    expect(exitCode).toBe(0);
    expect(captured).toBeDefined();
    const request = captured as AuthorBriefRequest;
    expect(request.seat.model).toBe(AUTHOR_MODEL);
    expect(request.prepare.modelAssignment.model).toBe(IMPLEMENTER_MODEL);
    expect(request.prepare.baseCommit).toBe(COMMIT);
    expect(request.factPack.commit).toBe(COMMIT);
    expect(request.prepare.workOrderId).toBe(request.workOrderId);
    expect('proseMarkdown' in request.prepare).toBe(false);
    // The decisions reach the use case as fresh plain objects with only the
    // allowlisted keys, never as the payload's own objects.
    const decisions = JSON.parse(JSON.stringify(request.prepare.contextDecisions)) as Array<Record<string, unknown>>;
    expect(decisions).toEqual([
      {
        proposalId: 'prop-1',
        knowledgeEntryId: 'ke-1',
        version: '1.0.0',
        proposedBecause: 'because',
        accepted: true,
        decisionBecause: 'why',
      },
    ]);
    expect(stdout.join('')).toContain('authored');
  });

  it('a lint-clean seat answer is authored from the dispatch text only', async () => {
    const { io, stdout, stderr } = capturingIo();
    const harness = authoringHarness({
      session: { outcome: 'answered', answer: `===NOTES===\nNOTES_SENTINEL_not_in_dispatch\n===DISPATCH===\n${LINT_CLEAN_DISPATCH}` },
    });
    const exitCode = await runCli(briefAuthorArgs(), io, harness.runtime);
    expect(exitCode).toBe(0);
    expect(harness.sessionCalls).toHaveLength(1);
    expect(harness.prepareCalls).toHaveLength(1);
    const prose = harness.prepareCalls[0]?.proseMarkdown;
    expect(prose).toBe(LINT_CLEAN_DISPATCH);
    expect(prose).not.toContain('NOTES_SENTINEL_not_in_dispatch');
    expect(prose).not.toContain('===NOTES===');
    expect(JSON.parse(stdout.join(''))).toEqual({
      outcome: 'authored',
      attemptId: 'att-1',
      briefDigest: 'digest-1',
      sessionKey: `brief-author/wo-1/lane-1@${COMMIT.slice(0, 12)}`,
    });
    expect(stdout.join('')).not.toContain('NOTES_SENTINEL_not_in_dispatch');
    expect(stderr).toHaveLength(0);
  });

  it('a whitespace-only answer is refused and nothing is frozen', async () => {
    const { io, stdout } = capturingIo();
    const harness = authoringHarness({ session: { outcome: 'answered', answer: ' \n\t' } });
    const exitCode = await runCli(briefAuthorArgs(), io, harness.runtime);
    expect(JSON.parse(stdout.join(''))).toEqual({
      outcome: 'refused',
      reason: 'seat-unavailable',
      detail: 'session-empty',
    });
    expect(harness.prepareCalls).toHaveLength(0);
    expect(exitCode).toBe(1);
  });

  it('a seat timeout is refused with detail session-timeout', async () => {
    const { io, stdout } = capturingIo();
    const harness = authoringHarness({
      session: { outcome: 'unavailable', reason: 'session-timeout' },
    });
    const exitCode = await runCli(briefAuthorArgs(), io, harness.runtime);
    expect(JSON.parse(stdout.join(''))).toEqual({
      outcome: 'refused',
      reason: 'seat-unavailable',
      detail: 'session-timeout',
    });
    expect(harness.prepareCalls).toHaveLength(0);
    expect(exitCode).toBe(1);
  });

  it('a non-zero seat exit is refused with detail session-failed', async () => {
    const { io, stdout } = capturingIo();
    const harness = authoringHarness({
      session: { outcome: 'unavailable', reason: 'session-failed' },
    });
    const exitCode = await runCli(briefAuthorArgs(), io, harness.runtime);
    const result = JSON.parse(stdout.join(''));
    expect(result.detail).toBe('session-failed');
    expect(result.reason).toBe('seat-unavailable');
    expect(exitCode).toBe(1);
    expect(harness.prepareCalls).toHaveLength(0);
  });

  it('an unreadable answer file is unknown and the throw text is not printed', async () => {
    const { io, stdout, stderr } = capturingIo();
    const harness = authoringHarness({ session: 'throw' });
    const exitCode = await runCli(briefAuthorArgs(), io, harness.runtime);
    expect(JSON.parse(stdout.join(''))).toEqual({ outcome: 'unknown', reason: 'seat-call-failed' });
    expect(exitCode).toBe(1);
    expect(stderr).toHaveLength(0);
    expect(stderr.join('')).not.toContain('unreadable');
  });

  it('a secret-shaped answer is refused and the token is not in the output', async () => {
    const token = ['gh', 'p_', 'a1B2c3D4'.repeat(4)].join('');
    const { io, stdout, stderr } = capturingIo();
    const harness = authoringHarness({
      session: { outcome: 'answered', answer: ANSWER_OF(LINT_CLEAN_DISPATCH, `note with ${token} inside`) },
    });
    const exitCode = await runCli(briefAuthorArgs(), io, harness.runtime);
    expect(JSON.parse(stdout.join(''))).toEqual({
      outcome: 'refused',
      reason: 'secret-shaped',
      detail: null,
    });
    expect(harness.prepareCalls).toHaveLength(0);
    expect(stdout.join('')).not.toContain(token);
    expect(stderr.join('')).not.toContain(token);
    expect(exitCode).toBe(1);
  });

  it('a brief that fails lint names the failing rule and is not frozen', async () => {
    const { io, stdout } = capturingIo();
    const withoutFileList = LINT_CLEAN_DISPATCH
      .split('\n')
      .filter((line) => line !== '## File list' && line !== '- src/a.ts')
      .join('\n');
    const harness = authoringHarness({
      session: { outcome: 'answered', answer: ANSWER_OF(withoutFileList) },
    });
    const exitCode = await runCli(briefAuthorArgs(), io, harness.runtime);
    expect(JSON.parse(stdout.join(''))).toEqual({
      outcome: 'refused',
      reason: 'lint-violation',
      detail: 'missing-file-list',
    });
    expect(harness.prepareCalls).toHaveLength(0);
    expect(exitCode).toBe(1);
  });

  it('an answer with no notes marker is a parse refusal', async () => {
    const { io, stdout } = capturingIo();
    const harness = authoringHarness({ session: { outcome: 'answered', answer: 'hello' } });
    const exitCode = await runCli(briefAuthorArgs(), io, harness.runtime);
    expect(JSON.parse(stdout.join(''))).toEqual({
      outcome: 'refused',
      reason: 'parse-violation',
      detail: 'missing-notes-marker',
    });
    expect(harness.prepareCalls).toHaveLength(0);
    expect(exitCode).toBe(1);
  });

  it('a fact-pack refusal is returned unchanged', async () => {
    const { io, stdout } = capturingIo();
    const harness = authoringHarness({
      pack: { outcome: 'refused', refusal: { reason: 'fact-absent', label: 'L', rule: null } },
    });
    const exitCode = await runCli(briefAuthorArgs(), io, harness.runtime);
    expect(JSON.parse(stdout.join(''))).toEqual({
      outcome: 'refused',
      reason: 'fact-pack-refused',
      detail: 'fact-absent',
    });
    expect(harness.sessionCalls).toHaveLength(0);
    expect(exitCode).toBe(1);
  });

  it('a fact pack that throws is fact-pack-refused', async () => {
    const { io, stdout } = capturingIo();
    const harness = authoringHarness({ pack: 'throw' });
    const exitCode = await runCli(briefAuthorArgs(), io, harness.runtime);
    expect(JSON.parse(stdout.join(''))).toEqual({
      outcome: 'refused',
      reason: 'fact-pack-refused',
      detail: 'invalid-request',
    });
    expect(exitCode).toBe(1);
  });

  it('a freeze rejection is freeze-rejected and a freeze throw is unknown', async () => {
    const rejected = capturingIo();
    const rejectedHarness = authoringHarness({
      prepare: { outcome: 'rejected', reason: 'worktreePath is required', reasonClass: 'acceptance-spec-shell' },
    });
    const rejectedExit = await runCli(briefAuthorArgs(), rejected.io, rejectedHarness.runtime);
    expect(JSON.parse(rejected.stdout.join(''))).toEqual({
      outcome: 'refused',
      reason: 'freeze-rejected',
      detail: 'acceptance-spec-shell',
    });
    expect(rejectedExit).toBe(1);

    const thrown = capturingIo();
    const thrownHarness = authoringHarness({ prepare: 'throw' });
    const thrownExit = await runCli(briefAuthorArgs(), thrown.io, thrownHarness.runtime);
    expect(JSON.parse(thrown.stdout.join(''))).toEqual({
      outcome: 'unknown',
      reason: 'session-outcome-unknown',
    });
    expect(thrownExit).toBe(1);
    expect(thrown.stdout.join('')).not.toContain('authored');
  });

  it('a port with no authorBriefSession is seat-unavailable', async () => {
    const { io, stdout } = capturingIo();
    const harness = authoringHarness({ session: 'absent' });
    const exitCode = await runCli(briefAuthorArgs(), io, harness.runtime);
    expect(JSON.parse(stdout.join(''))).toEqual({
      outcome: 'refused',
      reason: 'seat-unavailable',
      detail: 'session-not-supported',
    });
    expect(exitCode).toBe(1);
  });

  it("the composed runtime's authorBrief is the real use case and an invalid commit is not success", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'fleet-brief-author-'));
    const runtime = createFleetCliRuntime({ stateDir });
    expect(runtime.execution.authorBrief).toBeInstanceOf(AuthorBriefUseCase);
    const request = {
      workOrderId: 'wo-1',
      laneId: 'lane-1',
      prepare: { workOrderId: 'wo-1', laneId: 'lane-1', baseCommit: 'abc' },
      factPack: { repositoryPath: '/repo', commit: 'abc', facts: [] },
      seat: { model: AUTHOR_MODEL },
      checkoutPath: '/checkout',
      briefsDir: '/briefs',
    } as unknown as AuthorBriefRequest;
    const result = await runtime.execution.authorBrief.authorBrief(request);
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request', detail: null });
    expect(exitCodeForResult(result)).toBe(1);
    expect(exitCodeForResult({ outcome: 'unknown', reason: 'seat-call-failed' })).toBe(1);
  });
});
