// Lane CO24b: attempt coordinate enforcement in ActionAuthorizationAdapter.
import { LANE_DIFF_SECRET_PATTERNS, SECRET_PATTERNS } from '@fleet/shared';
import { describe, expect, it } from 'vitest';

import type { AttemptRecord, WorkOrderRecord } from '../../../domain/execution-records.js';
import type {
  ExecuteAuthorizedForgeActionPort,
  ExecuteAuthorizedForgeActionRequest,
} from '../../../application/ports/in/ExecuteAuthorizedForgeActionPort.in-port.js';
import type {
  PullRequestFinding,
  PullRequestFindingsReadPort,
  PullRequestFindingsRequest,
  PullRequestFindingsResult,
} from '../../../application/ports/out/PullRequestFindingsReadPort.out-port.js';
import type {
  ConsumeActionAuthorizationRequest,
  ConsumeActionAuthorizationResult,
  ResolveActionAuthorizationRequest,
  ResolveActionAuthorizationResult,
} from '../../../application/ports/out/ActionAuthorizationPort.out-port.js';
import type {
  ForgeActionPort,
  ForgeActionRequest,
} from '../../../application/ports/out/ForgeActionPort.out-port.js';
import { ExecuteAuthorizedForgeActionUseCase } from '../../../application/use-cases/ExecuteAuthorizedForgeActionUseCase.use-case.js';
import { PreparePullRequestFeedbackFixUseCase } from '../../../application/use-cases/PreparePullRequestFeedbackFixUseCase.use-case.js';
import {
  ACTION_AUTHORIZATION_GRANT_SCHEMA_VERSION,
  ActionAuthorizationAdapter,
  MAX_ACTION_AUTHORIZATION_GRANTS,
  parseActionAuthorizationGrantEntry,
  type ActionAuthorizationGrantEntry,
} from '../ActionAuthorizationAdapter.adapter.js';
import { AttemptRepositoryAdapter } from '../AttemptRepositoryAdapter.adapter.js';
import { ExecutionJournalAdapter } from '../ExecutionJournalAdapter.adapter.js';
import { WorkOrderRepositoryAdapter } from '../WorkOrderRepositoryAdapter.adapter.js';

const HEAD_SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const NOW = '2026-11-06T00:20:00Z';

type Grants = Map<string, ActionAuthorizationGrantEntry>;

function grantEntry(overrides: Record<string, unknown> = {}): ActionAuthorizationGrantEntry {
  return {
    attemptId: 'att-1',
    expectedHeadSha: HEAD_SHA,
    kind: 'push-to-pr',
    consumedByActionId: null,
    ...overrides,
  } as ActionAuthorizationGrantEntry;
}

function grantsOf(entry: ActionAuthorizationGrantEntry = grantEntry()): Grants {
  return new Map<string, ActionAuthorizationGrantEntry>([['grant-1', entry]]);
}

function consumeRequest(overrides: Partial<ConsumeActionAuthorizationRequest> = {}): ConsumeActionAuthorizationRequest {
  return {
    authorizationGrantId: 'grant-1',
    actionId: 'action-1',
    actionKind: 'push-to-pr',
    expectedHeadSha: HEAD_SHA,
    attemptId: 'att-1',
    ...overrides,
  };
}

function resolveRequest(overrides: Partial<ResolveActionAuthorizationRequest> = {}): ResolveActionAuthorizationRequest {
  return {
    actionId: 'action-1',
    projectId: 'project-1',
    workOrderId: 'wo-1',
    attemptId: 'att-1',
    actionKind: 'push-to-pr',
    expectedHeadSha: HEAD_SHA,
    policyRevision: 'policy-7',
    ...overrides,
  };
}

function syntheticToken(): string {
  return ['ghp', 'x'.repeat(24)].join('_');
}

function syntheticPath(): string {
  return ['', 'home', 'operator', '.ssh', 'id_ed25519'].join('/');
}

function expectNoDisallowedText(value: unknown): void {
  const text = JSON.stringify(value);
  for (const pattern of SECRET_PATTERNS) {
    expect(pattern.test(text)).toBe(false);
  }
  for (const entry of LANE_DIFF_SECRET_PATTERNS) {
    expect(entry.regex.test(text)).toBe(false);
  }
  expect(text.includes('/home/')).toBe(false);
}

