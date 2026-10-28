/**
 * The pure `LoadResult` -> `AutoMergeSettingsAnswer` mapping (AM5-2). Every
 * installation here is an in-memory object; no file is read and no I/O runs.
 */

import { describe, expect, it } from 'vitest';

import type { FleetInstallation, LoadResult } from '@fleet/installation';

import { autoMergeSettingsFromLoad } from '../auto-merge-settings.js';

/** A minimal v2 installation with the given policy and forge sections. */
function v2Installation(overrides?: {
  policy?: Record<string, unknown>;
  forge?: Record<string, unknown>;
}): FleetInstallation {
  return {
    schemaVersion: 2,
    hosts: {},
    ...(overrides?.forge !== undefined ? { forge: overrides.forge as never } : {}),
    ...(overrides?.policy !== undefined
      ? { policy: overrides.policy as never }
      : {}),
  } as FleetInstallation;
}

describe('autoMergeSettingsFromLoad (AM5-2)', () => {
  it('invalid maps to unreadable with a fixed reason, never the loader text', () => {
    const load: LoadResult = {
      status: 'invalid',
      file: '/installation/fleet.json',
      errors: ['installation.hosts: secret-looking loader detail'],
    };
    const answer = autoMergeSettingsFromLoad(load);
    expect(answer).toEqual({
      outcome: 'unreadable',
      reason: 'installation invalid',
    });
  });

  it('absent maps to the defaults, off', () => {
    const load: LoadResult = {
      status: 'absent',
      installation: v2Installation(),
      model: {} as never,
      warnings: [],
    };
    const answer = autoMergeSettingsFromLoad(load);
    expect(answer).toEqual({
      outcome: 'read',
      enabled: false,
      allowHighRisk: false,
      onBlocked: 'ask-owner',
      revision: '0692f17be6e5',
      forgeMode: 'unknown',
    });
  });

  it('a v1 file maps to the defaults, off', () => {
    const load: LoadResult = {
      status: 'loaded',
      file: '/installation/fleet.json',
      installation: { schemaVersion: 1 } as FleetInstallation,
      model: {} as never,
      warnings: [],
    };
    const answer = autoMergeSettingsFromLoad(load);
    expect(answer).toEqual({
      outcome: 'read',
      enabled: false,
      allowHighRisk: false,
      onBlocked: 'ask-owner',
      revision: '0692f17be6e5',
      forgeMode: 'unknown',
    });
  });

  it('a loaded v2 file maps its policy block and forge mode', () => {
    const load: LoadResult = {
      status: 'loaded',
      file: '/installation/fleet.json',
      installation: v2Installation({
        policy: {
          autoMerge: { enabled: true, allowHighRisk: false, onBlocked: 'hold' },
        },
        forge: { mode: 'github', owner: 'example-org', repo: 'example-repo' },
      }),
      model: {} as never,
      warnings: [],
    };
    const answer = autoMergeSettingsFromLoad(load);
    expect(answer).toEqual({
      outcome: 'read',
      enabled: true,
      allowHighRisk: false,
      onBlocked: 'hold',
      revision: '1cbf028644d3',
      forgeMode: 'github',
    });
  });

  it('no forge section maps forgeMode unknown', () => {
    const load: LoadResult = {
      status: 'loaded',
      file: '/installation/fleet.json',
      installation: v2Installation(),
      model: {} as never,
      warnings: [],
    };
    const answer = autoMergeSettingsFromLoad(load);
    expect(answer).toMatchObject({ outcome: 'read', forgeMode: 'unknown' });
  });
});
