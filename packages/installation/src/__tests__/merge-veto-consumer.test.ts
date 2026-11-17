import { describe, expect, it } from 'vitest';

import { autoMergeRevision } from '../auto-merge-revision.js';
import { conductorRevision } from '../conductor-revision.js';
import { MERGE_VETO_CONSUMER_KEYS } from '../keys.js';
import { deriveInstallationModel } from '../model.js';
import { parseInstallation } from '../parse.js';
import { resolveAutoMergePolicy, resolveConductorPolicy, resolveMergePolicy } from '../policy.js';
import type { FleetInstallationV2 } from '../types.js';
import { isFleetInstallationV2, writeInstallationV2 } from '../write.js';

const base = {
  schemaVersion: 2,
  hosts: {
    here: {
      transport: 'local',
      worktreeRoot: '/srv/fleet/base',
      roles: ['orchestrator', 'lane-runner'],
      runner: { kind: 'opencode', port: 46100 },
    },
  },
  forge: { mode: 'github', owner: 'example-owner', repo: 'example-repo' },
};
const jev = {
  provider: 'jev',
  model: 'example-provider/example-model',
  keyFile: '/etc/fleet/jev-key',
  minConfidence: 0.8,
  monthlyBudgetUsd: 50,
  assumedCostPerCallUsd: 0.01,
  acknowledgeProseLeavesHost: true,
};
const veto = { monthlyBudgetUsd: 5, acknowledgePullRequestTitleAndPathsLeaveHost: true };
const ENTRY = 'decisions.consumers.merge-veto';
const ACK = `${ENTRY}.acknowledgePullRequestTitleAndPathsLeaveHost`;
const BUDGET = `${ENTRY}.monthlyBudgetUsd`;

function withConsumers(consumers: unknown, decisions: Record<string, unknown> = jev): Record<string, unknown> {
  return { ...base, decisions: { ...decisions, consumers } };
}
function parseV2(value: unknown): FleetInstallationV2 {
  const result = parseInstallation(value);
  if (!result.ok || !isFleetInstallationV2(result.installation)) {
    throw new Error('the fixture must parse as a v2 file');
  }
  return result.installation;
}
function refusal(entry: unknown): unknown {
  return parseInstallation(withConsumers({ 'merge-veto': entry }));
}

