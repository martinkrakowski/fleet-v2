import { describe, expect, it } from 'vitest';

import { RunnerSelectorAdapter } from '../RunnerSelectorAdapter.adapter.js';
import type { RunnerSelectorLaneRunnerHost } from '../RunnerSelectorAdapter.adapter.js';

describe('RunnerSelectorAdapter selection by kind (AG-2)', () => {
  it('selects each seat kind from its own lane-runner host', () => {
    const hosts: Record<string, RunnerSelectorLaneRunnerHost> = {
      a: { transport: 'local', roles: ['lane-runner'], runner: { kind: 'opencode', port: 4166 } },
      b: { transport: 'local', roles: ['lane-runner'], runner: { kind: 'agy', port: 46000 } },
    };
    const selector = new RunnerSelectorAdapter({ hosts, implementedRunnerKinds: ['opencode', 'agy'] });
    expect(selector.selectRunner({ seatTool: 'opencode' })).toEqual({
      ok: true,
      kind: 'opencode',
      hostName: 'a',
      transport: 'local',
      remotePort: 4166,
    });
    expect(selector.selectRunner({ seatTool: 'agy' })).toEqual({
      ok: true,
      kind: 'agy',
      hostName: 'b',
      transport: 'local',
      remotePort: null,
    });
  });

  it('answers the same when the hosts sit in the other key order', () => {
    const hosts: Record<string, RunnerSelectorLaneRunnerHost> = {
      b: { transport: 'local', roles: ['lane-runner'], runner: { kind: 'agy', port: 46000 } },
      a: { transport: 'local', roles: ['lane-runner'], runner: { kind: 'opencode', port: 4166 } },
    };
    const selector = new RunnerSelectorAdapter({ hosts, implementedRunnerKinds: ['opencode', 'agy'] });
    expect(selector.selectRunner({ seatTool: 'opencode' })).toMatchObject({
      ok: true,
      kind: 'opencode',
      hostName: 'a',
    });
    expect(selector.selectRunner({ seatTool: 'agy' })).toMatchObject({
      ok: true,
      kind: 'agy',
      hostName: 'b',
    });
  });

  it('refuses an agy seat when only an opencode lane-runner host exists', () => {
    const hosts: Record<string, RunnerSelectorLaneRunnerHost> = {
      a: { transport: 'local', roles: ['lane-runner'], runner: { kind: 'opencode', port: 4166 } },
    };
    const selector = new RunnerSelectorAdapter({ hosts, implementedRunnerKinds: ['opencode', 'agy'] });
    expect(selector.selectRunner({ seatTool: 'agy' })).toEqual({
      ok: false,
      reason: 'runner-not-available',
    });
  });

  it('picks the first agy lane-runner host in key order', () => {
    const hosts: Record<string, RunnerSelectorLaneRunnerHost> = {
      a: { transport: 'local', roles: ['lane-runner'], runner: { kind: 'agy', port: 46000 } },
      z: { transport: 'local', roles: ['lane-runner'], runner: { kind: 'agy', port: 46001 } },
    };
    const selector = new RunnerSelectorAdapter({ hosts, implementedRunnerKinds: ['opencode', 'agy'] });
    expect(selector.selectRunner({ seatTool: 'agy' })).toMatchObject({
      ok: true,
      hostName: 'a',
      remotePort: null,
    });
  });

  it('refuses a seat tool that is neither opencode nor agy', () => {
    const hosts: Record<string, RunnerSelectorLaneRunnerHost> = {
      a: { transport: 'local', roles: ['lane-runner'], runner: { kind: 'opencode', port: 4166 } },
    };
    const selector = new RunnerSelectorAdapter({ hosts, implementedRunnerKinds: ['opencode', 'agy'] });
    expect(selector.selectRunner({ seatTool: 'grok' })).toEqual({
      ok: false,
      reason: 'runner-not-available',
    });
  });
});