describe('ActionAuthorizationAdapter attempt coordinate', () => {
  it('refuses consume on attempt mismatch and leaves the grant unconsumed', async () => {
    const grants = grantsOf();
    const adapter = new ActionAuthorizationAdapter({ grants });

    const result = await adapter.consumeActionAuthorization(consumeRequest({ attemptId: 'att-2' }));

    expect(result).toEqual({ outcome: 'refused', reason: 'grant-attempt-mismatch' });
    expect(grants.get('grant-1')?.consumedByActionId).toBeNull();
  });

  it('refuses consume when attemptId is omitted for an attempt-bound grant', async () => {
    const grants = grantsOf();
    const adapter = new ActionAuthorizationAdapter({ grants });

    const omitted = await adapter.consumeActionAuthorization(consumeRequest({ attemptId: undefined }));
    const undefinedOwn = await adapter.consumeActionAuthorization({ ...consumeRequest(), attemptId: undefined });

    expect(omitted).toEqual({ outcome: 'refused', reason: 'grant-attempt-required' });
    expect(undefinedOwn).toEqual({ outcome: 'refused', reason: 'grant-attempt-required' });
    expect(grants.get('grant-1')?.consumedByActionId).toBeNull();
  });

  it('blocks resolve when unconsumed grants belong to a different attempt', async () => {
    const adapter = new ActionAuthorizationAdapter({ grants: grantsOf() });

    const other = await adapter.resolveActionAuthorization(resolveRequest({ attemptId: 'att-2' }));
    const own = await adapter.resolveActionAuthorization(resolveRequest());

    expect(other).toEqual({ outcome: 'blocked', reason: 'no-matching-grant' });
    expect(own).toEqual({ outcome: 'granted', authorizationGrantId: 'grant-1' });
  });

  it('refuses on kind mismatch, missing head, mismatched head and unknown grant with the established wording', async () => {
    const adapter = new ActionAuthorizationAdapter({ grants: grantsOf() });

    expect(await adapter.consumeActionAuthorization(consumeRequest({ actionKind: 'merge-pr' }))).toEqual({
      outcome: 'refused',
      reason: 'grant-kind-mismatch',
    });
    expect(await adapter.consumeActionAuthorization(consumeRequest({ expectedHeadSha: undefined }))).toEqual({
      outcome: 'refused',
      reason: 'Authorization grant grant-1 requires the expectedHeadSha this local grant store cannot infer',
    });
    expect(await adapter.consumeActionAuthorization(consumeRequest({ expectedHeadSha: OTHER_SHA }))).toEqual({
      outcome: 'refused',
      reason: 'grant-head-mismatch',
    });
    expect(await adapter.consumeActionAuthorization(consumeRequest({ authorizationGrantId: 'grant-9' }))).toEqual({
      outcome: 'refused',
      reason: 'Authorization grant not found: grant-9',
    });
  });

  it('parses schemaVersion 2 grants, accepts legacy v1 grants without attemptId, and refuses unknown schema versions', async () => {
    expect(ACTION_AUTHORIZATION_GRANT_SCHEMA_VERSION).toBe(2);

    const v2 = parseActionAuthorizationGrantEntry(grantEntry({ schemaVersion: 2 }));
    expect(v2).toMatchObject({ ok: true, schemaVersion: 2, grant: { attemptId: 'att-1', schemaVersion: 2 } });
    expect(parseActionAuthorizationGrantEntry(grantEntry({ schemaVersion: 2, attemptId: undefined }))).toEqual({
      ok: false,
      reason: 'malformed',
    });
    const v2Missing = { schemaVersion: 2, expectedHeadSha: HEAD_SHA, kind: 'push-to-pr', consumedByActionId: null };
    expect(parseActionAuthorizationGrantEntry(v2Missing)).toEqual({ ok: false, reason: 'malformed' });
    expect(parseActionAuthorizationGrantEntry(grantEntry({ schemaVersion: 2, attemptId: '' }))).toEqual({
      ok: false,
      reason: 'malformed',
    });

    const legacy = { expectedHeadSha: HEAD_SHA, kind: 'push-to-pr', consumedByActionId: null };
    expect(parseActionAuthorizationGrantEntry(legacy)).toMatchObject({ ok: true, schemaVersion: 1 });
    expect(parseActionAuthorizationGrantEntry({ ...legacy, schemaVersion: 1 })).toMatchObject({
      ok: true,
      schemaVersion: 1,
    });
    expect(parseActionAuthorizationGrantEntry({ ...legacy, attemptId: undefined })).toMatchObject({
      ok: true,
      schemaVersion: 1,
    });
    let getterRuns = 0;
    const accessor = { ...legacy };
    Object.defineProperty(accessor, 'attemptId', {
      enumerable: true,
      get() {
        getterRuns += 1;
        return 'att-1';
      },
    });
    expect(parseActionAuthorizationGrantEntry(accessor)).toEqual({ ok: false, reason: 'malformed' });
    expect(getterRuns).toBe(0);
    const hidden = { ...legacy };
    Object.defineProperty(hidden, 'attemptId', { enumerable: false, value: 'att-1' });
    expect(parseActionAuthorizationGrantEntry(hidden)).toEqual({ ok: false, reason: 'malformed' });

    for (const schemaVersion of [3, 0]) {
      expect(parseActionAuthorizationGrantEntry({ ...legacy, schemaVersion })).toEqual({
        ok: false,
        reason: 'unknown-schema-version',
      });
    }

    for (const schemaVersion of [undefined, 1] as const) {
      const legacyGrants = grantsOf({
        ...(schemaVersion === undefined ? {} : { schemaVersion }),
        expectedHeadSha: HEAD_SHA,
        kind: 'push-to-pr',
        consumedByActionId: null,
      } as ActionAuthorizationGrantEntry);
      const adapter = new ActionAuthorizationAdapter({ grants: legacyGrants });

      expect(await adapter.resolveActionAuthorization(resolveRequest())).toEqual({
        outcome: 'granted',
        authorizationGrantId: 'grant-1',
      });
      expect(legacyGrants.get('grant-1')).toEqual({
        schemaVersion: 2,
        attemptId: 'att-1',
        expectedHeadSha: HEAD_SHA,
        kind: 'push-to-pr',
        consumedByActionId: null,
      });
      expect(await adapter.resolveActionAuthorization(resolveRequest({ attemptId: 'att-2' }))).toEqual({
        outcome: 'blocked',
        reason: 'no-matching-grant',
      });
    }

    const legacyConsume = grantsOf({
      expectedHeadSha: HEAD_SHA,
      kind: 'push-to-pr',
      consumedByActionId: null,
    } as ActionAuthorizationGrantEntry);
    const consumer = new ActionAuthorizationAdapter({ grants: legacyConsume });
    expect(await consumer.consumeActionAuthorization(consumeRequest())).toEqual({
      outcome: 'consumed',
      actionId: 'action-1',
    });
    expect(legacyConsume.get('grant-1')).toEqual({
      schemaVersion: 2,
      attemptId: 'att-1',
      expectedHeadSha: HEAD_SHA,
      kind: 'push-to-pr',
      consumedByActionId: 'action-1',
    });

    const v2Grants = grantsOf(grantEntry({ schemaVersion: 2 }));
    const v2Adapter = new ActionAuthorizationAdapter({ grants: v2Grants });
    expect(await v2Adapter.consumeActionAuthorization(consumeRequest())).toEqual({
      outcome: 'consumed',
      actionId: 'action-1',
    });
    expect(v2Grants.get('grant-1')?.schemaVersion).toBe(2);

    for (const schemaVersion of [3, 0]) {
      const unknown = grantsOf(grantEntry({ schemaVersion }));
      const before = unknown.get('grant-1');
      const adapter = new ActionAuthorizationAdapter({ grants: unknown });

      expect(await adapter.resolveActionAuthorization(resolveRequest())).toEqual({
        outcome: 'blocked',
        reason: 'unknown-grant-schema-version',
      });
      expect(await adapter.consumeActionAuthorization(consumeRequest())).toEqual({
        outcome: 'refused',
        reason: 'unknown-grant-schema-version',
      });
      expect(unknown.get('grant-1')).toBe(before);
    }
  });

  it('keeps a consumed legacy grant readable when the consume request carries no attempt', async () => {
    const grants = grantsOf({
      expectedHeadSha: HEAD_SHA,
      kind: 'push-to-pr',
      consumedByActionId: null,
    } as ActionAuthorizationGrantEntry);
    const adapter = new ActionAuthorizationAdapter({ grants });

    const first = await adapter.consumeActionAuthorization(consumeRequest({ attemptId: undefined }));
    const retry = await adapter.consumeActionAuthorization(consumeRequest({ attemptId: undefined }));

    expect(first).toEqual({ outcome: 'consumed', actionId: 'action-1' });
    expect(retry).toEqual({ outcome: 'consumed', actionId: 'action-1' });
    expect(grants.get('grant-1')?.attemptId).toBeUndefined();
  });

  it('preserves Not implemented error when neither delegate nor grants map is configured', async () => {
    for (const adapter of [new ActionAuthorizationAdapter(), new ActionAuthorizationAdapter({})]) {
      await expect(adapter.resolveActionAuthorization(resolveRequest())).rejects.toThrow(
        'Not implemented: ActionAuthorizationAdapter.resolveActionAuthorization',
      );
      await expect(adapter.consumeActionAuthorization(consumeRequest())).rejects.toThrow(
        'Not implemented: ActionAuthorizationAdapter.consumeActionAuthorization',
      );
      await expect(adapter.resolveActionAuthorization(null as never)).rejects.toThrow(
        'Not implemented: ActionAuthorizationAdapter.resolveActionAuthorization',
      );
    }
  });

  it('never throws on hostile runtime inputs or malformed stored grants and returns typed refusals', async () => {
    const adapter = new ActionAuthorizationAdapter({ grants: grantsOf() });
    const throwingGetter = { ...consumeRequest() };
    Object.defineProperty(throwingGetter, 'actionId', {
      enumerable: true,
      get() {
        throw new Error('getter exploded');
      },
    });
    const throwingAttempt = { ...consumeRequest() };
    Object.defineProperty(throwingAttempt, 'attemptId', {
      enumerable: true,
      get() {
        throw new Error('getter exploded');
      },
    });
    const hostileProxy = new Proxy(
      {},
      {
        get() {
          throw new Error('trap');
        },
        getOwnPropertyDescriptor() {
          throw new Error('trap');
        },
        getPrototypeOf() {
          throw new Error('trap');
        },
        ownKeys() {
          throw new Error('trap');
        },
      },
    );
    const sparse: unknown = new Array(2);
    const consumeInputs: unknown[] = [
      null,
      undefined,
      42,
      'text',
      [],
      sparse,
      {},
      { ...consumeRequest(), actionId: 7 },
      { ...consumeRequest(), actionId: '' },
      { ...consumeRequest(), actionId: '   ' },
      { ...consumeRequest(), actionKind: 'delete-everything' },
      { ...consumeRequest(), expectedHeadSha: 7 },
      { ...consumeRequest(), expectedHeadSha: '' },
      { ...consumeRequest(), attemptId: 7 },
      { ...consumeRequest(), attemptId: '' },
      { ...consumeRequest(), attemptId: 'a/b' },
      throwingGetter,
      throwingAttempt,
      hostileProxy,
    ];
    for (const input of consumeInputs) {
      const result = await adapter.consumeActionAuthorization(input as ConsumeActionAuthorizationRequest);
      expect(result.outcome).toBe('refused');
      expect(result).toEqual({ outcome: 'refused', reason: expect.any(String) });
    }
    const resolveInputs: unknown[] = [
      null,
      42,
      [],
      sparse,
      {},
      { ...resolveRequest(), actionKind: 'delete-everything' },
      { ...resolveRequest(), projectId: undefined },
      { ...resolveRequest(), policyRevision: 7 },
      { ...resolveRequest(), attemptId: '' },
      hostileProxy,
    ];
    for (const input of resolveInputs) {
      const result = await adapter.resolveActionAuthorization(input as ResolveActionAuthorizationRequest);
      expect(result.outcome).toBe('blocked');
    }

    const getterEntry = grantEntry();
    Object.defineProperty(getterEntry, 'kind', {
      enumerable: true,
      get() {
        throw new Error('getter exploded');
      },
    });
    const malformedEntries: unknown[] = [
      null,
      42,
      'text',
      [],
      {},
      grantEntry({ kind: 'delete-everything' }),
      grantEntry({ expectedHeadSha: 7 }),
      grantEntry({ expectedHeadSha: '' }),
      grantEntry({ consumedByActionId: 7 }),
      grantEntry({ consumedByActionId: undefined }),
      grantEntry({ attemptId: 7 }),
      getterEntry,
      hostileProxy,
    ];
    for (const entry of malformedEntries) {
      const grants = new Map<string, unknown>([['grant-1', entry]]);
      const corrupt = new ActionAuthorizationAdapter({ grants: grants as Grants });
      const before = grants.get('grant-1');

      expect(await corrupt.resolveActionAuthorization(resolveRequest())).toEqual({
        outcome: 'blocked',
        reason: 'invalid-grant-record',
      });
      expect(await corrupt.consumeActionAuthorization(consumeRequest())).toEqual({
        outcome: 'refused',
        reason: 'invalid-grant-record',
      });
      expect(grants.get('grant-1')).toBe(before);
    }
  });

  it('recovers cleanly when a resolveGrant or consumeGrant delegate rejects mid-call leaving grant state intact', async () => {
    const grants = grantsOf();
    const snapshot = { ...grants.get('grant-1') };
    let failing = true;
    let calls = 0;
    const adapter = new ActionAuthorizationAdapter({
      grants,
      resolveGrant: async (request) => {
        calls += 1;
        if (failing) {
          throw new Error('aborted mid-call');
        }
        return { outcome: 'granted', authorizationGrantId: `grant-for-${request.attemptId}` };
      },
      consumeGrant: (request) => {
        calls += 1;
        if (failing) {
          return Promise.reject(new Error('aborted mid-call'));
        }
        return Promise.resolve({ outcome: 'consumed', actionId: request.actionId });
      },
    });
    const syncThrow = new ActionAuthorizationAdapter({
      resolveGrant: () => {
        throw new Error('sync throw');
      },
      consumeGrant: () => {
        throw new Error('sync throw');
      },
    });

    expect(await adapter.resolveActionAuthorization(resolveRequest())).toEqual({
      outcome: 'blocked',
      reason: 'authorization-unavailable',
    });
    expect(await adapter.consumeActionAuthorization(consumeRequest())).toEqual({
      outcome: 'refused',
      reason: 'authorization-unavailable',
    });
    expect(await syncThrow.resolveActionAuthorization(resolveRequest())).toEqual({
      outcome: 'blocked',
      reason: 'authorization-unavailable',
    });
    expect(await syncThrow.consumeActionAuthorization(consumeRequest())).toEqual({
      outcome: 'refused',
      reason: 'authorization-unavailable',
    });
    expect(grants.get('grant-1')).toEqual(snapshot);

    failing = false;
    expect(await adapter.resolveActionAuthorization(resolveRequest())).toEqual({
      outcome: 'granted',
      authorizationGrantId: 'grant-for-att-1',
    });
    expect(await adapter.consumeActionAuthorization(consumeRequest())).toEqual({
      outcome: 'consumed',
      actionId: 'action-1',
    });
    expect(calls).toBe(4);
    expect(grants.get('grant-1')).toEqual(snapshot);
  });

  it('consumes idempotently for the same actionId and coordinates while refusing a second actionId or mismatched replay', async () => {
    const grants = grantsOf();
    const adapter = new ActionAuthorizationAdapter({ grants });

    const first = await adapter.consumeActionAuthorization(consumeRequest());
    const stored = grants.get('grant-1');
    const replay = await adapter.consumeActionAuthorization(consumeRequest());

    expect(first).toEqual({ outcome: 'consumed', actionId: 'action-1' });
    expect(replay).toEqual({ outcome: 'consumed', actionId: 'action-1' });
    expect(grants.get('grant-1')).toBe(stored);
    expect(stored?.consumedByActionId).toBe('action-1');
    expect(await adapter.consumeActionAuthorization(consumeRequest({ actionId: 'action-2' }))).toEqual({
      outcome: 'refused',
      reason: 'Authorization grant already consumed by action action-1',
    });
    expect(await adapter.consumeActionAuthorization(consumeRequest({ attemptId: 'att-2' }))).toEqual({
      outcome: 'refused',
      reason: 'grant-attempt-mismatch',
    });
    expect(await adapter.consumeActionAuthorization(consumeRequest({ expectedHeadSha: OTHER_SHA }))).toEqual({
      outcome: 'refused',
      reason: 'grant-head-mismatch',
    });
    expect(grants.get('grant-1')).toBe(stored);
    expect(await adapter.resolveActionAuthorization(resolveRequest())).toEqual({
      outcome: 'blocked',
      reason: 'no-matching-grant',
    });
  });

  it('accepts slash-keyed action and grant ids such as pr-feedback keys', async () => {
    const grants: Grants = new Map([['grant/one', grantEntry()]]);
    const adapter = new ActionAuthorizationAdapter({ grants });
    const actionId = `pr-feedback/42@${'a'.repeat(12)}`;

    const result = await adapter.consumeActionAuthorization(
      consumeRequest({ authorizationGrantId: 'grant/one', actionId }),
    );
    const retry = await adapter.consumeActionAuthorization(
      consumeRequest({ authorizationGrantId: 'grant/one', actionId }),
    );

    expect(result).toEqual({ outcome: 'consumed', actionId });
    expect(retry).toEqual({ outcome: 'consumed', actionId });
    expect(grants.get('grant/one')?.consumedByActionId).toBe(actionId);
  });

  it('fails closed when a delegate throws or grants contains an unreadable or unknown-version record', async () => {
    const throwing = new ActionAuthorizationAdapter({
      resolveGrant: async () => {
        throw new Error('down');
      },
      consumeGrant: async () => {
        throw new Error('down');
      },
    });
    expect((await throwing.resolveActionAuthorization(resolveRequest())).outcome).toBe('blocked');
    expect((await throwing.consumeActionAuthorization(consumeRequest())).outcome).toBe('refused');

    for (const answer of [null, 'granted', {}, { outcome: 'granted' }, { outcome: 'maybe' }, { outcome: 'blocked' }]) {
      const adapter = new ActionAuthorizationAdapter({
        resolveGrant: async () => answer as unknown as ResolveActionAuthorizationResult,
        consumeGrant: async () => answer as unknown as ConsumeActionAuthorizationResult,
      });
      expect(await adapter.resolveActionAuthorization(resolveRequest())).toEqual({
        outcome: 'blocked',
        reason: 'authorization-unavailable',
      });
      expect(await adapter.consumeActionAuthorization(consumeRequest())).toEqual({
        outcome: 'refused',
        reason: 'authorization-unavailable',
      });
    }

    const echoedElsewhere = new ActionAuthorizationAdapter({
      consumeGrant: async () => ({ outcome: 'consumed', actionId: 'action-other' }),
    });
    expect(await echoedElsewhere.consumeActionAuthorization(consumeRequest())).toEqual({
      outcome: 'refused',
      reason: 'authorization-unavailable',
    });

    // A readable matching grant never rescues an unreadable one that comes after it.
    const grants: Grants = new Map([
      ['grant-1', grantEntry({ schemaVersion: 2 })],
      ['grant-2', grantEntry({ schemaVersion: 9 })],
    ]);
    const adapter = new ActionAuthorizationAdapter({ grants });
    expect(await adapter.resolveActionAuthorization(resolveRequest())).toEqual({
      outcome: 'blocked',
      reason: 'unknown-grant-schema-version',
    });
    grants.set('grant-2', 'not a record' as unknown as ActionAuthorizationGrantEntry);
    expect(await adapter.resolveActionAuthorization(resolveRequest())).toEqual({
      outcome: 'blocked',
      reason: 'invalid-grant-record',
    });
    grants.delete('grant-2');
    grants.set(syntheticPath(), grantEntry());
    expect(await adapter.resolveActionAuthorization(resolveRequest())).toEqual({
      outcome: 'blocked',
      reason: 'invalid-grant-record',
    });
    grants.delete(syntheticPath());
    expect(await adapter.resolveActionAuthorization(resolveRequest())).toEqual({
      outcome: 'granted',
      authorizationGrantId: 'grant-1',
    });
  });

  it('refuses a slash-bearing id that embeds an absolute path instead of echoing it', async () => {
    const embedded = ['grant-', 'var', 'tmp', 'private'].join('/');
    const actionEmbedded = ['act-', 'etc', 'passwd'].join('/');
    const adapter = new ActionAuthorizationAdapter({ grants: grantsOf() });

    for (const result of [
      await adapter.consumeActionAuthorization(consumeRequest({ authorizationGrantId: embedded })),
      await adapter.consumeActionAuthorization(consumeRequest({ actionId: actionEmbedded })),
      await adapter.resolveActionAuthorization(resolveRequest({ actionId: actionEmbedded })),
    ]) {
      expect(result).toMatchObject({ reason: 'invalid-request' });
      expectNoDisallowedText(result);
      expect(JSON.stringify(result)).not.toContain('private');
      expect(JSON.stringify(result)).not.toContain('passwd');
    }

    const poisoned = new ActionAuthorizationAdapter({ grants: grantsOf(grantEntry({ consumedByActionId: actionEmbedded })) });
    const consumed = await poisoned.consumeActionAuthorization(consumeRequest());
    expect(consumed).toEqual({ outcome: 'refused', reason: 'invalid-grant-record' });

    // The production key form stays valid: one slash between alphanumerics.
    const keyed = await new ActionAuthorizationAdapter({ grants: grantsOf() }).consumeActionAuthorization(
      consumeRequest({ actionId: 'pr-feedback/42@0123456789ab' }),
    );
    expect(keyed).toEqual({ outcome: 'consumed', actionId: 'pr-feedback/42@0123456789ab' });
  });

  it('reads each stored grant field once, so a stateful proxy cannot present two different records', () => {
    const reads = new Map<string, number>();
    const target: Record<string, unknown> = {
      expectedHeadSha: HEAD_SHA,
      kind: 'push-to-pr',
      consumedByActionId: null,
    };
    const stateful = new Proxy(target, {
      getOwnPropertyDescriptor(inner, key) {
        const count = (reads.get(String(key)) ?? 0) + 1;
        reads.set(String(key), count);
        if (key === 'schemaVersion') {
          return { value: count === 1 ? 1 : 2, enumerable: true, configurable: true, writable: true };
        }
        return Reflect.getOwnPropertyDescriptor(inner, key);
      },
    });

    const parsed = parseActionAuthorizationGrantEntry(stateful);

    expect(reads.get('schemaVersion')).toBe(1);
    for (const count of reads.values()) {
      expect(count).toBeLessThanOrEqual(1);
    }
    // One snapshot, one answer: the first read (version 1, no attempt) is the whole record.
    expect(parsed).toMatchObject({ ok: true, schemaVersion: 1 });
    expect(parsed.ok && parsed.grant.attemptId).toBeFalsy();
  });

  it('never echoes secret-shaped text or filesystem paths from requests, stored grants, or delegates', async () => {
    const token = syntheticToken();
    const path = syntheticPath();
    const adapter = new ActionAuthorizationAdapter({ grants: grantsOf() });

    for (const poison of [token, path, `x ${path}`]) {
      const results = [
        await adapter.consumeActionAuthorization(consumeRequest({ actionId: poison })),
        await adapter.consumeActionAuthorization(consumeRequest({ authorizationGrantId: poison })),
        await adapter.consumeActionAuthorization(consumeRequest({ attemptId: poison })),
        await adapter.consumeActionAuthorization(consumeRequest({ expectedHeadSha: poison })),
        await adapter.resolveActionAuthorization(resolveRequest({ actionId: poison })),
        await adapter.resolveActionAuthorization(resolveRequest({ policyRevision: poison })),
        await adapter.resolveActionAuthorization(resolveRequest({ expectedHeadSha: poison })),
      ];
      for (const result of results) {
        expect(result).toMatchObject({ reason: 'invalid-request' });
        expectNoDisallowedText(result);
      }
    }
    expect(await adapter.consumeActionAuthorization(consumeRequest({ actionId: 'a\\b' }))).toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
    expect(await adapter.resolveActionAuthorization(resolveRequest({ workOrderId: 'wo/1' }))).toEqual({
      outcome: 'blocked',
      reason: 'invalid-request',
    });

    for (const overrides of [
      { expectedHeadSha: token },
      { attemptId: path },
      { consumedByActionId: token },
      { consumedByActionId: path },
    ]) {
      const grants = grantsOf(grantEntry(overrides));
      const poisoned = new ActionAuthorizationAdapter({ grants });
      const resolved = await poisoned.resolveActionAuthorization(resolveRequest());
      const consumed = await poisoned.consumeActionAuthorization(consumeRequest());

      expect(resolved).toEqual({ outcome: 'blocked', reason: 'invalid-grant-record' });
      expect(consumed).toEqual({ outcome: 'refused', reason: 'invalid-grant-record' });
      expectNoDisallowedText([resolved, consumed]);
    }

    for (const poison of [`failed with ${token}`, `see ${path}`]) {
      const delegate = new ActionAuthorizationAdapter({
        resolveGrant: async () => ({ outcome: 'blocked', reason: poison }),
        consumeGrant: async () => ({ outcome: 'refused', reason: poison }),
      });
      const blocked = await delegate.resolveActionAuthorization(resolveRequest());
      const refused = await delegate.consumeActionAuthorization(consumeRequest());

      expect(blocked).toEqual({ outcome: 'blocked', reason: 'delegate-blocked' });
      expect(refused).toEqual({ outcome: 'refused', reason: 'delegate-refused' });
      expectNoDisallowedText([blocked, refused]);
    }
    const unknown = new ActionAuthorizationAdapter({
      resolveGrant: async () => ({ outcome: 'unknown', reason: `see ${path}` }),
    });
    expect(await unknown.resolveActionAuthorization(resolveRequest())).toEqual({
      outcome: 'unknown',
      reason: 'delegate-blocked',
    });
    const clean = new ActionAuthorizationAdapter({
      resolveGrant: async () => ({ outcome: 'blocked', reason: 'Owner has not decided yet' }),
      consumeGrant: async () => ({ outcome: 'refused', reason: 'Grant already consumed by another action' }),
    });
    expect(await clean.resolveActionAuthorization(resolveRequest())).toEqual({
      outcome: 'blocked',
      reason: 'Owner has not decided yet',
    });
    expect(await clean.consumeActionAuthorization(consumeRequest())).toEqual({
      outcome: 'refused',
      reason: 'Grant already consumed by another action',
    });

    const echoed = new ActionAuthorizationAdapter({
      resolveGrant: async () => ({ outcome: 'granted', authorizationGrantId: token }),
      consumeGrant: async () => ({ outcome: 'consumed', actionId: path }),
    });
    const echoedResolve = await echoed.resolveActionAuthorization(resolveRequest());
    const echoedConsume = await echoed.consumeActionAuthorization(consumeRequest());
    expect(echoedResolve).toEqual({ outcome: 'blocked', reason: 'authorization-unavailable' });
    expect(echoedConsume).toEqual({ outcome: 'refused', reason: 'authorization-unavailable' });
    expectNoDisallowedText([echoedResolve, echoedConsume]);

    const missingGrants = await adapter.consumeActionAuthorization(consumeRequest({ authorizationGrantId: 'grant-9' }));
    expect(missingGrants).toEqual({ outcome: 'refused', reason: 'Authorization grant not found: grant-9' });
  });

  it('refuses oversized request fields, oversized grant maps, and oversized delegate outputs', async () => {
    const adapter = new ActionAuthorizationAdapter({ grants: grantsOf() });

    expect(await adapter.consumeActionAuthorization(consumeRequest({ actionId: 'a'.repeat(513) }))).toEqual({
      outcome: 'refused',
      reason: 'too-large',
    });
    expect(
      await adapter.consumeActionAuthorization(consumeRequest({ authorizationGrantId: 'g'.repeat(257) })),
    ).toEqual({ outcome: 'refused', reason: 'too-large' });
    expect(await adapter.consumeActionAuthorization(consumeRequest({ attemptId: 'a'.repeat(257) }))).toEqual({
      outcome: 'refused',
      reason: 'too-large',
    });
    expect(await adapter.consumeActionAuthorization(consumeRequest({ expectedHeadSha: 'a'.repeat(65) }))).toEqual({
      outcome: 'refused',
      reason: 'too-large',
    });
    expect(await adapter.resolveActionAuthorization(resolveRequest({ actionId: 'a'.repeat(513) }))).toEqual({
      outcome: 'blocked',
      reason: 'too-large',
    });
    expect(await adapter.resolveActionAuthorization(resolveRequest({ policyRevision: 'p'.repeat(257) }))).toEqual({
      outcome: 'blocked',
      reason: 'too-large',
    });
    expect(await adapter.resolveActionAuthorization(resolveRequest({ expectedHeadSha: 'a'.repeat(65) }))).toEqual({
      outcome: 'blocked',
      reason: 'too-large',
    });

    const big: Grants = new Map();
    for (let index = 0; index <= MAX_ACTION_AUTHORIZATION_GRANTS; index += 1) {
      big.set(`grant-${index}`, grantEntry({ consumedByActionId: `action-${index}` }));
    }
    const bounded = new ActionAuthorizationAdapter({ grants: big });
    expect(await bounded.resolveActionAuthorization(resolveRequest())).toEqual({
      outcome: 'blocked',
      reason: 'too-large',
    });
    expect(await bounded.consumeActionAuthorization(consumeRequest({ authorizationGrantId: 'grant-0' }))).toEqual({
      outcome: 'refused',
      reason: 'too-large',
    });
    big.delete(`grant-${MAX_ACTION_AUTHORIZATION_GRANTS}`);
    expect(await bounded.resolveActionAuthorization(resolveRequest())).toEqual({
      outcome: 'blocked',
      reason: 'no-matching-grant',
    });

    const oversizedGrant = grantsOf(grantEntry({ attemptId: 'a'.repeat(257) }));
    expect(
      await new ActionAuthorizationAdapter({ grants: oversizedGrant }).resolveActionAuthorization(resolveRequest()),
    ).toEqual({ outcome: 'blocked', reason: 'invalid-grant-record' });

    const oversizedDelegate = new ActionAuthorizationAdapter({
      resolveGrant: async () => ({ outcome: 'blocked', reason: 'r'.repeat(301) }),
      consumeGrant: async () => ({ outcome: 'refused', reason: 'r'.repeat(301) }),
    });
    expect(await oversizedDelegate.resolveActionAuthorization(resolveRequest())).toEqual({
      outcome: 'blocked',
      reason: 'authorization-unavailable',
    });
    expect(await oversizedDelegate.consumeActionAuthorization(consumeRequest())).toEqual({
      outcome: 'refused',
      reason: 'authorization-unavailable',
    });
    const oversizedIds = new ActionAuthorizationAdapter({
      resolveGrant: async () => ({ outcome: 'granted', authorizationGrantId: 'g'.repeat(257) }),
      consumeGrant: async () => ({ outcome: 'consumed', actionId: 'a'.repeat(513) }),
    });
    expect(await oversizedIds.resolveActionAuthorization(resolveRequest())).toEqual({
      outcome: 'blocked',
      reason: 'authorization-unavailable',
    });
    expect(await oversizedIds.consumeActionAuthorization(consumeRequest({ actionId: 'a'.repeat(512) }))).toEqual({
      outcome: 'refused',
      reason: 'authorization-unavailable',
    });
  });

  it('delegates to configured supplier functions with the validated request fields', async () => {
    const consumeRequests: ConsumeActionAuthorizationRequest[] = [];
    const adapter = new ActionAuthorizationAdapter({
      resolveGrant: async () => ({ outcome: 'granted', authorizationGrantId: 'grant-2' }),
      consumeGrant: async (request) => {
        consumeRequests.push(request);
        return { outcome: 'consumed', actionId: request.actionId };
      },
    });
    const request = consumeRequest({ authorizationGrantId: 'grant-2', actionId: 'action-9' });

    expect(await adapter.resolveActionAuthorization(resolveRequest())).toEqual({
      outcome: 'granted',
      authorizationGrantId: 'grant-2',
    });
    expect(await adapter.consumeActionAuthorization(request)).toEqual({ outcome: 'consumed', actionId: 'action-9' });
    expect(consumeRequests).toEqual([request]);
  });
});

