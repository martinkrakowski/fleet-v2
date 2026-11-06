// Lane CO17: AuthorBriefUseCase tests.
import { describe, expect, it } from 'vitest';

import type { AuthorBriefRequest, AuthorBriefResult } from '../../ports/in/AuthorBriefPort.in-port.js';
import type { BuildFactPackPort, BuildFactPackResult } from '../../ports/in/BuildFactPackPort.in-port.js';
import type {
  PrepareBriefPackagePort,
  PrepareBriefPackageRequest,
  PrepareBriefPackageResult,
} from '../../ports/in/PrepareBriefPackagePort.in-port.js';
import type {
  BriefAuthoringPort,
  BriefAuthorSessionRequest,
  BriefAuthorSessionResult,
} from '../../ports/out/BriefAuthoringPort.out-port.js';
import { AuthorBriefUseCase } from '../AuthorBriefUseCase.use-case.js';

const COMMIT = 'a'.repeat(40);
const NOTES_TEXT = 'NOTES-SENTINEL candidate note about the repository';
const DISPATCH = [
  '# Lane brief',
  '## File list',
  '- src/a.ts',
  '## Commands',
  '- yarn test',
  '## Tier',
  'Tier 1',
  '## Size',
  'Size: about 30 minutes',
  '## Commit',
  'Commit: one commit',
  '## Validity',
  'Valid at the base commit.',
  '## Hard to undo',
  'Nothing.',
  '## Assumptions',
  'None.',
  '## Challenge this',
  'The file list.',
].join('\n');

function answerOf(dispatch: string, notes = NOTES_TEXT): string {
  return ['===NOTES===', notes, '===DISPATCH===', dispatch].join('\n');
}

interface Harness {
  readonly useCase: AuthorBriefUseCase;
  readonly packCalls: unknown[];
  readonly sessionCalls: BriefAuthorSessionRequest[];
  readonly prepareCalls: PrepareBriefPackageRequest[];
}

function harness(options: {
  pack?: BuildFactPackResult;
  session?: BriefAuthorSessionResult | 'throw' | 'absent';
  prepare?: PrepareBriefPackageResult;
} = {}): Harness {
  const packCalls: unknown[] = [];
  const sessionCalls: BriefAuthorSessionRequest[] = [];
  const prepareCalls: PrepareBriefPackageRequest[] = [];
  const factPack: BuildFactPackPort = {
    async buildFactPack(request) {
      packCalls.push(request);
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
          throw new Error('seat exploded at /secret/path');
        }
        return options.session === undefined || options.session === 'absent'
          ? { outcome: 'answered', answer: answerOf(DISPATCH) }
          : options.session;
      },
    }),
  };
  const prepareBriefPackage = {
    async prepareBriefPackage(request: PrepareBriefPackageRequest) {
      prepareCalls.push(request);
      return options.prepare ?? {
        outcome: 'prepared',
        prepared: {
          attemptId: 'attempt-1', briefDigest: 'digest-1', prosePath: '/p/brief.md',
          manifestPath: '/p/manifest.json', selectedKnowledgeVersions: [],
        },
      };
    },
  } as unknown as PrepareBriefPackagePort;
  return {
    useCase: new AuthorBriefUseCase({ factPack, briefAuthoring, prepareBriefPackage }),
    packCalls, sessionCalls, prepareCalls,
  };
}

function validRequest(): AuthorBriefRequest {
  return {
    workOrderId: 'wo-1',
    laneId: 'lane-1',
    prepare: { workOrderId: 'wo-1', laneId: 'lane-1', baseCommit: COMMIT } as unknown as AuthorBriefRequest['prepare'],
    factPack: {
      repositoryPath: '/repo',
      commit: COMMIT,
      facts: [{ kind: 'file-list', label: 'Sources', pathPrefix: 'src' }],
    },
    seat: { model: 'author-model', variant: 'high' },
    checkoutPath: '/checkout',
    briefsDir: '/briefs',
  };
}

function withRequest(mutate: (request: Record<string, unknown>) => void): unknown {
  const request = validRequest() as unknown as Record<string, unknown>;
  mutate(request);
  return request;
}

async function author(h: Harness, request: unknown): Promise<AuthorBriefResult> {
  return h.useCase.authorBrief(request as AuthorBriefRequest);
}

async function expectInvalid(request: unknown): Promise<void> {
  const h = harness();
  expect(await author(h, request)).toEqual({ outcome: 'refused', reason: 'invalid-request', detail: null });
  expect(h.packCalls).toHaveLength(0);
  expect(h.sessionCalls).toHaveLength(0);
  expect(h.prepareCalls).toHaveLength(0);
}