describe('decisions.consumers.merge-veto (OG16c1)', () => {
  it('parses a well-formed merge-veto entry and keeps it', () => {
    const input = withConsumers({ 'merge-veto': veto });
    expect(parseInstallation(input)).toEqual({ ok: true, installation: input });
  });
  it('reads an absent entry as not configured, with no error and no default', () => {
    for (const input of [base, { ...base, decisions: jev }, withConsumers({}), withConsumers({ 'knowledge-ranking': { minConfidence: 0.7 } })]) {
      const result = parseInstallation(input);
      expect(result).toEqual({ ok: true, installation: input });
      expect(JSON.stringify(result)).not.toContain('merge-veto');
    }
  });
  it('refuses a present entry without the acknowledgement', () => {
    expect(refusal({ monthlyBudgetUsd: 5 })).toEqual({ ok: false, errors: [`${ACK}: required`] });
  });
  it.each([[false], ['yes'], [1], [null], ['true'], [{}], [[true]]])('refuses an acknowledgement that is not literally true without echoing it (%j)', (value) => {
    const result = refusal({ monthlyBudgetUsd: 5, acknowledgePullRequestTitleAndPathsLeaveHost: value });
    expect(result).toEqual({ ok: false, errors: [`${ACK}: must be true`] });
    expect(JSON.stringify(result)).not.toContain('yes');
  });
  it('requires the budget', () => {
    expect(refusal({ acknowledgePullRequestTitleAndPathsLeaveHost: true })).toEqual({ ok: false, errors: [`${BUDGET}: required`] });
  });
  it.each([[0], [-1], ['5'], [null], [true], [[5]], [{}], [Number.NaN], [Number.POSITIVE_INFINITY]])('refuses a malformed budget (%j)', (value) => {
    expect(refusal({ ...veto, monthlyBudgetUsd: value })).toEqual({ ok: false, errors: [`${BUDGET}: must be a number greater than 0`] });
  });
  it('refuses a budget above the block total and accepts one equal to it', () => {
    expect(refusal({ ...veto, monthlyBudgetUsd: 50.01 })).toEqual({ ok: false, errors: [`${BUDGET}: must not exceed decisions.monthlyBudgetUsd`] });
    expect(parseInstallation(withConsumers({ 'merge-veto': { ...veto, monthlyBudgetUsd: 50 } })).ok).toBe(true);
    expect(parseInstallation(withConsumers({ 'merge-veto': { ...veto, monthlyBudgetUsd: 10000 } }, { provider: 'answer-file', answerFile: '/etc/fleet/answers.json' })).ok).toBe(true);
  });
  it.each([[3], ['on'], [true], [null], [[]]])('refuses a non-object entry (%j)', (value) => {
    expect(refusal(value)).toEqual({ ok: false, errors: [`${ENTRY}: must be an object`] });
  });
  it('refuses unknown keys', () => {
    expect(refusal({ ...veto, minConfidence: 0.8 })).toEqual({ ok: false, errors: [`${ENTRY}: unknown key`] });
    expect(refusal({ ...veto, extra: 1 })).toEqual({ ok: false, errors: [`${ENTRY}: unknown key`] });
  });
  it('collects every error of a malformed entry in order', () => {
    expect(refusal({ monthlyBudgetUsd: -1, acknowledgePullRequestTitleAndPathsLeaveHost: 'yes', extra: 1 })).toEqual({
      ok: false,
      errors: [`${ENTRY}: unknown key`, `${BUDGET}: must be a number greater than 0`, `${ACK}: must be true`],
    });
  });
  it('still refuses an unknown consumer name', () => {
    expect(parseInstallation(withConsumers({ 'merge-vetoes': veto }))).toEqual({ ok: false, errors: ['decisions.consumers: unknown key'] });
  });
  it('round-trips the entry through the writer in key order', () => {
    const parsed = parseV2(withConsumers({ 'merge-veto': { acknowledgePullRequestTitleAndPathsLeaveHost: true, monthlyBudgetUsd: 5 }, 'knowledge-ranking': { minConfidence: 0.7 } }));
    const text = writeInstallationV2(parsed);
    const consumers = (JSON.parse(text) as { decisions: { consumers: Record<string, Record<string, unknown>> } }).decisions.consumers;
    expect(Object.keys(consumers)).toEqual(['knowledge-ranking', 'merge-veto']);
    expect(Object.keys(consumers['merge-veto'])).toEqual([...MERGE_VETO_CONSUMER_KEYS]);
    expect(parseInstallation(JSON.parse(text))).toEqual({ ok: true, installation: parsed });
    expect(writeInstallationV2(parseV2(JSON.parse(text)))).toBe(text);
  });
  it('the writer never adds the entry', () => {
    for (const input of [{ ...base, decisions: jev }, withConsumers({ 'claim-triage': { acknowledgeCandidateClaimsLeaveHost: true } })]) {
      expect(writeInstallationV2(parseV2(input))).not.toContain('merge-veto');
    }
  });
  it('the derived model carries the entry untouched', () => {
    const parsed = parseV2(withConsumers({ 'merge-veto': veto }));
    const outcome = deriveInstallationModel(parsed);
    expect(outcome.warnings).toEqual([]);
    expect(outcome.model.decisions).toEqual(parsed.decisions);
  });
  it('declaring the entry changes no policy revision', () => {
    const policy = { conductor: { enabled: true } };
    const a = parseV2({ ...base, policy, decisions: jev });
    const b = parseV2({ ...base, policy, decisions: { ...jev, consumers: { 'merge-veto': veto } } });
    expect(conductorRevision(resolveConductorPolicy(b.policy))).toBe(conductorRevision(resolveConductorPolicy(a.policy)));
    expect(conductorRevision(resolveConductorPolicy(b.policy))).toBe('ed656a35e15c');
    expect(resolveMergePolicy(b.policy)).toEqual(resolveMergePolicy(a.policy));
    expect(autoMergeRevision(resolveAutoMergePolicy(b.policy))).toBe(autoMergeRevision(resolveAutoMergePolicy(a.policy)));
  });
});
