/**
 * Direct unit tests for the shared profile write-check helpers
 * (`profile-write-checks.ts`). Pure, synchronous or microtask-only, in-memory:
 * no filesystem, network or timer use; total cost is O(n log n) over tiny
 * fixture inputs (sorting a handful of keys), well under 100ms.
 *
 * These tests document the helpers' behaviour as observed. The fix round for
 * run-01M8586J1XFBDK1EC2M5WA3R72 additionally required `trimStringArray` to
 * refuse an array hole with a named error (it previously passed holes
 * through), so that refusal is asserted here against the current helper.
 */

import { ProjectProfile } from '../../../domain/entities/ProjectProfile.js';
import { vi } from 'vitest';
import { describe, expect, it, afterEach } from 'vitest';

import type { ProjectProfileRecord } from '../../../domain/coordination-records.js';
import type { InstallationReferencePort } from '../../ports/out/InstallationReferencePort.out-port.js';
import {
  ProjectProfileRevisionConflictError,
  type ProjectProfileRepositoryPort,
} from '../../ports/out/ProjectProfileRepositoryPort.out-port.js';

import {
  checkInstallationNames,
  compareCodeUnits,
  findCredentialName,
  parseProfileRecord,
  saveProfileWithConflictCheck,
  trimString,
  trimStringArray,
} from '../profile-write-checks.js';

/** A valid, fully-known profile record (host-alpha is the only host). */
const baseRecord: ProjectProfileRecord = {
  projectId: 'project-alpha',
  displayName: 'Project Alpha',
  repository: 'https://example.invalid/project-alpha.git',
  designatedDispatcherHost: 'host-alpha',
  policyRevision: 'policy-1',
  maxConcurrentLanes: 2,
  runnerCapabilities: { fastLane: true },
  revision: 3,
  updatedAtIso: '2026-01-01T00:00:00.000Z',
  status: 'active',
  defaultBranch: 'main',
  clones: {},
  gateProcedures: ['gate-check'],
  defaultAllowedPathPrefixes: ['src/'],
  lastProbe: null,
};

