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
  pack?: BuildFactPackResult | 'throw' | 'malformed';
  session?: BriefAuthorSessionResult | 'throw' | 'absent';
  prepare?: PrepareBriefPackageResult | 'throw' | 'malformed';
} = {}): Harness {
  const packCalls: unknown[] = [];
  const sessionCalls: BriefAuthorSessionRequest[] = [];
  const prepareCalls: PrepareBriefPackageRequest[] = [];
  const factPack: BuildFactPackPort = {
    async buildFactPack(request) {
      packCalls.push(request);
      if (options.pack === 'throw') {
        throw new Error('pack exploded');
      }
      if (options.pack === 'malformed') {
        return null as unknown as BuildFactPackResult;
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
          throw new Error('seat exploded at /secret/path');
        }
        return options.session === undefined || options.session === 'absent'
          ? {
              outcome: 'answered', rawAnswer: answerOf(DISPATCH),
              sessionKey: `brief-author/wo-1/lane-1@${COMMIT.slice(0, 12)}`,
              answerPath: '/briefs/stem.answer.md', cached: false,
            }
          : options.session;
      },
    }),
  };
  const prepareBriefPackage = {
    async prepareBriefPackage(request: PrepareBriefPackageRequest) {
      prepareCalls.push(request);
      if (options.prepare === 'throw') {
        throw new Error('freeze exploded');
      }
      if (options.prepare === 'malformed') {
        return null as unknown as PrepareBriefPackageResult;
      }
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
    repositoryPath: '/repo',
    checkoutPath: '/checkout',
    briefsDir: '/briefs',
    commit: COMMIT,
    facts: [{ kind: 'file-list', label: 'Sources', pathPrefix: 'src' }],
    model: 'author-model',
    variant: 'high',
    prepare: { workOrderId: 'wo-1', laneId: 'lane-1', baseCommit: COMMIT } as unknown as AuthorBriefRequest['prepare'],
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
  const result = await author(h, request);
  expect(result).toEqual({ outcome: 'refused', refusal: { reason: 'invalid-request', detail: expect.any(String) } });
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
      sessionKey: `brief-author/wo-1/lane-1@${COMMIT.slice(0, 12)}`,
      prepared: {
        attemptId: 'attempt-1', briefDigest: 'digest-1', prosePath: '/p/brief.md',
        manifestPath: '/p/manifest.json', selectedKnowledgeVersions: [],
      },
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

  it('refuses invalid request shapes, mismatched prepare fields, and missing session port', async () => {
    await expectInvalid(null);
    await expectInvalid('a string');
    await expectInvalid(42);
    await expectInvalid(undefined);
    await expectInvalid([]);
    await expectInvalid(new (class {})());

    for (const field of ['workOrderId', 'laneId', 'repositoryPath', 'checkoutPath', 'briefsDir', 'commit', 'facts', 'model', 'prepare']) {
      await expectInvalid(withRequest((request) => { delete request[field]; }));
    }
    // Mismatched prepare fields.
    await expectInvalid(withRequest((request) => { (request.prepare as Record<string, unknown>).workOrderId = 'other'; }));
    await expectInvalid(withRequest((request) => { (request.prepare as Record<string, unknown>).laneId = 'other'; }));
    await expectInvalid(withRequest((request) => { (request.prepare as Record<string, unknown>).baseCommit = 'b'.repeat(40); }));
    // prepare must not smuggle proseMarkdown.
    await expectInvalid(withRequest((request) => { (request.prepare as Record<string, unknown>).proseMarkdown = 'x'; }));

    // Missing session port.
    const h = harness({ session: 'absent' });
    expect(await author(h, validRequest())).toEqual({
      outcome: 'refused',
      refusal: { reason: 'session-unavailable', detail: 'session-command-missing' },
    });
    expect(h.prepareCalls).toHaveLength(0);
  });

  it('refuses without invoking getters on request, facts, or prepare', async () => {
    let invoked = 0;
    const request = validRequest() as unknown as Record<string, unknown>;
    Object.defineProperty(request, 'model', {
      enumerable: true,
      get() { invoked += 1; return 'author-model'; },
    });
    await expectInvalid(request);
    expect(invoked).toBe(0);

    invoked = 0;
    const factGetter = withRequest((request) => {
      Object.defineProperty((request.facts as Record<string, unknown>[])[0], 'label', {
        enumerable: true,
        get() { invoked += 1; return 'Sources'; },
      });
    });
    await expectInvalid(factGetter);
    expect(invoked).toBe(0);

    invoked = 0;
    const prepareGetter = withRequest((request) => {
      Object.defineProperty(request.prepare as Record<string, unknown>, 'workOrderId', {
        enumerable: true,
        get() { invoked += 1; return 'wo-1'; },
      });
    });
    await expectInvalid(prepareGetter);
    expect(invoked).toBe(0);

    // An own accessor index on the facts array is refused, never invoked.
    invoked = 0;
    const indexGetter = withRequest((request) => {
      const facts = [{ kind: 'file-list', label: 'Sources', pathPrefix: 'src' }] as unknown[];
      Object.defineProperty(facts, 0, {
        enumerable: true,
        get() { invoked += 1; return { kind: 'file-list', label: 'Evil', pathPrefix: 'src' }; },
      });
      request.facts = facts;
    });
    await expectInvalid(indexGetter);
    expect(invoked).toBe(0);
  });

  it('refuses a non-enumerable own proseMarkdown smuggled onto prepare', async () => {
    // `Object.keys` would skip a non-enumerable own property, so the smuggle
    // check must enumerate every own property name.
    const request = validRequest() as unknown as Record<string, unknown>;
    Object.defineProperty(request.prepare as Record<string, unknown>, 'proseMarkdown', {
      enumerable: false,
      value: 'smuggled',
      writable: true,
      configurable: true,
    });
    await expectInvalid(request);
  });

  it('an own __proto__ property never turns into a changed prototype that supplies inherited fields', async () => {
    // The own `commit` is absent; a polluted prototype carrying a valid commit
    // must never satisfy the own-data-property requirement.
    const polluted: Record<string, unknown> = validRequest() as unknown as Record<string, unknown>;
    delete polluted.commit;
    Object.defineProperty(polluted, '__proto__', {
      enumerable: true,
      value: { commit: COMMIT },
      writable: true,
      configurable: true,
    });
    await expectInvalid(polluted);

    // Same for `prepare`: an inherited proseMarkdown from a polluted prototype
    // is not accepted, and the polluted key stays an inert own data property.
    const pollutedPrepare: Record<string, unknown> = validRequest() as unknown as Record<string, unknown>;
    Object.defineProperty(pollutedPrepare.prepare as Record<string, unknown>, '__proto__', {
      enumerable: true,
      value: { proseMarkdown: 'smuggled' },
      writable: true,
      configurable: true,
    });
    const h = harness();
    const result = await author(h, pollutedPrepare);
    expect(result.outcome).toBe('authored');
    expect(h.prepareCalls[0]?.proseMarkdown).toBe(DISPATCH);
  });

  it('refuses sparse facts array, oversized facts list, and control characters in paths', async () => {
    // eslint-disable-next-line no-sparse-arrays
    await expectInvalid(withRequest((request) => { (request.facts as unknown[]) = [, undefined]; }));
    const oversized = Array.from({ length: 33 }, () => ({ kind: 'file-list', label: 'x', pathPrefix: 'src' }));
    await expectInvalid(withRequest((request) => { (request.facts as unknown[]) = oversized; }));
    await expectInvalid(withRequest((request) => { request.workOrderId = 'a\u0000b'; }));
    await expectInvalid(withRequest((request) => { request.briefsDir = '/briefs\u001f'; }));
    await expectInvalid(withRequest((request) => { request.commit = 'ABC'; }));
  });

  it('refuses with fact-pack-refused when BuildFactPackPort refuses or returns a malformed record', async () => {
    const refused = harness({
      pack: { outcome: 'refused', refusal: { reason: 'fact-absent', label: 'Secret Label /x', rule: null } },
    });
    expect(await author(refused, validRequest())).toEqual({
      outcome: 'refused',
      refusal: { reason: 'fact-pack-refused', detail: 'fact-absent' },
    });
    expect(refused.sessionCalls).toHaveLength(0);
    expect(refused.prepareCalls).toHaveLength(0);

    const malformed = harness({ pack: 'malformed' });
    expect(await author(malformed, validRequest())).toEqual({
      outcome: 'refused',
      refusal: { reason: 'fact-pack-refused', detail: 'invalid-fact-pack-result' },
    });

    const emptyPrompt = harness({ pack: { outcome: 'built', prompt: '   ', factCount: 0 } });
    expect(await author(emptyPrompt, validRequest())).toEqual({
      outcome: 'refused',
      refusal: { reason: 'fact-pack-refused', detail: 'empty-fact-pack-prompt' },
    });
  });

  it('refuses with session-unavailable when the seat session is unavailable or malformed', async () => {
    const unavailable = harness({ session: { outcome: 'unavailable', reason: 'checkout-not-pinned' } });
    expect(await author(unavailable, validRequest())).toEqual({
      outcome: 'refused',
      refusal: { reason: 'session-unavailable', detail: 'checkout-not-pinned' },
    });
    expect(unavailable.prepareCalls).toHaveLength(0);

    const unknownReason = harness({ session: { outcome: 'unavailable', reason: 'bogus' as never } });
    expect(await author(unknownReason, validRequest())).toEqual({
      outcome: 'refused',
      refusal: { reason: 'session-unavailable', detail: 'session-failed' },
    });

    const malformed = harness({ session: null as unknown as BriefAuthorSessionResult });
    expect(await author(malformed, validRequest())).toEqual({
      outcome: 'refused',
      refusal: { reason: 'session-unavailable', detail: 'session-failed' },
    });

    const badRaw = harness({ session: { outcome: 'answered', rawAnswer: 42 as never, sessionKey: '', answerPath: '/p', cached: false } });
    expect(await author(badRaw, validRequest())).toEqual({
      outcome: 'refused',
      refusal: { reason: 'session-unavailable', detail: 'session-failed' },
    });
  });

  it('refuses with answer-invalid on a parseBriefAnswer violation and freezes nothing', async () => {
    const h = harness({ session: { outcome: 'answered', rawAnswer: `===NOTES===\n${NOTES_TEXT}\n`, sessionKey: 'k', answerPath: '/p', cached: false } });
    expect(await author(h, validRequest())).toEqual({
      outcome: 'refused',
      refusal: { reason: 'answer-invalid', detail: 'missing-dispatch-marker' },
    });
    expect(h.prepareCalls).toHaveLength(0);
  });

  it('refuses with secret-shaped when the seat answer contains a credential shape', async () => {
    const secret = `AKIA${'ABCDEFGHIJKLMNOP'}`;
    const h = harness({ session: { outcome: 'answered', rawAnswer: answerOf(DISPATCH, `note ${secret}`), sessionKey: 'k', answerPath: '/p', cached: false } });
    const result = await author(h, validRequest());
    expect(result).toEqual({ outcome: 'refused', refusal: { reason: 'secret-shaped', detail: 'secret-shaped' } });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(h.prepareCalls).toHaveLength(0);
  });

  it('refuses with brief-lint-failed and surfaces findings when dispatch text fails lintBrief', async () => {
    const dispatch = DISPATCH.replace('## Challenge this\nThe file list.', '');
    const h = harness({ session: { outcome: 'answered', rawAnswer: answerOf(dispatch), sessionKey: 'k', answerPath: '/p', cached: false } });
    const result = await author(h, validRequest());
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.refusal.reason).toBe('brief-lint-failed');
      expect(result.refusal.detail).toBe('missing-challenge-this');
      expect(result.refusal.findings).toBeDefined();
    }
    expect(h.prepareCalls).toHaveLength(0);
  });

  it('Propagates freeze-rejected when PrepareBriefPackagePort rejects', async () => {
    const plain = harness({ prepare: { outcome: 'rejected', reason: 'cannot place /private/path/brief.md' } });
    expect(await author(plain, validRequest())).toEqual({
      outcome: 'refused',
      refusal: { reason: 'freeze-rejected', detail: 'cannot place /private/path/brief.md' },
    });
    const classed = harness({
      prepare: { outcome: 'rejected', reason: 'shell at /private/path', reasonClass: 'acceptance-spec-shell' },
    });
    expect(await author(classed, validRequest())).toEqual({
      outcome: 'refused',
      refusal: { reason: 'freeze-rejected', detail: 'shell at /private/path' },
    });
    const malformed = harness({ prepare: 'malformed' });
    expect(await author(malformed, validRequest())).toEqual({
      outcome: 'refused',
      refusal: { reason: 'freeze-rejected', detail: 'freeze-rejected' },
    });
  });

  it('catches unexpected port throws and refuses cleanly', async () => {
    const pack = harness({ pack: 'throw' });
    expect(await author(pack, validRequest())).toEqual({
      outcome: 'refused',
      refusal: { reason: 'invalid-request', detail: 'unexpected authoring error' },
    });

    const session = harness({ session: 'throw' });
    const sessionResult = await author(session, validRequest());
    expect(sessionResult).toEqual({
      outcome: 'refused',
      refusal: { reason: 'invalid-request', detail: 'unexpected authoring error' },
    });
    expect(JSON.stringify(sessionResult)).not.toContain('/secret/path');

    const freeze = harness({ prepare: 'throw' });
    expect(await author(freeze, validRequest())).toEqual({
      outcome: 'refused',
      refusal: { reason: 'invalid-request', detail: 'unexpected authoring error' },
    });
  });

  it('never echoes a path or free text in a refusal', async () => {
    const results = await Promise.all([
      author(harness({ pack: { outcome: 'refused', refusal: { reason: 'secret-shaped', label: '/etc/label', rule: 'rule text' } } }), validRequest()),
      author(harness({ session: { outcome: 'unavailable', reason: 'checkout-unreadable' } }), validRequest()),
      author(harness({ prepare: { outcome: 'rejected', reason: 'bad-shell' } }), validRequest()),
      author(harness({ session: { outcome: 'answered', rawAnswer: answerOf(DISPATCH.replace('## Tier\nTier 1\n', '')), sessionKey: 'k', answerPath: '/p', cached: false } }), validRequest()),
      author(harness(), null),
    ]);
    for (const result of results) {
      const text = JSON.stringify(result);
      for (const leaked of ['/etc', '/private', '/repo', '/checkout', '/briefs', 'rule text', 'NOTES-SENTINEL', 'Sources']) {
        expect(text).not.toContain(leaked);
      }
    }
  });
});
