import { describe, expect, it } from 'vitest';

import { REAPER_FINDING_SCHEMA_VERSION, classifyZombies } from '../reaper-findings.js';
import type {
  MergedWorktreeFacts,
  ReaperFinding,
  ReaperObservation,
  ReaperPolicy,
} from '../reaper-findings.js';

const NOW = '2026-10-27T10:00:00.000Z';
const WORKTREE = 'wt-a1b2c3d4e5f6';
const HOST = 'host-7f3a';

/** An aged prior sighting: seen before, last sighting at least the grace before NOW. */
function agedPrior(observation: ReaperObservation): ReaperFinding {
  return finding(observation.kind, observation.subject as string, '2026-10-27T09:50:00.000Z', '2026-10-27T09:50:00.000Z', 1);
}

/**
 * One observation per (subject, kind) through one shared classify helper.
 * With no prior given, an aged prior sighting is supplied so the two-sightings
 * rule has passed; pass `null` explicitly for a first sighting.
 */
function classify(
  observation: ReaperObservation,
  prior?: ReaperFinding | null,
  policy: ReaperPolicy = {},
): ReaperFinding | null {
  const openFindings = prior === undefined ? [agedPrior(observation)] : prior === null ? [] : [prior];
  const findings = classifyZombies({ observations: [observation], openFindings }, NOW, policy);
  return findings.length === 0 ? null : (findings[0] as ReaperFinding);
}

const MERGED_PR_FACTS: MergedWorktreeFacts = {
  headOnDefault: 'yes',
  evidence: 'merged-pr',
  clean: 'yes',
  unlocked: 'yes',
  onBranch: 'yes',
  notBusy: 'yes',
  noLiveRecord: 'yes',
  runnerIdle: 'yes',
  noYoungIntent: 'yes',
  quiet: 'yes',
  notPrimary: 'yes',
};

function mergedFacts(overrides: Partial<MergedWorktreeFacts>): MergedWorktreeFacts {
  return { ...MERGED_PR_FACTS, ...overrides };
}

function finding(
  kind: ReaperFinding['kind'],
  subject: string,
  firstSightingIso: string,
  lastSightingIso: string,
  sightings: number,
): ReaperFinding {
  return { schemaVersion: REAPER_FINDING_SCHEMA_VERSION, kind, subject, action: 'wait', firstSightingIso, lastSightingIso, sightings };
}

describe('classifyZombies — orphan-session', () => {
  const base = {
    kind: 'orphan-session' as const,
    subject: 'attempt-one',
    youngActivity: false,
    attemptsTerminalOrAbsent: true,
    commitsNotOnRemote: false,
  };

  it('has no finding while the attempts are not terminal or absent', () => {
    expect(classify({ ...base, attemptsTerminalOrAbsent: false })).toBeNull();
  });

  it('reports without the opt-in', () => {
    expect(classify(base)?.action).toBe('report');
  });

  it('repairs with the opt-in', () => {
    const policy: ReaperPolicy = { repairs: { 'orphan-session': true } };
    expect(classify(base, undefined, policy)?.action).toBe('repair');
  });

  it('never repairs when the commits are not on the remote', () => {
    const policy: ReaperPolicy = { repairs: { 'orphan-session': true } };
    expect(classify({ ...base, commitsNotOnRemote: true }, undefined, policy)?.action).toBe('report');
  });
});

describe('classifyZombies — dead-attempt', () => {
  const base = {
    kind: 'dead-attempt' as const,
    subject: 'attempt-two',
    youngActivity: false,
    recordSaysRunning: true,
    sessionEndedOrMissing: true,
  };

  it('has no finding when the record does not say running', () => {
    expect(classify({ ...base, recordSaysRunning: false })).toBeNull();
  });

  it('has no finding when the session is not ended or missing', () => {
    expect(classify({ ...base, sessionEndedOrMissing: false })).toBeNull();
  });

  it('reports without the opt-in and repairs with it', () => {
    expect(classify(base)?.action).toBe('report');
    const policy: ReaperPolicy = { repairs: { 'dead-attempt': true } };
    expect(classify(base, undefined, policy)?.action).toBe('repair');
  });
});