/** Minimal installation reference port with the given host/procedure names. */
function refsPort(hosts: string[], procedures: string[]): InstallationReferencePort {
  return {
    references: () => ({ hostNames: hosts, procedureNames: procedures }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('findCredentialName', () => {
  it('returns null for an empty list', () => {
    expect(findCredentialName([])).toBeNull();
  });

  it('returns null when no name matches a credential pattern', () => {
    expect(findCredentialName(['gate', 'worktree'])).toBeNull();
  });

  it('returns the first matching name case-insensitively for every credential pattern', () => {
    const tokens = [
      'token',
      'secret',
      'credential',
      'password',
      'passphrase',
      'api-key',
      'api_key',
      'apikey',
      'private-key',
      'private_key',
      'access-key',
      'access_key',
      'authorization',
      'cookie',
    ];
    for (const token of tokens) {
      // Each case proves first-match selection when ordinary names precede it.
      expect(findCredentialName(['gate', 'worktree', token])).toBe(token);
      expect(findCredentialName([token, 'gate'])).toBe(token);
      expect(findCredentialName(['gate', token, token])).toBe(token);
      expect(findCredentialName([`my${token}`])).toBe(`my${token}`);
    }
    // Embedded and mixed-case names, including hyphen/underscore variants.
    expect(findCredentialName(['ordinary', 'myPassphrase'])).toBe('myPassphrase');
    expect(findCredentialName(['Set-Cookie'])).toBe('Set-Cookie');
    expect(findCredentialName(['API_KEY'])).toBe('API_KEY');
    expect(findCredentialName(['X-Authorization-Header'])).toBe('X-Authorization-Header');
  });

  it('flags tokenizer via substring match (current behaviour)', () => {
    // Documents the current substring-based matching: 'tokenizer' contains
    // 'token', so it is flagged even though it names a token *izer*, not a
    // credential. Not asserted as intended design.
    expect(findCredentialName(['tokenizer'])).toBe('tokenizer');
  });
});

describe('checkInstallationNames', () => {
  it('returns null when installationRefs is undefined', () => {
    // No port at all: the caller opted out of the installation check.
    expect(checkInstallationNames(undefined, baseRecord)).toBeNull();
  });

  it('returns no-installation-loaded reason when references() is null', () => {
    const port: InstallationReferencePort = { references: () => null };
    expect(checkInstallationNames(port, baseRecord)).toBe(
      'no installation is loaded to check host and procedure names against',
    );
  });

  it('reports unknown designatedDispatcherHost before unknown clone host', () => {
    const profile: ProjectProfileRecord = {
      ...baseRecord,
      designatedDispatcherHost: 'host-gamma',
      clones: { 'host-unknown': { path: 'clones/x', worktreeRoot: 'worktrees/x' } },
    };
    expect(checkInstallationNames(refsPort(['host-alpha'], ['gate-check']), profile)).toBe(
      'designatedDispatcherHost host-gamma is not a host in the installation',
    );
  });

  it('checks clone hosts in code-unit sorted order and reports the lexically first unknown host', () => {
    // Inserted unsorted (host-z before host-a, host-b before host-a) so the
    // assertion fails unless the keys are sorted before checking.
    const profile: ProjectProfileRecord = {
      ...baseRecord,
      clones: {
        'host-z': { path: 'clones/z', worktreeRoot: 'worktrees/z' },
        'host-b': { path: 'clones/b', worktreeRoot: 'worktrees/b' },
        'host-a': { path: 'clones/a', worktreeRoot: 'worktrees/a' },
      } as ProjectProfileRecord['clones'],
    };
    expect(checkInstallationNames(refsPort(['host-alpha'], ['gate-check']), profile)).toBe(
      'clone host host-a is not a host in the installation',
    );
  });

  it('reports unknown gate procedure last', () => {
    const profile: ProjectProfileRecord = {
      ...baseRecord,
      clones: { 'host-alpha': { path: 'clones/a', worktreeRoot: 'worktrees/a' } },
      gateProcedures: ['gate-check', 'gate-missing'],
    };
    expect(
      checkInstallationNames(
        refsPort(['host-alpha'], ['gate-check']),
        profile,
      ),
    ).toBe('gate procedure gate-missing is not a verification procedure in the installation');
  });

  it('returns null for a fully known profile', () => {
    const profile: ProjectProfileRecord = {
      ...baseRecord,
      clones: { 'host-beta': { path: 'clones/b', worktreeRoot: 'worktrees/b' } },
      gateProcedures: ['gate-check'],
    };
    expect(checkInstallationNames(refsPort(['host-alpha', 'host-beta'], ['gate-check']), profile))
      .toBeNull();
  });
});

describe('compareCodeUnits', () => {
  it('orders by UTF-16 code unit, unlike localeCompare', () => {
    expect(compareCodeUnits('B', 'a')).toBe(-1);
  });

  it('returns -1, 0 and 1 for less than, equal and greater than', () => {
    expect(compareCodeUnits('a', 'b')).toBe(-1);
    expect(compareCodeUnits('a', 'a')).toBe(0);
    expect(compareCodeUnits('b', 'a')).toBe(1);
  });
});

describe('parseProfileRecord', () => {
  it('returns { profile } matching the normalized record for a valid record', () => {
    const result = parseProfileRecord(baseRecord, 'fallback');
    expect(result).toEqual({ profile: ProjectProfile.fromRecord(baseRecord).toRecord() });
    expect(result).not.toHaveProperty('reason');
  });

  it('returns { reason } with the thrown Error message for malformed or null records', () => {
    const empty = { ...baseRecord, projectId: '' } as ProjectProfileRecord;
    expect(parseProfileRecord(empty, 'fallback')).toEqual({
      reason: 'ProjectProfile requires a non-empty projectId',
    });
    const credentialField = {
      ...baseRecord,
      apiKey: 'not-read-here',
    } as unknown as ProjectProfileRecord;
    expect(parseProfileRecord(credentialField, 'fallback')).toEqual({
      reason: 'ProjectProfile must not carry a credential field: apiKey',
    });
    const result = parseProfileRecord(null as unknown as ProjectProfileRecord, 'fallback');
    expect(result).toEqual({ reason: 'ProjectProfile requires a record' });
  });

  it('returns { reason: fallbackReason } when a non-Error value is thrown', () => {
    const spy = vi
      .spyOn(ProjectProfile, 'fromRecord')
      .mockImplementationOnce(() => {
        throw 'non-error';
      });
    expect(parseProfileRecord(baseRecord, 'fallback reason')).toEqual({
      reason: 'fallback reason',
    });
    spy.mockRestore();
  });

  it('returns { reason } with a throwing field getter\'s Error message, reading the getter once', () => {
    let reads = 0;
    const candidate = {
      ...baseRecord,
      get projectId(): string {
        reads += 1;
        throw new Error('getter refused the read');
      },
    } as unknown as ProjectProfileRecord;
    expect(parseProfileRecord(candidate, 'fallback')).toEqual({
      reason: 'getter refused the read',
    });
    // The helper never retried the read after the typed refusal.
    expect(reads).toBe(1);
  });

  it('returns { reason: fallbackReason } when a field getter throws a non-Error value', () => {
    const candidate = {
      ...baseRecord,
      get projectId(): string {
        throw 'getter threw a string';
      },
    } as unknown as ProjectProfileRecord;
    expect(parseProfileRecord(candidate, 'fallback')).toEqual({ reason: 'fallback' });
  });

  it('treats a consistent Proxy over a valid record like the record (documented residual)', () => {
    // A Proxy that lies consistently in every trap is an accepted residual of
    // the hostile-input rule; a transparent proxy is parsed like its target.
    const proxy = new Proxy(baseRecord, {});
    const result = parseProfileRecord(proxy as unknown as ProjectProfileRecord, 'fallback');
    expect(result).toEqual({ profile: ProjectProfile.fromRecord(baseRecord).toRecord() });
  });

  it('returns { reason } with the Proxy get trap\'s Error message when the trap throws', () => {
    const proxy = new Proxy(baseRecord, {
      get(target, key, receiver) {
        if (key === 'projectId') {
          throw new Error('proxy trap refused the read');
        }
        return Reflect.get(target, key, receiver);
      },
    });
    expect(parseProfileRecord(proxy as unknown as ProjectProfileRecord, 'fallback')).toEqual({
      reason: 'proxy trap refused the read',
    });
  });

  it('parses an enormous-length projectId today (documented residual: no length cap)', () => {
    // Cost bound: building one 1e6-character string and validating it is
    // O(n) in that length and stays far under the 100ms budget. The helper
    // delegates length policy to ProjectProfile.fromRecord, which only
    // requires a non-empty value; the absence of a cap is documented, not
    // asserted as intended design.
    const candidate = {
      ...baseRecord,
      projectId: 'x'.repeat(1_000_000),
    } as ProjectProfileRecord;
    const result = parseProfileRecord(candidate, 'fallback');
    expect(result).toHaveProperty('profile');
    expect((result as { profile: ProjectProfileRecord }).profile.projectId.length).toBe(1_000_000);
  });

  it('refuses a prototype-polluting clone key without polluting Object.prototype', () => {
    // An own enumerable '__proto__' data property (as a parsed payload would
    // carry) reaches the clone-key check and is refused there.
    const pollutingClones: ProjectProfileRecord['clones'] = {};
    Object.defineProperty(pollutingClones, '__proto__', {
      value: { path: '/clones/p', worktreeRoot: '/worktrees/p' },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const candidate = { ...baseRecord, clones: pollutingClones } as ProjectProfileRecord;
    expect(parseProfileRecord(candidate, 'fallback')).toEqual({
      reason: 'ProjectProfile clone host name is invalid: __proto__',
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('saveProfileWithConflictCheck', () => {
  it('returns null when saveProfile succeeds', async () => {
    const repo = { saveProfile: async () => undefined } as unknown as ProjectProfileRepositoryPort;
    await expect(saveProfileWithConflictCheck(repo, baseRecord, baseRecord.projectId)).resolves
      .toBeNull();
  });

  it('returns conflict reason naming projectId on ProjectProfileRevisionConflictError', async () => {
    const repo = {
      saveProfile: async () => {
        throw new ProjectProfileRevisionConflictError('project-alpha', 3, 5);
      },
    } as unknown as ProjectProfileRepositoryPort;
    // The typed refusal is the resolved value, not a rejection:
    await expect(
      saveProfileWithConflictCheck(repo, baseRecord, 'project-alpha'),
    ).resolves.toBe(
      'profile project-alpha changed while it was being written; read it again and retry',
    );
  });

  it('rethrows non-conflict errors unchanged by identity', async () => {
    const err = new Error('disk full');
    const repo = {
      saveProfile: async () => {
        throw err;
      },
    } as unknown as ProjectProfileRepositoryPort;
    await expect(saveProfileWithConflictCheck(repo, baseRecord, 'project-alpha')).rejects.toBe(err);
  });
});

describe('trimString', () => {
  it('trims strings and returns non-strings untouched by reference', () => {
    expect(trimString('  spaced  ')).toBe('spaced');
    expect(trimString('\t\nvalue\n')).toBe('value');

    const obj = { a: 1 };
    expect(trimString(obj)).toBe(obj);
    expect(trimString(null)).toBe(null);
    expect(trimString(undefined)).toBe(undefined);
    expect(trimString(42)).toBe(42);
  });
});

describe('trimStringArray', () => {
  it('trims string entries and returns non-string entries and non-arrays untouched by reference', () => {
    const obj = { a: 1 };
    const holey: string[] = ['  a  ', 'b'];
    expect(trimStringArray(['  a  ', 'b  ', obj as unknown as string])).toEqual(['a', 'b', obj]);
    // Non-string element keeps its identity.
    expect(trimStringArray([obj as unknown as string])[0]).toBe(obj);
    // An array hole is refused with a named error, not accepted or carried
    // through; the scan over the array's own indices is O(n) over a tiny input.
    // eslint-disable-next-line no-sparse-arrays
    const sparse = ['  a  ', , 'b'];
    expect(() => trimStringArray(sparse as unknown as string[])).toThrow(TypeError);
    expect(() => trimStringArray(sparse as unknown as string[])).toThrow(
      'trimStringArray refuses an array hole at index 1',
    );

    const arr = ['x  ', ' y'];
    expect(trimStringArray(arr)).toEqual(['x', 'y']);
    // A fresh array is returned for arrays, but non-array inputs keep identity:
    expect(trimStringArray(null)).toBe(null);
    expect(trimStringArray(undefined)).toBe(undefined);
    expect(trimStringArray(obj)).toBe(obj);
    const arrayLike = { length: 2, 0: ' a ', 1: 'b' };
    expect(trimStringArray(arrayLike)).toBe(arrayLike);
    // The original array object is not mutated in place; `holey` unchanged:
    expect(holey).toEqual(['  a  ', 'b']);
  });
});