describe('ActionAuthorizationAdapter through the authorised forge path', () => {
  const FIXED_HEAD = 'c'.repeat(40);

  function collectedAttempt(id: string, headCommit: string): AttemptRecord {
    return {
      id,
      ownerDecisionReferences: [],
      workOrderId: 'wo-1',
      kind: 'initial',
      fixNumber: 0,
      priorAttemptId: null,
      worktreePath: '/tmp/opencode/lanes/co24b',
      baseCommit: OTHER_SHA,
      state: 'collected',
      outcome: 'done',
      briefDigest: 'digest-1',
      briefPackagePath: null,
      sessionId: null,
      completionReceipt: null,
      artifacts: {
        headCommit,
        commitsSinceBase: [headCommit],
        collectedArtifactPaths: [],
        notes: 'present',
      },
      createdAtIso: NOW,
      updatedAtIso: NOW,
    } as AttemptRecord;
  }

  function approvedWorkOrder(): WorkOrderRecord {
    return {
      id: 'wo-1',
      projectId: 'project-1',
      taskId: 'task-1',
      laneId: 'lane-co24b',
      repository: 'github.com/fleet/v2',
      baseCommit: OTHER_SHA,
      ownedPaths: ['packages/work-execution/src'],
      policyRevision: 'policy-7',
      prerequisiteWorkOrderIds: [],
      state: 'approved',
      revision: 1,
      createdAtIso: NOW,
      updatedAtIso: NOW,
    } as WorkOrderRecord;
  }

  class RecordingForge implements ForgeActionPort {
    boundRepository(): { owner: string; repo: string } | undefined {
      return { owner: 'org', repo: 'repo' };
    }
    readonly requests: ForgeActionRequest[] = [];
    async performForgeAction(request: ForgeActionRequest) {
      this.requests.push(request);
      return { outcome: 'executed' as const, pullRequestNumber: 42, headSha: request.expectedHeadSha };
    }
    isConfigured(): boolean {
      return true;
    }
  }

  async function wire(attempts: readonly AttemptRecord[], grants: Grants) {
    const attemptRepo = new AttemptRepositoryAdapter();
    for (const attempt of attempts) {
      await attemptRepo.saveAttempt(attempt);
    }
    const workOrderRepo = new WorkOrderRepositoryAdapter();
    await workOrderRepo.saveWorkOrder(approvedWorkOrder());
    const journal = new ExecutionJournalAdapter();
    const forgePort = new RecordingForge();
    const execute = new ExecuteAuthorizedForgeActionUseCase({
      attemptRepo,
      workOrderRepo,
      journal,
      authorizationPort: new ActionAuthorizationAdapter({ grants }),
      forgePort,
      attemptOwnerDecisionPort: {
        async readAttemptOwnerDecisionReferences() {
          return { outcome: 'recorded', ownerDecisionReferences: [] };
        },
      },
      now: () => NOW,
    });
    return { execute, journal, forgePort };
  }

  it('refuses ExecuteAuthorizedForgeActionPort on attempt mismatch with real ActionAuthorizationAdapter and executes for the matching attempt', async () => {
    const grants = grantsOf();
    const { execute, journal, forgePort } = await wire(
      [collectedAttempt('att-1', HEAD_SHA), collectedAttempt('att-2', HEAD_SHA)],
      grants,
    );
    const port: ExecuteAuthorizedForgeActionPort = execute;
    const request = (attemptId: string): ExecuteAuthorizedForgeActionRequest => ({
      actionId: `forge-${attemptId}`,
      attemptId,
      workOrderId: 'wo-1',
      kind: 'push-to-pr',
      expectedHeadSha: HEAD_SHA,
      authorizationGrantId: 'grant-1',
      branchName: 'fleet/lane-co24b',
    });

    const mismatched = await port.executeAuthorizedForgeAction(request('att-2'));

    expect(mismatched).toEqual({ outcome: 'refused', reason: 'grant-attempt-mismatch' });
    expect((await journal.listJournalEntriesForAttempt('att-2')).map((entry) => entry.status)).toEqual(['refused']);
    expect(forgePort.requests).toHaveLength(0);
    expect(grants.get('grant-1')?.consumedByActionId).toBeNull();

    const matching = await port.executeAuthorizedForgeAction(request('att-1'));

    expect(matching).toEqual({ outcome: 'executed', pullRequestNumber: 42, headSha: HEAD_SHA });
    expect(forgePort.requests).toHaveLength(1);
    expect(grants.get('grant-1')?.consumedByActionId).toBe('forge-att-1');
  });

  it('maps real ActionAuthorizationAdapter attempt mismatch to grant-refused in PreparePullRequestFeedbackFixUseCase', async () => {
    const roundHead = 'a'.repeat(40);
    const fixAttemptId = `pr-feedback-42-${roundHead.slice(0, 12)}`;
    const key = `pr-feedback/42@${roundHead.slice(0, 12)}`;
    const repository = { owner: 'fleet', repo: 'v2' };
    const finding: PullRequestFinding = {
      threadId: 'PRRT_one',
      path: 'src/widget.ts',
      line: 12,
      authorKind: 'user',
      state: 'unresolved',
      text: 'Please handle the empty list here.',
    };
    const findings: PullRequestFindingsReadPort = {
      async readPullRequestFindings(request: PullRequestFindingsRequest): Promise<PullRequestFindingsResult> {
        return request.expectedHeadSha === roundHead
          ? {
              outcome: 'available',
              headSha: roundHead,
              headRefName: 'fleet/lane-co24b',
              headRepository: repository,
              findings: [finding],
            }
          : { outcome: 'unavailable', code: 'head-moved' };
      },
      isConfigured: () => true,
    };
    const pushRequest = {
      repository,
      pullRequestNumber: 42,
      branchName: 'fleet/lane-co24b',
      expectedHeadSha: roundHead,
      fixedHeadSha: FIXED_HEAD,
      workOrderId: 'wo-1',
      attemptId: fixAttemptId,
      grantId: 'grant-1',
    };

    const mismatchGrants = grantsOf(grantEntry({ attemptId: 'att-other', expectedHeadSha: FIXED_HEAD }));
    const mismatched = await wire([collectedAttempt(fixAttemptId, FIXED_HEAD)], mismatchGrants);
    const mismatchUseCase = new PreparePullRequestFeedbackFixUseCase({
      findings,
      prepareFixAttempt: {
        async prepareFixAttempt() {
          throw new Error('not used');
        },
      },
      executeForgeAction: mismatched.execute,
      repository,
      mintNonce: () => 'a'.repeat(32),
    });

    const refused = await mismatchUseCase.pushPullRequestFeedbackFix(pushRequest);

    expect(refused).toEqual({ outcome: 'refused', key, headSha: FIXED_HEAD, code: 'grant-refused' });
    expect(mismatched.forgePort.requests).toHaveLength(0);
    expect(mismatchGrants.get('grant-1')?.consumedByActionId).toBeNull();

    const matchGrants = grantsOf(grantEntry({ attemptId: fixAttemptId, expectedHeadSha: FIXED_HEAD }));
    const matched = await wire([collectedAttempt(fixAttemptId, FIXED_HEAD)], matchGrants);
    const matchUseCase = new PreparePullRequestFeedbackFixUseCase({
      findings,
      prepareFixAttempt: {
        async prepareFixAttempt() {
          throw new Error('not used');
        },
      },
      executeForgeAction: matched.execute,
      repository,
      mintNonce: () => 'a'.repeat(32),
    });

    const pushed = await matchUseCase.pushPullRequestFeedbackFix(pushRequest);

    expect(pushed).toEqual({ outcome: 'pushed', key, headSha: FIXED_HEAD });
    expect(matched.forgePort.requests).toHaveLength(1);
    expect(matchGrants.get('grant-1')?.consumedByActionId).toBe(key);
  });
});

