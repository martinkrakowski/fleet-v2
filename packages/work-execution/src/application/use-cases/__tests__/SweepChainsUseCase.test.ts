// SweepChainsUseCase tests (lane CO11): only a landed chain record's own
// `chain/<name>` branch is swept, dry-run is the default, apply runs only on
// the exact `mode: 'apply'`, every record and member is validated before the
// first delete, and a repeat after a partial sweep completes as
// `already-absent`. A hostile member refuses the whole sweep and deletes
// nothing; no rejected value is echoed.

import { describe, expect, it } from 'vitest';

import { SweepChainsUseCase, isDeletableSweepBranch } from '../SweepChainsUseCase.use-case.js';
import type {
  SweepChainsCommand,
  SweepChainsPort,
} from '../../ports/in/SweepChainsPort.in-port.js';
import type { MergeForgeActionPort, MergeForgeActionRequest, MergeForgeActionResult } from '../../ports/out/MergeForgeActionPort.out-port.js';
import type { ChainListCommand, ChainListResult } from '../../ports/out/ChainRepositoryPort.out-port.js';

const NOW = '2026-11-11T12:00:00.000Z';
const DEADLINE = '2026-11-11T13:00:00.000Z';

class FakeChains {
  result: unknown = { status: 'ok', records: [] };
  throwOnCall = false;
  listed: ChainListCommand[] = [];

  async listChains(command: ChainListCommand): Promise<ChainListResult> {
    this.listed.push(command);
    if (this.throwOnCall) {
      throw new Error('chain store exploded');
    }
    return this.result as ChainListResult;
  }
}

class FakeForge implements Pick<MergeForgeActionPort, 'performMergeForgeAction' | 'isConfigured'> {
  configured = true;
  throwOnCall = false;
  results: MergeForgeActionResult[] = [];
  requests: MergeForgeActionRequest[] = [];

  isConfigured(): boolean {
    return this.configured;
  }

  async performMergeForgeAction(request: MergeForgeActionRequest): Promise<MergeForgeActionResult> {
    this.requests.push(request);
    if (this.throwOnCall) {
      throw new Error('forge exploded');
    }
    const next = this.results.shift();
    if (next === undefined) {
      throw new Error('no scripted forge result');
    }
    return next;
  }
}

function record(chainName: string, state: string, links: readonly string[] = [`chain/${chainName}`]): Record<string, unknown> {
  return {
    chainName,
    branchName: `chain/${chainName}`,
    revision: 1,
    state,
    linkBranches: [...links],
  };
}

function command(overrides: Partial<SweepChainsCommand> = {}): SweepChainsCommand {
  return {
    repository: { owner: 'acme', repo: 'widgets' },
    projectId: 'fleet-v2',
    nowIso: NOW,
    deadlineIso: DEADLINE,
    ...overrides,
  };
}

interface Harness {
  readonly useCase: SweepChainsPort;
  readonly chains: FakeChains;
  readonly forge: FakeForge;
}

function harness(overrides: { now?: () => string } = {}): Harness {
  const chains = new FakeChains();
  const forge = new FakeForge();
  const useCase = new SweepChainsUseCase({
    chains: chains as never,
    forge: forge as unknown as MergeForgeActionPort,
    now: overrides.now ?? (() => NOW),
  });
  return { useCase, chains, forge };
}

function landedFoo(): unknown[] {
  return [record('foo', 'landed')];
}