describe('classifyZombies — driverless-run', () => {
  const base = {
    kind: 'driverless-run' as const,
    subject: 'run-one',
    youngActivity: false,
    nonTerminalRun: true,
    runLeaseLapsed: true,
    driverLeaseHeld: false,
  };

  it('has no finding while the driver lease is held', () => {
    expect(classify({ ...base, driverLeaseHeld: true })).toBeNull();
  });

  it('has no finding while the run is terminal', () => {
    expect(classify({ ...base, nonTerminalRun: false })).toBeNull();
  });

  it('is report and never repair, even with repairs set for every kind', () => {
    const policy: ReaperPolicy = {
      repairs: {
        'orphan-session': true, 'dead-attempt': true, 'driverless-run': true, 'leaked-slot': true,
        'stale-stop': true, 'orphan-worktree': true, 'stale-attention': true, 'merged-worktree': true,
        'disk-pressure': true,
      },
    };
    expect(classify(base, undefined, policy)?.action).toBe('report');
  });
});

describe('classifyZombies — leaked-slot', () => {
  const base = {
    kind: 'leaked-slot' as const,
    subject: 'reservation-one',
    youngActivity: false,
    attemptState: 'ended' as const,
  };
  const policy: ReaperPolicy = { repairs: { 'leaked-slot': true } };

  it('has no finding while the attempt is live', () => {
    expect(classify({ ...base, attemptState: 'live' })).toBeNull();
  });

  it('reports an absent attempt even with the opt-in', () => {
    expect(classify({ ...base, attemptState: 'absent' }, undefined, policy)?.action).toBe('report');
  });

  it('reports without the opt-in and repairs with it for ended, collected and cancelled', () => {
    expect(classify(base)?.action).toBe('report');
    for (const attemptState of ['ended', 'collected', 'cancelled'] as const) {
      expect(classify({ ...base, attemptState }, undefined, policy)?.action).toBe('repair');
    }
  });
});

describe('classifyZombies — stale-stop', () => {
  const fresh = {
    kind: 'stale-stop' as const,
    subject: 'run-two',
    youngActivity: false,
    stopUnconfirmedParkedAtIso: '2026-10-27T09:50:00.000Z',
    stopRetriesSpent: false,
  };

  it('has no finding for a fresh park', () => {
    expect(classify(fresh)).toBeNull();
  });

  it('has a finding once the park is older than staleStopMinutes', () => {
    const old = { ...fresh, stopUnconfirmedParkedAtIso: '2026-10-27T09:29:00.000Z' };
    expect(classify(old)?.action).toBe('report');
  });

  it('has a finding when the stop retries are spent', () => {
    expect(classify({ ...fresh, stopRetriesSpent: true })?.action).toBe('report');
  });

  it('repairs only with the opt-in', () => {
    const spent = { ...fresh, stopRetriesSpent: true };
    const policy: ReaperPolicy = { repairs: { 'stale-stop': true } };
    expect(classify(spent, undefined, policy)?.action).toBe('repair');
  });
});

describe('classifyZombies — orphan-worktree', () => {
  const base = {
    kind: 'orphan-worktree' as const,
    subject: WORKTREE,
    youngActivity: false,
    noLiveRecord: true,
    branchPrMerged: false,
  };
  const policy: ReaperPolicy = { repairs: { 'orphan-worktree': true, 'merged-worktree': true } };

  it('has a finding when no live record names the worktree, always report', () => {
    expect(classify(base)?.action).toBe('report');
    expect(classify(base, undefined, policy)?.action).toBe('report');
  });

  it('has a finding when the branch PR is merged, always report', () => {
    const merged = { ...base, noLiveRecord: false, branchPrMerged: true };
    expect(classify(merged)?.action).toBe('report');
    expect(classify(merged, undefined, policy)?.action).toBe('report');
  });
});

