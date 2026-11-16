import { describe, expect, it } from 'vitest';

import { parseInstallation } from '../parse.js';
import { isFleetInstallationV2, writeInstallationV2 } from '../write.js';

/** One local orchestrator host and one ssh lane-runner host, both minimal. */
const baseHosts = {
  'orchestrator-host': {
    transport: 'local',
    worktreeRoot: '/srv/fleet/orchestrator',
    roles: ['orchestrator'],
  },
  'lane-host': {
    transport: 'ssh',
    sshAlias: 'lane-host.example',
    worktreeRoot: '/srv/fleet/lane',
    roles: ['lane-runner'],
    runner: { kind: 'opencode', port: 46000 },
  },
} as const;

const validV2 = {
  schemaVersion: 2,
  hosts: baseHosts,
  tools: ['opencode'],
  seats: [
    {
      id: 'implementer',
      tool: 'opencode',
      model: 'example-provider/example-model',
      roles: ['implementer'],
      costClass: 'plan-quota',
    },
  ],
  chains: { implementer: [{ seatId: 'implementer' }] },
  policy: { forbiddenRoutes: [{ tool: 'example-tool', modelPattern: 'example-*' }] },
  shelf: { provider: 'local' },
  forge: { mode: 'github', owner: 'example-owner', repo: 'example-repo' },
  verification: { procedures: { gate: { command: 'yarn', args: ['test'] } } },
};

type HostName = keyof typeof baseHosts;

const SLOT = { name: 'primary', unit: 'fleet-ci@0.service' } as const;

/** Replace a host's `ciRunnerSlots` with the given value (or absent). */
function withSlots(hostName: HostName, slots: unknown): Record<string, unknown> {
  const hosts: Record<string, unknown> = { ...baseHosts };
  const host: Record<string, unknown> = { ...baseHosts[hostName] };
  host.ciRunnerSlots = slots;
  hosts[hostName] = host;
  return { ...validV2, hosts };
}

/** Install both hosts as given, replacing the base hosts entirely. */
function withHosts(hosts: Record<string, unknown>): Record<string, unknown> {
  return { ...validV2, hosts };
}

function slotList(count: number): Array<{ name: string; unit: string }> {
  return Array.from({ length: count }, (_unused, index) => ({
    name: `slot-${index}`,
    unit: `fleet-ci@${index}.service`,
  }));
}

