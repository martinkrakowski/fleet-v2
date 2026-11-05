/**
 * The host descriptor reader behind `hosts add --from-descriptor` (lane H13):
 * the allow-list — port, worktree root, tool and capabilities — and every
 * refusal, which names the field path, never the field's value. The engine
 * is pure: these tests need no filesystem or subprocess.
 */

import { describe, expect, it } from 'vitest';

import { parseHostDescriptor } from '../descriptor.js';

const validDescriptor = {
  port: 4166,
  worktreeRoot: '/srv/fleet-v2/worktrees',
  tools: [{ name: 'opencode', version: '1.2.3' }],
  capabilities: {
    networkEgressRestricted: true,
    cpuAndMemoryLimited: true,
    processTreeTermination: true,
    filesystemScope: 'scoped-worktree',
  },
};

describe('parseHostDescriptor', () => {
  it('accepts the allow-listed shape and returns the values', () => {
    const result = parseHostDescriptor(validDescriptor);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.descriptor.port).toBe(4166);
    expect(result.descriptor.worktreeRoot).toBe('/srv/fleet-v2/worktrees');
    expect(result.descriptor.tools).toEqual([
      { name: 'opencode', version: '1.2.3' },
    ]);
    expect(result.descriptor.capabilities).toEqual({
      networkEgressRestricted: true,
      cpuAndMemoryLimited: true,
      processTreeTermination: true,
      filesystemScope: 'scoped-worktree',
    });
  });

  it('accepts a descriptor without capabilities', () => {
    const { port, worktreeRoot, tools } = validDescriptor;
    const result = parseHostDescriptor({ port, worktreeRoot, tools });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.descriptor.capabilities).toBeUndefined();
  });

  it('refuses an unknown top-level key', () => {
    const result = parseHostDescriptor({ ...validDescriptor, os: 'linux' });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors).toContain('descriptor: unknown key');
  });

  it('refuses capabilities.source with the message naming source', () => {
    const result = parseHostDescriptor({
      ...validDescriptor,
      capabilities: {
        ...validDescriptor.capabilities,
        source: 'declared',
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors).toContain(
      'descriptor.capabilities.source: is derived by the loader and is never read from a descriptor',
    );
  });

  it('refuses an unknown capability key and a missing capability field', () => {
    const unknownKey = parseHostDescriptor({
      ...validDescriptor,
      capabilities: {
        ...validDescriptor.capabilities,
        group: 'wheel',
      },
    });
    expect(unknownKey.ok).toBe(false);
    if (unknownKey.ok) {
      return;
    }
    expect(unknownKey.errors).toContain('descriptor.capabilities: unknown key');

    const missingField = parseHostDescriptor({
      ...validDescriptor,
      capabilities: {
        networkEgressRestricted: true,
        cpuAndMemoryLimited: true,
        processTreeTermination: true,
      },
    });
    expect(missingField.ok).toBe(false);
    if (missingField.ok) {
      return;
    }
    expect(missingField.errors).toContain(
      'descriptor.capabilities.filesystemScope: required',
    );
  });

  it('refuses a port outside 1..65535 and a non-integer port', () => {
    const tooHigh = parseHostDescriptor({ ...validDescriptor, port: 65536 });
    expect(tooHigh.ok).toBe(false);
    if (tooHigh.ok) {
      return;
    }
    expect(tooHigh.errors).toContain(
      'descriptor.port: must be an integer 1..65535',
    );

    const nonInteger = parseHostDescriptor({
      ...validDescriptor,
      port: 4166.5,
    });
    expect(nonInteger.ok).toBe(false);
    if (nonInteger.ok) {
      return;
    }
    expect(nonInteger.errors).toContain(
      'descriptor.port: must be an integer 1..65535',
    );
  });

  it('refuses a relative worktree root', () => {
    const result = parseHostDescriptor({
      ...validDescriptor,
      worktreeRoot: 'relative/path',
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors).toContain(
      'descriptor.worktreeRoot: must be an absolute path',
    );
  });

  it('refuses a tool name that is not a runner kind, and agy with its reason', () => {
    const unknown = parseHostDescriptor({
      ...validDescriptor,
      tools: [{ name: 'nano', version: '7.0' }],
    });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) {
      return;
    }
    expect(unknown.errors).toContain(
      'descriptor.tools[0].name: must be a known runner kind (opencode)',
    );

    const agy = parseHostDescriptor({
      ...validDescriptor,
      tools: [{ name: 'agy', version: '0.3.0' }],
    });
    expect(agy.ok).toBe(false);
    if (agy.ok) {
      return;
    }
    expect(agy.errors).toContain(
      'descriptor.tools[0].name: an agy runner declares its mode and the security acknowledgement, which no descriptor carries; add that host without --from-descriptor',
    );
  });

  it('refuses two different tool names', () => {
    const result = parseHostDescriptor({
      ...validDescriptor,
      tools: [
        { name: 'opencode', version: '1.2.3' },
        { name: 'agy', version: '0.3.0' },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors).toContain('descriptor.tools: names more than one tool');
  });

  it('refuses the same tool named twice', () => {
    const result = parseHostDescriptor({
      ...validDescriptor,
      tools: [
        { name: 'opencode', version: '1.2.3' },
        { name: 'opencode', version: '9.9.9' },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors).toContain(
      'descriptor.tools[1].name: names the same tool twice',
    );
  });

  it('still accepts a single tool entry', () => {
    const result = parseHostDescriptor({
      ...validDescriptor,
      tools: [{ name: 'opencode', version: '1.2.3' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.descriptor.tools).toEqual([
      { name: 'opencode', version: '1.2.3' },
    ]);
  });

  it('refuses a descriptor that is not an object and a tool entry with an unknown key', () => {
    const notObject = parseHostDescriptor('opencode');
    expect(notObject.ok).toBe(false);
    if (notObject.ok) {
      return;
    }
    expect(notObject.errors).toContain('descriptor: must be an object');

    const unknownToolKey = parseHostDescriptor({
      ...validDescriptor,
      tools: [{ name: 'opencode', version: '1.2.3', channel: 'stable' }],
    });
    expect(unknownToolKey.ok).toBe(false);
    if (unknownToolKey.ok) {
      return;
    }
    expect(unknownToolKey.errors).toContain(
      'descriptor.tools[0]: unknown key',
    );
  });
});