describe('classifyZombies — stale-attention', () => {
  const base = {
    kind: 'stale-attention' as const,
    subject: 'attention-one',
    youngActivity: false,
    attentionOpen: true,
    questionUnanswered: false,
    runTerminal: true,
  };
  const policy: ReaperPolicy = { repairs: { 'stale-attention': true } };

  it('has no finding for a non-terminal run', () => {
    expect(classify({ ...base, runTerminal: false })).toBeNull();
  });

  it('has a finding for an open attention item and one for an unanswered question', () => {
    expect(classify(base)).not.toBeNull();
    expect(classify({ ...base, attentionOpen: false, questionUnanswered: true })).not.toBeNull();
  });

  it('keeps the unanswered question report even with the opt-in', () => {
    const question = { ...base, attentionOpen: false, questionUnanswered: true };
    expect(classify(question, undefined, policy)?.action).toBe('report');
  });

  it('repairs the open attention item only with the opt-in', () => {
    expect(classify(base)?.action).toBe('report');
    expect(classify(base, undefined, policy)?.action).toBe('repair');
  });
});

describe('classifyZombies — merged-worktree, one test per fact', () => {
  const base = {
    kind: 'merged-worktree' as const,
    subject: WORKTREE,
    youngActivity: false,
    facts: MERGED_PR_FACTS,
  };

  it('has a finding for a full yes set with merged-pr evidence', () => {
    expect(classify(base)).not.toBeNull();
  });

  it('has no finding when a fact is no', () => {
    for (const fact of ['headOnDefault', 'clean', 'unlocked', 'onBranch', 'notBusy', 'noLiveRecord', 'runnerIdle', 'noYoungIntent', 'quiet', 'notPrimary'] as const) {
      expect(classify({ ...base, facts: mergedFacts({ [fact]: 'no' }) })).toBeNull();
    }
  });

  it('has no finding when a fact is unknown (unknown is never true)', () => {
    for (const fact of ['headOnDefault', 'clean', 'unlocked', 'onBranch', 'notBusy', 'noLiveRecord', 'runnerIdle', 'noYoungIntent', 'quiet', 'notPrimary'] as const) {
      expect(classify({ ...base, facts: mergedFacts({ [fact]: 'unknown' }) })).toBeNull();
    }
  });
});

describe('classifyZombies — merged-worktree evidence and repair', () => {
  const base = {
    kind: 'merged-worktree' as const,
    subject: WORKTREE,
    youngActivity: false,
    facts: MERGED_PR_FACTS,
  };
  const policy: ReaperPolicy = { repairs: { 'merged-worktree': true } };

  it('reports ancestor-only and never repairs it', () => {
    const ancestorOnly = { ...base, facts: mergedFacts({ evidence: 'ancestor-only' }) };
    expect(classify(ancestorOnly)?.action).toBe('report');
    expect(classify(ancestorOnly, undefined, policy)?.action).toBe('report');
  });

  it('repairs only with the opt-in and merged-pr evidence', () => {
    expect(classify(base)?.action).toBe('report');
    expect(classify(base, undefined, policy)?.action).toBe('repair');
  });

  it('has no finding with unknown evidence', () => {
    expect(classify({ ...base, facts: mergedFacts({ evidence: 'unknown' }) })).toBeNull();
  });
});

describe('classifyZombies — merged-worktree precedence over orphan-worktree', () => {
  it('keeps only the merged-worktree finding for a subject with both observations', () => {
    const findings = classifyZombies(
      {
        observations: [
          { kind: 'orphan-worktree', subject: WORKTREE, youngActivity: false, noLiveRecord: true, branchPrMerged: false },
          { kind: 'merged-worktree', subject: WORKTREE, youngActivity: false, facts: MERGED_PR_FACTS },
        ],
        openFindings: [],
      },
      NOW,
      {},
    );
    expect(findings).toHaveLength(1);
    expect((findings[0] as ReaperFinding).kind).toBe('merged-worktree');
  });

  it('keeps an orphan-worktree finding whose subject does not qualify as merged-worktree', () => {
    const other = 'wt-000000000000';
    const findings = classifyZombies(
      {
        observations: [
          { kind: 'orphan-worktree', subject: WORKTREE, youngActivity: false, noLiveRecord: true, branchPrMerged: false },
          { kind: 'orphan-worktree', subject: other, youngActivity: false, noLiveRecord: true, branchPrMerged: false },
          { kind: 'merged-worktree', subject: WORKTREE, youngActivity: false, facts: MERGED_PR_FACTS },
        ],
        openFindings: [],
      },
      NOW,
      {},
    );
    const kinds = findings.map((f) => f.kind).sort();
    expect(kinds).toEqual(['merged-worktree', 'orphan-worktree']);
    const orphan = findings.find((f) => f.kind === 'orphan-worktree') as ReaperFinding;
    expect(orphan.subject).toBe(other);
  });
});