describe('parseInstallation hosts.<name>.ciRunnerSlots (OG-28a)', () => {
  it('accepts ciRunnerSlots on an ssh host and on a local host', () => {
    const hosts: Record<string, unknown> = {
      ...baseHosts,
      'orchestrator-host': {
        ...baseHosts['orchestrator-host'],
        ciRunnerSlots: [SLOT],
      },
      'lane-host': { ...baseHosts['lane-host'], ciRunnerSlots: [SLOT] },
    };
    const result = parseInstallation(withHosts(hosts));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const hosts_ = result.installation.hosts as Record<
      string,
      { ciRunnerSlots?: unknown } | undefined
    >;
    expect(hosts_['orchestrator-host']?.ciRunnerSlots).toEqual([SLOT]);
    expect(hosts_['lane-host']?.ciRunnerSlots).toEqual([SLOT]);
  });

  it('accepts an absent ciRunnerSlots', () => {
    const result = parseInstallation(validV2);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    for (const host of Object.values(result.installation.hosts ?? {})) {
      expect(Object.hasOwn(host, 'ciRunnerSlots')).toBe(false);
    }
  });

  it('refuses a non-array ciRunnerSlots', () => {
    for (const slots of ['primary', { name: 'primary' }, null, 2]) {
      expect(parseInstallation(withSlots('lane-host', slots))).toEqual({
        ok: false,
        errors: ['hosts.lane-host.ciRunnerSlots: must be an array'],
      });
    }
  });

  it('refuses a 17th ciRunnerSlots entry and accepts 16', () => {
    expect(parseInstallation(withSlots('lane-host', slotList(17)))).toEqual({
      ok: false,
      errors: ['hosts.lane-host.ciRunnerSlots: must have at most 16 entries'],
    });
    const result = parseInstallation(withSlots('lane-host', slotList(16)));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(
      (result.installation.hosts as Record<string, { ciRunnerSlots?: unknown[] }>)['lane-host']
        ?.ciRunnerSlots,
    ).toHaveLength(16);
  });

  it('refuses a non-object ciRunnerSlots entry', () => {
    for (const entry of [null, 'primary', ['primary']]) {
      expect(parseInstallation(withSlots('lane-host', [entry]))).toEqual({
        ok: false,
        errors: ['hosts.lane-host.ciRunnerSlots[0]: must be an object'],
      });
    }
  });

  it('refuses an accessor property without invoking the getter', () => {
    // On the ciRunnerSlots field itself.
    const host: Record<string, unknown> = { ...baseHosts['lane-host'] };
    let slotsRead = false;
    Object.defineProperty(host, 'ciRunnerSlots', {
      enumerable: true,
      get: () => {
        slotsRead = true;
        throw new Error('the getter must never run');
      },
    });
    const hosts: Record<string, unknown> = { ...baseHosts };
    hosts['lane-host'] = host;
    expect(parseInstallation(withHosts(hosts))).toEqual({
      ok: false,
      errors: ['hosts.lane-host.ciRunnerSlots: must be a plain data property'],
    });
    expect(slotsRead).toBe(false);

    // On a slot's name.
    const nameSlot: Record<string, unknown> = { unit: SLOT.unit };
    let nameRead = false;
    Object.defineProperty(nameSlot, 'name', {
      enumerable: true,
      get: () => {
        nameRead = true;
        throw new Error('the getter must never run');
      },
    });
    expect(parseInstallation(withSlots('lane-host', [nameSlot]))).toEqual({
      ok: false,
      errors: ['hosts.lane-host.ciRunnerSlots[0].name: must be a plain data property'],
    });
    expect(nameRead).toBe(false);

    // On a slot's unit.
    const unitSlot: Record<string, unknown> = { name: SLOT.name };
    let unitRead = false;
    Object.defineProperty(unitSlot, 'unit', {
      enumerable: true,
      get: () => {
        unitRead = true;
        throw new Error('the getter must never run');
      },
    });
    expect(parseInstallation(withSlots('lane-host', [unitSlot]))).toEqual({
      ok: false,
      errors: ['hosts.lane-host.ciRunnerSlots[0].unit: must be a plain data property'],
    });
    expect(unitRead).toBe(false);
  });

  it('refuses a throwing getter at an array index without invoking it', () => {
    let reads = 0;
    const slots: unknown[] = [];
    Object.defineProperty(slots, 0, {
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error('the getter must never run');
      },
    });
    expect(parseInstallation(withSlots('lane-host', slots))).toEqual({
      ok: false,
      errors: ['hosts.lane-host.ciRunnerSlots[0]: must be an object'],
    });
    expect(reads).toBe(0);
  });

  it('refuses a hole in the ciRunnerSlots array', () => {
    const slots: unknown[] = [];
    slots.length = 1;
    expect(parseInstallation(withSlots('lane-host', slots))).toEqual({
      ok: false,
      errors: ['hosts.lane-host.ciRunnerSlots[0]: must be an object'],
    });
  });

  it('matches slot name and unit patterns against the whole string', () => {
    for (const bad of ['primary\n', 'primary\r\n', '\nprimary']) {
      const r = parseInstallation(withSlots('lane-host', [{ name: bad, unit: SLOT.unit }]));
      expect(r.ok).toBe(false);
    }
    for (const bad of ['fleet-ci.service\n', 'fleet-ci.service\r\n', '\nfleet-ci.service']) {
      const r = parseInstallation(withSlots('lane-host', [{ name: SLOT.name, unit: bad }]));
      expect(r.ok).toBe(false);
    }
  });

  it('requires name and unit on each ciRunnerSlots entry', () => {
    expect(parseInstallation(withSlots('lane-host', [{ unit: SLOT.unit }]))).toEqual({
      ok: false,
      errors: ['hosts.lane-host.ciRunnerSlots[0].name: required'],
    });
    expect(parseInstallation(withSlots('lane-host', [{ name: SLOT.name }]))).toEqual({
      ok: false,
      errors: ['hosts.lane-host.ciRunnerSlots[0].unit: required'],
    });
    expect(parseInstallation(withSlots('lane-host', [{}]))).toEqual({
      ok: false,
      errors: [
        'hosts.lane-host.ciRunnerSlots[0].name: required',
        'hosts.lane-host.ciRunnerSlots[0].unit: required',
      ],
    });
  });

  it('refuses non-string or empty name and unit', () => {
    for (const value of [null, 7, true, {}, '', '   ']) {
      expect(
        parseInstallation(withSlots('lane-host', [{ name: value, unit: SLOT.unit }])),
      ).toEqual({
        ok: false,
        errors: ['hosts.lane-host.ciRunnerSlots[0].name: must be a non-empty string'],
      });
      expect(
        parseInstallation(withSlots('lane-host', [{ name: SLOT.name, unit: value }])),
      ).toEqual({
        ok: false,
        errors: ['hosts.lane-host.ciRunnerSlots[0].unit: must be a non-empty string'],
      });
    }
  });

  it('refuses an invalid slot name without echoing it', () => {
    for (const name of ['Bad', 'bad name', '-bad', '.bad', 'b'.repeat(65)]) {
      expect(
        parseInstallation(withSlots('lane-host', [{ name, unit: SLOT.unit }])),
      ).toEqual({
        ok: false,
        errors: [
          'hosts.lane-host.ciRunnerSlots[0].name: must match ^[a-z0-9][a-z0-9._-]{0,63}$',
        ],
      });
    }
  });

  it('refuses duplicate slot names within the same host and accepts them across hosts', () => {
    expect(
      parseInstallation(withSlots('lane-host', [SLOT, { ...SLOT, unit: 'fleet-ci@1.service' }])),
    ).toEqual({
      ok: false,
      errors: ['hosts.lane-host.ciRunnerSlots[1].name: duplicate slot name'],
    });
    const hosts: Record<string, unknown> = {
      ...baseHosts,
      'orchestrator-host': {
        ...baseHosts['orchestrator-host'],
        ciRunnerSlots: [SLOT],
      },
      'lane-host': { ...baseHosts['lane-host'], ciRunnerSlots: [SLOT] },
    };
    expect(parseInstallation(withHosts(hosts)).ok).toBe(true);
  });

  it('refuses an invalid unit (path, leading dash, missing .service) without echoing it', () => {
    for (const unit of ['/etc/fleet-ci.service', '-fleet-ci.service', 'fleet-ci', 'a'.repeat(129) + '.service']) {
      expect(
        parseInstallation(withSlots('lane-host', [{ name: SLOT.name, unit }])),
      ).toEqual({
        ok: false,
        errors: [
          'hosts.lane-host.ciRunnerSlots[0].unit: must be a systemd service unit name ending in .service and not starting with "-"',
        ],
      });
    }
  });

  it('refuses an unknown key on a ciRunnerSlots entry without echoing it', () => {
    expect(
      parseInstallation(
        withSlots('lane-host', [{ ...SLOT, notes: 'operator note' }]),
      ),
    ).toEqual({
      ok: false,
      errors: ['hosts.lane-host.ciRunnerSlots[0]: unknown key'],
    });
  });

  it('round-trips ciRunnerSlots through writeInstallationV2 and parseInstallation', () => {
    const hosts: Record<string, unknown> = {
      ...baseHosts,
      'lane-host': {
        ...baseHosts['lane-host'],
        ciRunnerSlots: [
          SLOT,
          { name: 'secondary', unit: 'fleet-ci@1.service' },
        ],
      },
    };
    const first = parseInstallation(withHosts(hosts));
    expect(first.ok).toBe(true);
    if (!first.ok || !isFleetInstallationV2(first.installation)) {
      throw new Error(`the fixture must parse: ${first.ok ? 'not v2' : first.errors.join('; ')}`);
    }
    const written = JSON.parse(writeInstallationV2(first.installation)) as unknown;
    expect(parseInstallation(written)).toEqual({ ok: true, installation: first.installation });
  });
});