describe('SweepChainsUseCase', () => {
  it('dry-run is the default and reports would-delete for chain/foo without calling the forge', async () => {
    const { useCase, chains, forge } = harness();
    chains.result = { status: 'ok', records: landedFoo() };
    const result = await useCase.runSweepChains(command({ mode: 'dry-run' }));
    expect(result.outcome).toBe('dry-run');
    expect(result.reasonCode).toBeNull();
    expect(result.branches).toHaveLength(1);
    expect(result.branches[0]).toMatchObject({
      chainName: 'foo',
      role: 'chain',
      actionId: 'chain-sweep/foo@r1/chain',
      branchName: 'chain/foo',
      outcome: 'would-delete',
      reasonCode: null,
    });
    expect(forge.requests).toHaveLength(0);
  });

  it('apply deletes exactly chain/foo once', async () => {
    const { useCase, chains, forge } = harness();
    chains.result = { status: 'ok', records: landedFoo() };
    forge.results = [{ outcome: 'executed', headSha: 'a'.repeat(40) }];
    const result = await useCase.runSweepChains(command({ mode: 'apply' }));
    expect(result.outcome).toBe('completed');
    expect(result.reasonCode).toBeNull();
    expect(forge.requests).toHaveLength(1);
    expect(forge.requests[0]).toMatchObject({
      kind: 'delete-branch',
      actionId: 'chain-sweep/foo@r1/chain',
      repository: { owner: 'acme', repo: 'widgets' },
      branchName: 'chain/foo',
      deadlineIso: DEADLINE,
    });
    expect(result.branches[0]!.outcome).toBe('deleted');
  });

  it('apply refuses main and deletes nothing', async () => {
    const { useCase, chains, forge } = harness();
    chains.result = {
      status: 'ok',
      records: [{ chainName: 'foo', branchName: 'main', revision: 1, state: 'landed', linkBranches: [] }],
    };
    const result = await useCase.runSweepChains(command({ mode: 'apply' }));
    expect(result.outcome).toBe('refused');
    expect(result.reasonCode).toBe('branch-pattern-refused');
    expect(result.branchClass).toBe('main');
    expect(result.memberRole).toBe('chain');
    expect(result.memberIndex).toBeNull();
    expect(forge.requests).toHaveLength(0);
  });

  it('isDeletableSweepBranch accepts only this chain branch', () => {
    expect(isDeletableSweepBranch('foo', 'chain/foo')).toBe(true);
    expect(isDeletableSweepBranch('release', 'chain/release')).toBe(true);
    expect(isDeletableSweepBranch('main', 'chain/main')).toBe(true);
    expect(isDeletableSweepBranch('foo', 'main')).toBe(false);
    expect(isDeletableSweepBranch('foo', 'chain/other')).toBe(false);
    expect(isDeletableSweepBranch('foo', 'foo')).toBe(false);
    expect(isDeletableSweepBranch('foo', 'release/1')).toBe(false);
    expect(isDeletableSweepBranch('release', 'release')).toBe(false);
  });

  it('a started chain is not deleted', async () => {
    const { useCase, chains, forge } = harness();
    chains.result = { status: 'ok', records: [record('foo', 'started')] };
    const result = await useCase.runSweepChains(command({ mode: 'apply' }));
    expect(result.outcome).toBe('completed');
    expect(result.reasonCode).toBe('nothing-to-sweep');
    expect(result.branches).toHaveLength(0);
    expect(forge.requests).toHaveLength(0);
  });

  it('apply deletes the landed chain and not the started neighbour', async () => {
    const { useCase, chains, forge } = harness();
    chains.result = { status: 'ok', records: [record('foo', 'landed'), record('bar', 'started')] };
    forge.results = [{ outcome: 'executed', headSha: 'a'.repeat(40) }];
    const result = await useCase.runSweepChains(command({ mode: 'apply' }));
    expect(result.outcome).toBe('completed');
    expect(forge.requests).toHaveLength(1);
    expect(forge.requests[0]).toMatchObject({ branchName: 'chain/foo' });
    expect(result.branches.map((branch: { chainName: string }) => branch.chainName)).toEqual(['foo']);
  });

  it('an unreadable second record deletes nothing', async () => {
    const { useCase, chains, forge } = harness();
    chains.result = { status: 'ok', records: [record('foo', 'landed'), null] };
    const result = await useCase.runSweepChains(command({ mode: 'apply' }));
    expect(result.outcome).toBe('refused');
    expect(result.reasonCode).toBe('record-malformed');
    expect(forge.requests).toHaveLength(0);
  });

  it('a landed record with no linkBranches refuses and deletes nothing', async () => {
    const { useCase, chains, forge } = harness();
    chains.result = {
      status: 'ok',
      records: [{ chainName: 'foo', branchName: 'chain/foo', revision: 1, state: 'landed' }],
    };
    const result = await useCase.runSweepChains(command({ mode: 'apply' }));
    expect(result.outcome).toBe('refused');
    expect(result.reasonCode).toBe('membership-unreadable');
    expect(forge.requests).toHaveLength(0);
  });

  it('an explicit empty linkBranches deletes only the chain branch', async () => {
    const { useCase, chains, forge } = harness();
    chains.result = { status: 'ok', records: [record('foo', 'landed', [])] };
    forge.results = [{ outcome: 'executed', headSha: 'a'.repeat(40) }];
    const result = await useCase.runSweepChains(command({ mode: 'apply' }));
    expect(result.outcome).toBe('completed');
    expect(forge.requests).toHaveLength(1);
    expect(forge.requests[0]).toMatchObject({ branchName: 'chain/foo' });
  });

  it('duplicate chain/foo links delete once', async () => {
    const { useCase, chains, forge } = harness();
    chains.result = { status: 'ok', records: [record('foo', 'landed', ['chain/foo', 'chain/foo', 'chain/foo'])] };
    forge.results = [{ outcome: 'executed', headSha: 'a'.repeat(40) }];
    const result = await useCase.runSweepChains(command({ mode: 'apply' }));
    expect(result.outcome).toBe('completed');
    expect(forge.requests).toHaveLength(1);
  });

  it('a link named chain/other refuses the whole sweep', async () => {
    const { useCase, chains, forge } = harness();
    chains.result = { status: 'ok', records: [record('foo', 'landed', ['chain/other'])] };
    const result = await useCase.runSweepChains(command({ mode: 'apply' }));
    expect(result.outcome).toBe('refused');
    expect(result.reasonCode).toBe('branch-pattern-refused');
    expect(result.branchClass).toBe('other-chain');
    expect(result.chainName).toBe('foo');
    expect(result.memberRole).toBe('link');
    expect(result.memberIndex).toBe(0);
    expect(forge.requests).toHaveLength(0);
  });

  it('a started record whose branch is main refuses the sweep and deletes nothing', async () => {
    const { useCase, chains, forge } = harness();
    chains.result = {
      status: 'ok',
      records: [{ chainName: 'foo', branchName: 'main', revision: 1, state: 'started', linkBranches: [] }],
    };
    const result = await useCase.runSweepChains(command({ mode: 'apply' }));
    expect(result.outcome).toBe('refused');
    expect(result.reasonCode).toBe('branch-pattern-refused');
    expect(result.branchClass).toBe('main');
    expect(result.memberRole).toBe('chain');
    expect(result.memberIndex).toBeNull();
    expect(forge.requests).toHaveLength(0);
  });

  it('a second apply after branch-gone completes as already-absent', async () => {
    const { useCase, chains, forge } = harness();
    chains.result = { status: 'ok', records: landedFoo() };
    forge.results = [{ outcome: 'branch-gone' }];
    const result = await useCase.runSweepChains(command({ mode: 'apply' }));
    expect(result.outcome).toBe('completed');
    expect(result.branches[0]!.outcome).toBe('already-absent');
    expect(forge.requests).toHaveLength(1);
  });

  it('an ambiguous delete is not completed', async () => {
    const { useCase, chains, forge } = harness();
    chains.result = { status: 'ok', records: landedFoo() };
    forge.results = [{ outcome: 'ambiguous', reason: 'no gh subprocess is configured' }];
    const result = await useCase.runSweepChains(command({ mode: 'apply' }));
    expect(result.outcome).toBe('incomplete');
    expect(result.reasonCode).toBe('delete-ambiguous');
    expect(forge.requests).toHaveLength(1);
  });

  it('a past deadline deletes nothing', async () => {
    const { useCase, chains, forge } = harness();
    chains.result = { status: 'ok', records: landedFoo() };
    const result = await useCase.runSweepChains(command({ mode: 'apply', deadlineIso: '2026-11-11T11:00:00.000Z' }));
    expect(result.outcome).toBe('budget-exhausted');
    expect(result.reasonCode).toBeNull();
    expect(forge.requests).toHaveLength(0);
  });

  it('null command is refused', async () => {
    const { useCase, forge } = harness();
    const refused = await useCase.runSweepChains(null);
    expect(refused.outcome).toBe('refused');
    expect(refused.reasonCode).toBe('invalid-request');
    expect(refused.branches).toEqual([]);
    expect(forge.requests).toHaveLength(0);
    const badRepository = await useCase.runSweepChains(command({ repository: { owner: '', repo: 'widgets' } }));
    expect(badRepository).toMatchObject({ outcome: 'refused', reasonCode: 'invalid-repository' });
    const badProject = await useCase.runSweepChains(command({ projectId: '' }));
    expect(badProject).toMatchObject({ outcome: 'refused', reasonCode: 'invalid-project-id' });
    const badNow = await useCase.runSweepChains(command({ nowIso: 'not-a-time' }));
    expect(badNow).toMatchObject({ outcome: 'refused', reasonCode: 'invalid-now' });
    const badDeadline = await useCase.runSweepChains(command({ deadlineIso: 'not-a-time' }));
    expect(badDeadline).toMatchObject({ outcome: 'refused', reasonCode: 'invalid-deadline' });
  });

  it('undefined command is refused', async () => {
    const { useCase, forge } = harness();
    const result = await useCase.runSweepChains(undefined);
    expect(result.outcome).toBe('refused');
    expect(result.reasonCode).toBe('invalid-request');
    expect(forge.requests).toHaveLength(0);
  });

  it('null records are refused and delete nothing', async () => {
    const { useCase, chains, forge } = harness();
    chains.result = { status: 'ok', records: null as never };
    const result = await useCase.runSweepChains(command({ mode: 'apply' }));
    expect(result.outcome).toBe('refused');
    expect(result.reasonCode).toBe('chains-malformed');
    expect(forge.requests).toHaveLength(0);
  });

  it('a non-iterable records value is refused and deletes nothing', async () => {
    const { useCase, chains, forge } = harness();
    chains.result = { status: 'ok', records: 'chain/foo' as never };
    const result = await useCase.runSweepChains(command({ mode: 'apply' }));
    expect(result.outcome).toBe('refused');
    expect(result.reasonCode).toBe('chains-malformed');
    expect(forge.requests).toHaveLength(0);
  });

  it('a hole in linkBranches refuses the sweep and deletes nothing', async () => {
    const { useCase, chains, forge } = harness();
    const links: unknown[] = ['chain/foo'];
    links[2] = 'chain/foo';
    chains.result = { status: 'ok', records: [{ ...record('foo', 'landed', []), linkBranches: links }] };
    const result = await useCase.runSweepChains(command({ mode: 'apply' }));
    expect(result.outcome).toBe('refused');
    expect(result.reasonCode).toBe('record-malformed');
    expect(forge.requests).toHaveLength(0);
  });

  it('a numeric state refuses the sweep and deletes nothing', async () => {
    const { useCase, chains, forge } = harness();
    chains.result = {
      status: 'ok',
      records: [{ chainName: 'foo', branchName: 'chain/foo', revision: 1, state: 1, linkBranches: [] }],
    };
    const result = await useCase.runSweepChains(command({ mode: 'apply' }));
    expect(result.outcome).toBe('refused');
    expect(result.reasonCode).toBe('record-malformed');
    expect(forge.requests).toHaveLength(0);
  });

  it('a throwing getter on a chain record refuses the sweep and deletes nothing', async () => {
    const { useCase, chains, forge } = harness();
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'chainName', {
      get() {
        throw new Error('exploded');
      },
      enumerable: true,
    });
    chains.result = { status: 'ok', records: [hostile] };
    const result = await useCase.runSweepChains(command({ mode: 'apply' }));
    expect(result.outcome).toBe('refused');
    expect(result.reasonCode).toBe('record-malformed');
    expect(forge.requests).toHaveLength(0);
  });

  it('a Proxy that throws on read refuses the sweep and deletes nothing', async () => {
    const { useCase, chains, forge } = harness();
    const hostile = new Proxy(
      { chainName: 'foo', branchName: 'chain/foo', revision: 1, state: 'landed', linkBranches: ['chain/foo'] },
      {
        getOwnPropertyDescriptor() {
          throw new Error('proxy exploded');
        },
      },
    );
    chains.result = { status: 'ok', records: [hostile] };
    const result = await useCase.runSweepChains(command({ mode: 'apply' }));
    expect(result.outcome).toBe('refused');
    expect(result.reasonCode).toBe('record-malformed');
    expect(forge.requests).toHaveLength(0);
  });

  it('an array-like records object is refused and deletes nothing', async () => {
    const { useCase, chains, forge } = harness();
    const arrayLike = { length: 1, 0: record('foo', 'landed') };
    chains.result = { status: 'ok', records: arrayLike as never };
    const result = await useCase.runSweepChains(command({ mode: 'apply' }));
    expect(result.outcome).toBe('refused');
    expect(result.reasonCode).toBe('chains-malformed');
    expect(forge.requests).toHaveLength(0);
  });

  it('a linkBranches length above 32 refuses the sweep and deletes nothing', async () => {
    const { useCase, chains, forge } = harness();
    const links: string[] = [];
    for (let index = 0; index < 33; index += 1) {
      links.push('chain/foo');
    }
    chains.result = { status: 'ok', records: [{ ...record('foo', 'landed', []), linkBranches: links }] };
    const result = await useCase.runSweepChains(command({ mode: 'apply' }));
    expect(result.outcome).toBe('refused');
    expect(result.reasonCode).toBe('too-many-members');
    expect(forge.requests).toHaveLength(0);
  });

  it('a prototype-inherited landed state deletes nothing', async () => {
    const { useCase, chains, forge } = harness();
    const inherited = Object.create({ state: 'landed' }) as Record<string, unknown>;
    inherited.chainName = 'foo';
    inherited.branchName = 'chain/foo';
    inherited.revision = 1;
    inherited.linkBranches = ['chain/foo'];
    chains.result = { status: 'ok', records: [inherited] };
    const result = await useCase.runSweepChains(command({ mode: 'apply' }));
    expect(result.outcome).toBe('refused');
    expect(result.reasonCode).toBe('record-malformed');
    expect(forge.requests).toHaveLength(0);
  });

  it('a secret-shaped link refuses the sweep and the result does not contain the secret', async () => {
    const { useCase, chains, forge } = harness();
    const secret = 'ghp_' + 'a'.repeat(36);
    chains.result = { status: 'ok', records: [record('foo', 'landed', [secret])] };
    const result = await useCase.runSweepChains(command({ mode: 'apply' }));
    expect(result.outcome).toBe('refused');
    expect(result.reasonCode).toBe('branch-pattern-refused');
    expect(result.branchClass).toBe('secret-shaped');
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(forge.requests).toHaveLength(0);
  });

  it('an unreadable chain list refuses and deletes nothing', async () => {
    const { useCase, chains, forge } = harness();
    chains.result = { status: 'unreadable', reason: 'chain store unreadable' };
    const result = await useCase.runSweepChains(command({ mode: 'apply' }));
    expect(result.outcome).toBe('refused');
    expect(result.reasonCode).toBe('chains-unreadable');
    expect(result.branches).toEqual([]);
    expect(forge.requests).toHaveLength(0);
  });

  it('apply refuses when the forge is not configured', async () => {
    const { useCase, chains, forge } = harness();
    forge.configured = false;
    chains.result = { status: 'ok', records: landedFoo() };
    const result = await useCase.runSweepChains(command({ mode: 'apply' }));
    expect(result.outcome).toBe('refused');
    expect(result.reasonCode).toBe('forge-not-configured');
    expect(forge.requests).toHaveLength(0);
  });
});