describe('classifyZombies — disk-pressure', () => {
  const base = {
    kind: 'disk-pressure' as const,
    subject: HOST,
    youngActivity: false,
    freePercent: 10,
  };
  const policy: ReaperPolicy = { minFreePercent: 15, repairs: { 'disk-pressure': true } };

  it('has no finding at or above minFreePercent', () => {
    expect(classify({ ...base, freePercent: 15 }, undefined, policy)).toBeNull();
    expect(classify({ ...base, freePercent: 90 }, undefined, policy)).toBeNull();
  });

  it('has a report finding below minFreePercent and never repairs', () => {
    expect(classify(base, undefined, policy)?.action).toBe('report');
  });

  it('has no finding with a null freePercent', () => {
    expect(classify({ ...base, freePercent: null }, undefined, policy)).toBeNull();
  });
});

describe('classifyZombies — two sightings and the grace', () => {
  const observation = {
    kind: 'orphan-worktree' as const,
    subject: WORKTREE,
    youngActivity: false,
    noLiveRecord: true,
    branchPrMerged: false,
  };

  it('is wait on the first sighting', () => {
    expect(classify(observation, null)?.action).toBe('wait');
  });

  it('is wait on a second sighting inside the grace', () => {
    const prior = finding('orphan-worktree', WORKTREE, '2026-10-27T09:58:00.000Z', '2026-10-27T09:58:00.000Z', 1);
    const findings = classifyZombies(
      { observations: [observation], openFindings: [prior] },
      '2026-10-27T10:02:00.000Z',
      {},
    );
    expect((findings[0] as ReaperFinding).action).toBe('wait');
  });

  it('carries the kind action on a second sighting at least graceMinutes later', () => {
    const prior = finding('orphan-worktree', WORKTREE, '2026-10-27T09:50:00.000Z', '2026-10-27T09:50:00.000Z', 1);
    const findings = classifyZombies(
      { observations: [observation], openFindings: [prior] },
      '2026-10-27T10:00:00.000Z',
      {},
    );
    expect((findings[0] as ReaperFinding).action).toBe('report');
  });
});

describe('classifyZombies — the sighting bookkeeping', () => {
  const observation = {
    kind: 'orphan-session' as const,
    subject: 'attempt-three',
    youngActivity: false,
    attemptsTerminalOrAbsent: true,
    commitsNotOnRemote: false,
  };

  it('counts sightings up and keeps the first sighting time', () => {
    const prior = finding('orphan-session', 'attempt-three', '2026-10-27T09:00:00.000Z', '2026-10-27T09:50:00.000Z', 3);
    const result = classify(observation, prior);
    expect(result?.sightings).toBe(4);
    expect(result?.firstSightingIso).toBe('2026-10-27T09:00:00.000Z');
    expect(result?.lastSightingIso).toBe(NOW);
  });

  it('starts a fresh sighting without a prior', () => {
    const result = classify(observation, null);
    expect(result?.sightings).toBe(1);
    expect(result?.firstSightingIso).toBe(NOW);
    expect(result?.lastSightingIso).toBe(NOW);
  });
});