describe('ActionAuthorizationAdapter control and bidi characters (CO24d)', () => {
  const BAD = [
    ['a C0 control', 'att\u0001-1'],
    ['a newline', 'att\n1'],
    ['DEL', 'att\u007f1'],
    ['a C1 control', 'att\u00851'],
    ['a bidi override', 'att\u202E1'],
    ['a bidi isolate', 'att\u20661'],
    ['a left-to-right mark', 'att‎1'],
    ['an Arabic letter mark (U+061C)', 'att\u061c1'],
    ['a line separator (U+2028)', 'att\u20281'],
    ['a paragraph separator (U+2029)', 'att\u20291'],
    ['a byte order mark (U+FEFF)', 'att\ufeff1'],
  ] as const;

  it.each(BAD)('refuses an attempt id (isSafeId) with %s', async (_label, attemptId) => {
    const adapter = new ActionAuthorizationAdapter({ grants: grantsOf() });
    const result = await adapter.resolveActionAuthorization(resolveRequest({ attemptId }));
    expect(result.outcome).toBe('blocked');
  });

  it.each(BAD)('refuses a grant id (isSafeId, slash allowed) with %s', async (_label, grantId) => {
    const adapter = new ActionAuthorizationAdapter({ grants: grantsOf() });
    const result = await adapter.consumeActionAuthorization(consumeRequest({ authorizationGrantId: grantId }));
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
  });

  it.each(BAD)('refuses policy revision text (isCleanText) with %s', async (_label, policyRevision) => {
    const adapter = new ActionAuthorizationAdapter({ grants: grantsOf() });
    const result = await adapter.resolveActionAuthorization(resolveRequest({ policyRevision }));
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
  });

  it('still accepts a plain key-shaped action id', async () => {
    const adapter = new ActionAuthorizationAdapter({ grants: grantsOf() });
    const result = await adapter.consumeActionAuthorization(
      consumeRequest({ actionId: 'pr-feedback/42@abcdef123456' }),
    );
    expect(result.outcome).toBe('consumed');
  });
});
