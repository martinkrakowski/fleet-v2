import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AGY_SECURITY_TEXT_VERSION } from '../agy-security.js';
import { loadInstallation } from '../load.js';
import { parseInstallation } from '../parse.js';
import { writeInstallationV2 } from '../write.js';
import type { FleetInstallationV2 } from '../types.js';

/** A minimal valid v2 file: one host with both required roles and a runner. */
function baseFile(runner: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 2,
    hosts: {
      lane: {
        transport: 'local',
        worktreeRoot: '/srv/fleet/worktrees',
        roles: ['orchestrator', 'lane-runner'],
        runner,
      },
    },
    forge: { mode: 'none' },
  };
}

/** The capability declaration that satisfies the isolation floor (D7). */
const floorCapabilities = {
  networkEgressRestricted: true,
  cpuAndMemoryLimited: true,
  processTreeTermination: true,
  filesystemScope: 'scoped-worktree',
};

const acknowledgement = {
  textVersion: AGY_SECURITY_TEXT_VERSION,
  acceptedAt: '2026-10-16T00:00:00Z',
};

function parseRunner(runner: Record<string, unknown>) {
  return parseInstallation(baseFile(runner));
}

describe('v2 agy runners (D7)', () => {
  it('accepts an opencode runner unchanged and keeps the old error text', () => {
    const result = parseRunner({ kind: 'opencode', port: 46000 });
    expect(result.ok).toBe(true);
    const badKind = parseRunner({ kind: 'other', port: 46000 });
    expect(badKind).toEqual({
      ok: false,
      errors: ['hosts.lane.runner.kind: must be a known runner kind'],
    });
  });

  it('accepts an agy edit-only runner on a declared host', () => {
    const result = parseRunner({
      kind: 'agy',
      port: 46000,
      agyMode: 'edit-only',
      capabilities: floorCapabilities,
    });
    expect(result.ok).toBe(true);
  });

  it('accepts an agy edit-only runner on an undeclared host', () => {
    const result = parseRunner({ kind: 'agy', port: 46000, agyMode: 'edit-only' });
    expect(result.ok).toBe(true);
  });

  it('requires agyMode on an agy runner', () => {
    const result = parseRunner({ kind: 'agy', port: 46000 });
    expect(result).toEqual({
      ok: false,
      errors: ['hosts.lane.runner.agyMode: required'],
    });
  });

  it('refuses an opencode runner carrying agy fields', () => {
    const withMode = parseRunner({ kind: 'opencode', port: 46000, agyMode: 'edit-only' });
    expect(withMode).toEqual({ ok: false, errors: ['hosts.lane.runner: unknown key'] });

    const withAcknowledgement = parseRunner({
      kind: 'opencode',
      port: 46000,
      agyAcknowledgement: acknowledgement,
    });
    expect(withAcknowledgement).toEqual({
      ok: false,
      errors: ['hosts.lane.runner: unknown key'],
    });
  });

  it('refuses agyMode full without the declared isolation floor', () => {
    const undeclared = parseRunner({
      kind: 'agy',
      port: 46000,
      agyMode: 'full',
      agyAcknowledgement: acknowledgement,
    });
    expect(undeclared.ok).toBe(false);
    if (!undeclared.ok) {
      expect(undeclared.errors).toEqual([
        'hosts.lane.runner.agyMode: full requires the declared isolation floor' +
          ' (scoped-worktree filesystem, restricted network egress, process tree termination)',
      ]);
      expect(undeclared.errors.join(' ')).not.toContain('scoped-worktree":');
    }

    const insufficient = parseRunner({
      kind: 'agy',
      port: 46000,
      agyMode: 'full',
      agyAcknowledgement: acknowledgement,
      capabilities: { ...floorCapabilities, networkEgressRestricted: false },
    });
    expect(insufficient.ok).toBe(false);
    if (!insufficient.ok) {
      expect(insufficient.errors[0]).toContain('agyMode: full requires the declared isolation floor');
    }

    const inherited = parseRunner({
      kind: 'agy',
      port: 46000,
      agyMode: 'full',
      agyAcknowledgement: acknowledgement,
      capabilities: { ...floorCapabilities, filesystemScope: 'inherited-directory' },
    });
    expect(inherited.ok).toBe(false);
  });

  it('refuses agyMode full without an acknowledgement', () => {
    const result = parseRunner({
      kind: 'agy',
      port: 46000,
      agyMode: 'full',
      capabilities: floorCapabilities,
    });
    expect(result).toEqual({
      ok: false,
      errors: [
        'hosts.lane.runner.agyAcknowledgement: full requires an acknowledgement of the current security text',
      ],
    });
  });

  it('refuses agyMode full with a stale acknowledgement version', () => {
    const result = parseRunner({
      kind: 'agy',
      port: 46000,
      agyMode: 'full',
      capabilities: floorCapabilities,
      agyAcknowledgement: { textVersion: '2000-01-01.1', acceptedAt: '2026-10-16T00:00:00Z' },
    });
    expect(result).toEqual({
      ok: false,
      errors: [
        'hosts.lane.runner.agyAcknowledgement: agyAcknowledgement is stale; re-confirm with init or /settings',
      ],
    });
  });

  it('accepts agyMode full with the floor and the current acknowledgement', () => {
    const result = parseRunner({
      kind: 'agy',
      port: 46000,
      agyMode: 'full',
      capabilities: floorCapabilities,
      agyAcknowledgement: acknowledgement,
    });
    expect(result.ok).toBe(true);
  });

  it('validates the acknowledgement shape without echoing values', () => {
    const notAnObject = parseRunner({
      kind: 'agy',
      port: 46000,
      agyMode: 'edit-only',
      agyAcknowledgement: 'yes',
    });
    expect(notAnObject).toEqual({
      ok: false,
      errors: ['hosts.lane.runner.agyAcknowledgement: must be an object'],
    });

    const badAcceptedAt = parseRunner({
      kind: 'agy',
      port: 46000,
      agyMode: 'edit-only',
      agyAcknowledgement: { textVersion: AGY_SECURITY_TEXT_VERSION, acceptedAt: 'yesterday' },
    });
    expect(badAcceptedAt).toEqual({
      ok: false,
      errors: ['hosts.lane.runner.agyAcknowledgement.acceptedAt: must be an ISO 8601 timestamp'],
    });

    const unknownKey = parseRunner({
      kind: 'agy',
      port: 46000,
      agyMode: 'edit-only',
      agyAcknowledgement: { ...acknowledgement, extra: 'x' },
    });
    expect(unknownKey).toEqual({
      ok: false,
      errors: ['hosts.lane.runner.agyAcknowledgement: unknown key'],
    });
  });
});