describe('classifyZombies — canonical timestamp guard', () => {
  const observation = {
    kind: 'orphan-session' as const,
    subject: 'attempt-canonical',
    youngActivity: false,
    attemptsTerminalOrAbsent: true,
    commitsNotOnRemote: false,
  };

  it('a secret-shaped nowIso never appears in any returned field', () => {
    const secretNowTimes = [
      'AIza' + 'A'.repeat(30),
      'ghp_' + 'B'.repeat(36),
      'sk-' + 'C'.repeat(40),
    ];
    for (const secretNow of secretNowTimes) {
      const findings = classifyZombies(
        { observations: [observation], openFindings: [] },
        secretNow,
        {},
      );
      // An unreadable clock emits no finding: no stored record ever carries a non-canonical sighting time.
      expect(findings).toEqual([]);
      expect(JSON.stringify(findings)).not.toContain(secretNow);
    }
  });

  it('a secret-shaped prior firstSightingIso never appears', () => {
    const secretFirstSightings = [
      'AIza' + 'A'.repeat(30),
      'ghp_' + 'B'.repeat(36),
      'sk-' + 'C'.repeat(40),
    ];
    for (const secretPrior of secretFirstSightings) {
      const prior = finding(
        'orphan-session',
        'attempt-canonical',
        secretPrior,
        '2026-10-27T09:50:00.000Z',
        1,
      );
      const findings = classifyZombies(
        { observations: [observation], openFindings: [prior] },
        NOW,
        {},
      );
      expect(findings).toHaveLength(1);
      const res = findings[0]!;
      expect(res.firstSightingIso).toBe(NOW);
      expect(res.lastSightingIso).toBe(NOW);
      for (const value of Object.values(res)) {
        if (typeof value === 'string') {
          expect(value).not.toContain(secretPrior);
        }
      }
      expect(JSON.stringify(res)).not.toContain(secretPrior);
    }
  });

  it('a canonical prior firstSightingIso is kept', () => {
    const canonicalPriorIso = '2026-10-27T09:15:30.123Z';
    const prior = finding(
      'orphan-session',
      'attempt-canonical',
      canonicalPriorIso,
      '2026-10-27T09:50:00.000Z',
      2,
    );
    const findings = classifyZombies(
      { observations: [observation], openFindings: [prior] },
      NOW,
      {},
    );
    expect(findings).toHaveLength(1);
    const res = findings[0]!;
    expect(res.sightings).toBe(3);
    expect(res.firstSightingIso).toBe(canonicalPriorIso);
    expect(res.lastSightingIso).toBe(NOW);
  });
});

describe('classifyZombies — young activity', () => {
  it('is wait and never report or repair while the activity is young', () => {
    const observation = {
      kind: 'orphan-session' as const,
      subject: 'attempt-four',
      youngActivity: true,
      attemptsTerminalOrAbsent: true,
      commitsNotOnRemote: false,
    };
    const prior = finding('orphan-session', 'attempt-four', '2026-10-27T09:00:00.000Z', '2026-10-27T09:00:00.000Z', 1);
    const policy: ReaperPolicy = { repairs: { 'orphan-session': true } };
    expect(classify(observation, prior, policy)?.action).toBe('wait');
  });
});

