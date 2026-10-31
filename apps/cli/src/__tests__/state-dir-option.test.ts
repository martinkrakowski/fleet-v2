/**
 * Unit tests for `extractStateDirOption`: precedence over the environment
 * fallback, position independence, the inline `=` form, repeated flags,
 * relative-path resolution, blank environment handling and look-alike tokens.
 */

import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { extractStateDirOption } from '../index.js';

describe('extractStateDirOption', () => {
  it('prefers the flag over the environment value', () => {
    const { stateDir, restArgv } = extractStateDirOption(
      ['--state-dir', '/a', 'work-order', 'stale'],
      '/env',
    );
    expect(stateDir).toBe(resolve('/a'));
    expect(restArgv).toEqual(['work-order', 'stale']);
  });

  it('accepts the flag in any position, preserving token order', () => {
    for (const argv of [
      ['--state-dir', '/a', 'work-order', 'stale'],
      ['work-order', '--state-dir', '/a', 'stale'],
      ['work-order', 'stale', '--state-dir', '/a'],
    ]) {
      const { stateDir, restArgv } = extractStateDirOption(argv, '/env');
      expect(stateDir).toBe(resolve('/a'));
      expect(restArgv).toEqual(['work-order', 'stale']);
    }
  });

  it('treats the inline form the same as the two-token form', () => {
    const { stateDir, restArgv } = extractStateDirOption(
      ['work-order', '--state-dir=/a', 'stale'],
      '/env',
    );
    expect(stateDir).toBe(resolve('/a'));
    expect(restArgv).toEqual(['work-order', 'stale']);
  });

  it('lets the last occurrence win when the flag is given twice', () => {
    const { stateDir, restArgv } = extractStateDirOption(
      ['--state-dir', '/first', 'work-order', '--state-dir=/second'],
    );
    expect(stateDir).toBe(resolve('/second'));
    expect(restArgv).toEqual(['work-order']);
  });

  it('resolves a relative value against the current directory', () => {
    const { stateDir, restArgv } = extractStateDirOption([
      '--state-dir',
      'rel',
      'work-order',
    ]);
    expect(stateDir).toBe(resolve('rel'));
    expect(restArgv).toEqual(['work-order']);
  });

  it('falls back to a trimmed environment value when no flag is given', () => {
    const { stateDir, restArgv } = extractStateDirOption(
      ['work-order'],
      '  /env/value  ',
    );
    expect(stateDir).toBe(resolve('/env/value'));
    expect(restArgv).toEqual(['work-order']);
  });

  it('gives no stateDir for a blank or absent environment value', () => {
    for (const envStateDir of ['   ', '', undefined]) {
      const { stateDir, restArgv } = extractStateDirOption(
        ['work-order'],
        envStateDir,
      );
      expect(stateDir).toBeUndefined();
      expect(restArgv).toEqual(['work-order']);
    }
  });

  it('leaves look-alike tokens alone', () => {
    const { stateDir, restArgv } = extractStateDirOption(
      ['work-order', '--state-directory', 'x', 'state-dir', 'y'],
      '/env',
    );
    expect(stateDir).toBe(resolve('/env'));
    expect(restArgv).toEqual([
      'work-order',
      '--state-directory',
      'x',
      'state-dir',
      'y',
    ]);
  });
});