describe('v2 agy runners through the loader and writer', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'fleet-agy-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function loadFile(content: unknown) {
    const file = join(tempDir, 'fleet.json');
    writeFileSync(file, JSON.stringify(content));
    return loadInstallation({ file, cwd: tempDir });
  }

  it('loads an agy edit-only host and derives declared capabilities', () => {
    const result = loadFile(
      baseFile({ kind: 'agy', port: 46000, agyMode: 'edit-only', capabilities: floorCapabilities }),
    );
    expect(result.status).toBe('loaded');
    if (result.status === 'loaded') {
      const runner = result.model.hosts['lane']?.runner;
      expect(runner).toEqual({
        kind: 'agy',
        port: 46000,
        agyMode: 'edit-only',
        capabilities: { source: 'declared', ...floorCapabilities },
      });
    }
  });

  it('refuses agyMode full without the floor through the loader', () => {
    const result = loadFile(
      baseFile({ kind: 'agy', port: 46000, agyMode: 'full', agyAcknowledgement: acknowledgement }),
    );
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.errors[0]).toContain('agyMode: full requires the declared isolation floor');
    }
  });

  it('refuses agyMode full without an acknowledgement through the loader', () => {
    const result = loadFile(
      baseFile({ kind: 'agy', port: 46000, agyMode: 'full', capabilities: floorCapabilities }),
    );
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.errors).toEqual([
        'hosts.lane.runner.agyAcknowledgement: full requires an acknowledgement of the current security text',
      ]);
    }
  });

  it('refuses agyMode full with a stale acknowledgement through the loader', () => {
    const result = loadFile(
      baseFile({
        kind: 'agy',
        port: 46000,
        agyMode: 'full',
        capabilities: floorCapabilities,
        agyAcknowledgement: { textVersion: '1999-01-01.1', acceptedAt: '2026-10-16T00:00:00Z' },
      }),
    );
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.errors).toEqual([
        'hosts.lane.runner.agyAcknowledgement: agyAcknowledgement is stale; re-confirm with init or /settings',
      ]);
    }
  });

  it('loads agyMode full with the floor and the current acknowledgement', () => {
    const file = baseFile({
      kind: 'agy',
      port: 46000,
      agyMode: 'full',
      capabilities: floorCapabilities,
      agyAcknowledgement: acknowledgement,
    });
    const result = loadFile(file);
    expect(result.status).toBe('loaded');
    if (result.status === 'loaded') {
      expect(result.model.hosts['lane']?.runner?.kind).toBe('agy');
      expect(result.model.hosts['lane']?.runner && 'agyMode' in result.model.hosts['lane'].runner
        ? result.model.hosts['lane'].runner.agyMode
        : undefined).toBe('full');
    }
  });

  it('round-trips the agy fields through the writer', () => {
    const parsed = parseInstallation(
      baseFile({
        kind: 'agy',
        port: 46000,
        agyMode: 'full',
        capabilities: floorCapabilities,
        agyAcknowledgement: acknowledgement,
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const v2 = parsed.installation as FleetInstallationV2;
    const written = JSON.parse(writeInstallationV2(v2));
    expect(written.hosts.lane.runner).toEqual({
      kind: 'agy',
      port: 46000,
      agyMode: 'full',
      capabilities: floorCapabilities,
      agyAcknowledgement: acknowledgement,
    });
    expect(parseInstallation(written)).toEqual({ ok: true, installation: v2 });

    const editOnly = parseInstallation(
      baseFile({ kind: 'agy', port: 46000, agyMode: 'edit-only' }),
    );
    expect(editOnly.ok).toBe(true);
    if (editOnly.ok) {
      const writtenEditOnly = JSON.parse(
        writeInstallationV2(editOnly.installation as FleetInstallationV2),
      );
      expect(writtenEditOnly.hosts.lane.runner).toEqual({
        kind: 'agy',
        port: 46000,
        agyMode: 'edit-only',
      });
    }
  });

  it('round-trips an opencode runner without agy fields', () => {
    const parsed = parseInstallation(baseFile({ kind: 'opencode', port: 46000, maxLanes: 2 }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const written = JSON.parse(writeInstallationV2(parsed.installation as FleetInstallationV2));
    expect(written.hosts.lane.runner).toEqual({ kind: 'opencode', port: 46000, maxLanes: 2 });
  });
});