describe('classifyZombies — the subject guard', () => {
  it('produces no finding for a path-shaped or empty subject', () => {
    const pathObservation: ReaperObservation = {
      kind: 'orphan-worktree',
      subject: 'worktrees/secret-path',
      youngActivity: false,
      noLiveRecord: true,
      branchPrMerged: false,
    };
    const emptyObservation: ReaperObservation = {
      kind: 'orphan-worktree',
      subject: '',
      youngActivity: false,
      noLiveRecord: true,
      branchPrMerged: false,
    };
    expect(classifyZombies({ observations: [pathObservation, emptyObservation], openFindings: [] }, NOW, {})).toEqual([]);
  });

  it('produces no finding for a secret-shaped subject such as a GitHub token', () => {
    const tokenSubjects = [
      'ghp_' + 'A'.repeat(36),
      'gho_' + 'B'.repeat(36),
      'ghs_' + 'C'.repeat(36),
      'github_pat_' + 'D'.repeat(40),
      'glpat-' + 'E'.repeat(20),
      'sk-' + 'F'.repeat(40),
      'sk-ant-' + 'G'.repeat(40),
      'xoxb-' + 'H'.repeat(24),
      'AKIA' + 'I'.repeat(16),
      'npm_' + 'J'.repeat(30),
    ];
    const observations: ReaperObservation[] = tokenSubjects.map((subject) => ({
      kind: 'orphan-worktree',
      subject,
      youngActivity: false,
      noLiveRecord: true,
      branchPrMerged: false,
    }));
    expect(classifyZombies({ observations, openFindings: [] }, NOW, {})).toEqual([]);
  });

  it('an AIza… key, a ghp_… token and a sk-… key in a subject each do not appear in any returned finding', () => {
    const validSubject = 'wt-valid000000';
    const secretSubjects = [
      'AIza' + 'A'.repeat(30),
      'ghp_' + 'B'.repeat(36),
      'sk-' + 'C'.repeat(40),
    ];
    for (const subject of secretSubjects) {
      const secretObservation: ReaperObservation = {
        kind: 'orphan-worktree',
        subject,
        youngActivity: false,
        noLiveRecord: true,
        branchPrMerged: false,
      };
      const validObservation: ReaperObservation = {
        kind: 'orphan-worktree',
        subject: validSubject,
        youngActivity: false,
        noLiveRecord: true,
        branchPrMerged: false,
      };
      const findings = classifyZombies(
        { observations: [secretObservation, validObservation], openFindings: [] },
        NOW,
        {},
      );
      expect(findings.some((finding) => finding.subject === subject)).toBe(false);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.subject).toBe(validSubject);
    }
  });

  it('still accepts ordinary ids alongside rejected secret-shaped subjects', () => {
    const tokenObservation: ReaperObservation = {
      kind: 'orphan-worktree',
      subject: 'ghp_' + 'A'.repeat(36),
      youngActivity: false,
      noLiveRecord: true,
      branchPrMerged: false,
    };
    const idObservation: ReaperObservation = {
      kind: 'orphan-worktree',
      subject: 'wt-' + 'a'.repeat(12),
      youngActivity: false,
      noLiveRecord: true,
      branchPrMerged: false,
    };
    const findings = classifyZombies(
      { observations: [tokenObservation, idObservation], openFindings: [] },
      NOW,
      {},
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.subject).toBe('wt-' + 'a'.repeat(12));
  });
});

describe('classifyZombies — the schema version', () => {
  it('is 1 on every finding', () => {
    const findings = classifyZombies(
      {
        observations: [
          { kind: 'orphan-session', subject: 'attempt-five', youngActivity: false, attemptsTerminalOrAbsent: true, commitsNotOnRemote: false },
          { kind: 'disk-pressure', subject: HOST, youngActivity: false, freePercent: 3 },
        ],
        openFindings: [],
      },
      NOW,
      { minFreePercent: 15 },
    );
    for (const f of findings) {
      expect(f.schemaVersion).toBe(1);
    }
  });
});

describe('classifyZombies — never throws', () => {
  const observation = {
    kind: 'stale-stop' as const,
    subject: 'run-three',
    youngActivity: false,
    stopUnconfirmedParkedAtIso: '2026-10-27T09:00:00.000Z',
    stopRetriesSpent: false,
  };

  it('returns without throwing on an unparsable nowIso', () => {
    const seen = { ...observation, stopRetriesSpent: true };
    const findings = classifyZombies({ observations: [seen], openFindings: [] }, 'not-a-time', {});
    // No finding without a canonical clock value, so no stored record holds a null or invalid sighting time.
    expect(findings).toEqual([]);
  });

  it('returns without throwing on a negative graceMinutes', () => {
    const findings = classifyZombies({ observations: [observation], openFindings: [] }, NOW, { graceMinutes: -1 });
    expect(findings[0]?.action).toBe('wait');
  });

  it('returns without throwing on an empty observations list', () => {
    expect(classifyZombies({ observations: [], openFindings: [] }, NOW, {})).toEqual([]);
  });

  it('returns without throwing on an unknown repair kind', () => {
    const policy = { repairs: { 'not-a-kind': true } } as unknown as ReaperPolicy;
    expect(() => classifyZombies({ observations: [observation], openFindings: [] }, NOW, policy)).not.toThrow();
  });
});