describe('AuthorBriefUseCase', () => {
  it('authors a brief: builds the fact pack, runs one session, parses, lints and freezes only the dispatch text', async () => {
    const h = harness();
    const result = await author(h, validRequest());
    expect(result).toEqual({
      outcome: 'authored',
      attemptId: 'attempt-1',
      briefDigest: 'digest-1',
      sessionKey: `brief-author/wo-1/lane-1@${COMMIT.slice(0, 12)}`,
    });
    expect(h.packCalls).toEqual([{
      laneId: 'lane-1', repositoryPath: '/repo', commit: COMMIT,
      facts: [{ kind: 'file-list', label: 'Sources', pathPrefix: 'src' }],
    }]);
    expect(h.sessionCalls).toHaveLength(1);
    expect(h.sessionCalls[0]).toEqual({
      sessionKey: `brief-author/wo-1/lane-1@${COMMIT.slice(0, 12)}`,
      workOrderId: 'wo-1', laneId: 'lane-1', baseCommit: COMMIT,
      checkoutPath: '/checkout', briefsDir: '/briefs',
      prompt: 'FACT-PACK-PROMPT', model: 'author-model', variant: 'high',
    });
    expect(h.prepareCalls).toHaveLength(1);
    expect(h.prepareCalls[0]?.proseMarkdown).toBe(DISPATCH);
  });

  it('the frozen prose contains no notes text', async () => {
    const h = harness();
    const result = await author(h, validRequest());
    expect(result.outcome).toBe('authored');
    expect(h.prepareCalls[0]?.proseMarkdown).not.toContain('NOTES-SENTINEL');
    expect(h.prepareCalls[0]?.proseMarkdown).not.toContain('===NOTES===');
    expect(JSON.stringify(result)).not.toContain('NOTES-SENTINEL');
    expect(JSON.stringify(h.prepareCalls)).not.toContain('NOTES-SENTINEL');
  });

  it('refuses with invalid-request for a null request', async () => {
    await expectInvalid(null);
  });

  it('refuses with invalid-request for a non-object request', async () => {
    await expectInvalid('a string');
    await expectInvalid(42);
    await expectInvalid(undefined);
  });

  it('refuses with invalid-request for a missing field', async () => {
    for (const field of ['workOrderId', 'laneId', 'prepare', 'factPack', 'seat', 'checkoutPath', 'briefsDir']) {
      await expectInvalid(withRequest((request) => { delete request[field]; }));
    }
    await expectInvalid(withRequest((request) => { delete (request.factPack as Record<string, unknown>).commit; }));
    await expectInvalid(withRequest((request) => { delete (request.seat as Record<string, unknown>).model; }));
  });

  it('refuses with invalid-request for a wrong-typed field', async () => {
    await expectInvalid(withRequest((request) => { request.workOrderId = 7; }));
    await expectInvalid(withRequest((request) => { request.laneId = ''; }));
    await expectInvalid(withRequest((request) => { request.prepare = 'nope'; }));
    await expectInvalid(withRequest((request) => { request.briefsDir = null; }));
    await expectInvalid(withRequest((request) => { (request.factPack as Record<string, unknown>).commit = 'ABC'; }));
    await expectInvalid(withRequest((request) => { (request.factPack as Record<string, unknown>).facts = 'x'; }));
    await expectInvalid(withRequest((request) => { (request.seat as Record<string, unknown>).variant = 3; }));
    await expectInvalid(withRequest((request) => {
      ((request.factPack as Record<string, unknown>).facts as Record<string, unknown>[])[0].label = 5;
    }));
  });

  it('refuses with invalid-request for a sparse facts array', async () => {
    // eslint-disable-next-line no-sparse-arrays
    await expectInvalid(withRequest((request) => { (request.factPack as Record<string, unknown>).facts = [, undefined]; }));
  });

  it('refuses with invalid-request for an unknown fact kind', async () => {
    await expectInvalid(withRequest((request) => {
      (request.factPack as Record<string, unknown>).facts = [{ kind: 'shell-command', label: 'x' }];
    }));
  });

  it('refuses with invalid-request for a throwing getter', async () => {
    await expectInvalid(withRequest((request) => {
      Object.defineProperty(request, 'seat', { get() { throw new Error('boom'); }, enumerable: true });
    }));
    await expectInvalid(withRequest((request) => {
      Object.defineProperty(request.factPack, 'facts', { get() { throw new Error('boom'); }, enumerable: true });
    }));
  });

  it('refuses with invalid-request when the prepare ids or base commit disagree', async () => {
    await expectInvalid(withRequest((request) => { (request.prepare as Record<string, unknown>).workOrderId = 'other'; }));
    await expectInvalid(withRequest((request) => { (request.prepare as Record<string, unknown>).laneId = 'other'; }));
    await expectInvalid(withRequest((request) => { (request.prepare as Record<string, unknown>).baseCommit = 'b'.repeat(40); }));
  });

  it('refuses with fact-pack-refused when the fact pack refuses', async () => {
    const h = harness({
      pack: { outcome: 'refused', refusal: { reason: 'fact-absent', label: 'Secret Label /x', rule: null } },
    });
    expect(await author(h, validRequest())).toEqual({ outcome: 'refused', reason: 'fact-pack-refused', detail: 'fact-absent' });
    expect(h.sessionCalls).toHaveLength(0);
    expect(h.prepareCalls).toHaveLength(0);
  });

  it('refuses with seat-unavailable when the seat answers nothing', async () => {
    for (const answer of ['', '  \n\t']) {
      const h = harness({ session: { outcome: 'answered', answer } });
      expect(await author(h, validRequest())).toEqual({ outcome: 'refused', reason: 'seat-unavailable', detail: 'session-empty' });
      expect(h.prepareCalls).toHaveLength(0);
    }
    const unavailable = harness({ session: { outcome: 'unavailable', reason: 'session-timeout' } });
    expect(await author(unavailable, validRequest())).toEqual({ outcome: 'refused', reason: 'seat-unavailable', detail: 'session-timeout' });
    expect(unavailable.prepareCalls).toHaveLength(0);
  });

  it('refuses with seat-unavailable when the port has no seat session', async () => {
    const h = harness({ session: 'absent' });
    expect(await author(h, validRequest())).toEqual({ outcome: 'refused', reason: 'seat-unavailable', detail: 'session-not-supported' });
    expect(h.prepareCalls).toHaveLength(0);
  });

  it('refuses with parse-violation when the answer has no dispatch marker', async () => {
    const h = harness({ session: { outcome: 'answered', answer: `===NOTES===\n${NOTES_TEXT}\n` } });
    expect(await author(h, validRequest())).toEqual({ outcome: 'refused', reason: 'parse-violation', detail: 'missing-dispatch-marker' });
    expect(h.prepareCalls).toHaveLength(0);
  });

  it('refuses with lint-violation when the dispatch misses a required section', async () => {
    const dispatch = DISPATCH.replace('## Challenge this\nThe file list.', '');
    const h = harness({ session: { outcome: 'answered', answer: answerOf(dispatch) } });
    expect(await author(h, validRequest())).toEqual({ outcome: 'refused', reason: 'lint-violation', detail: 'missing-challenge-this' });
    expect(h.prepareCalls).toHaveLength(0);
  });

  it('refuses with secret-shaped when the answer carries a secret shape', async () => {
    const secret = `AKIA${'ABCDEFGHIJKLMNOP'}`;
    const h = harness({ session: { outcome: 'answered', answer: answerOf(DISPATCH, `note ${secret}`) } });
    const result = await author(h, validRequest());
    expect(result).toEqual({ outcome: 'refused', reason: 'secret-shaped', detail: null });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(h.prepareCalls).toHaveLength(0);
  });

  it('refuses with freeze-rejected when the prepare refuses', async () => {
    const plain = harness({ prepare: { outcome: 'rejected', reason: 'cannot place /private/path/brief.md' } });
    expect(await author(plain, validRequest())).toEqual({ outcome: 'refused', reason: 'freeze-rejected', detail: null });
    const classed = harness({
      prepare: { outcome: 'rejected', reason: 'shell at /private/path', reasonClass: 'acceptance-spec-shell' },
    });
    expect(await author(classed, validRequest())).toEqual({
      outcome: 'refused', reason: 'freeze-rejected', detail: 'acceptance-spec-shell',
    });
  });

  it('never echoes a path or free text in a refusal', async () => {
    const results = await Promise.all([
      author(harness({ pack: { outcome: 'refused', refusal: { reason: 'secret-shaped', label: '/etc/label', rule: 'rule text' } } }), validRequest()),
      author(harness({ session: { outcome: 'unavailable', reason: 'checkout-unavailable' } }), validRequest()),
      author(harness({ prepare: { outcome: 'rejected', reason: 'bad /private/path' } }), validRequest()),
      author(harness({ session: { outcome: 'answered', answer: answerOf(DISPATCH.replace('## Tier\nTier 1\n', '')) } }), validRequest()),
      author(harness(), null),
    ]);
    for (const result of results) {
      const text = JSON.stringify(result);
      for (const leaked of ['/etc', '/private', '/repo', '/checkout', '/briefs', 'rule text', 'NOTES-SENTINEL', 'Sources']) {
        expect(text).not.toContain(leaked);
      }
      if (result.outcome === 'refused') {
        expect(result.detail === null || /^[a-z0-9-]+$/.test(result.detail)).toBe(true);
      }
    }
  });

  it('returns unknown when the seat call throws', async () => {
    const h = harness({ session: 'throw' });
    const result = await author(h, validRequest());
    expect(result).toEqual({ outcome: 'unknown', reason: 'seat-call-failed' });
    expect(JSON.stringify(result)).not.toContain('/secret/path');
    expect(h.prepareCalls).toHaveLength(0);
  });
});
