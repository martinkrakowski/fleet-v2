import { describe, expect, it } from 'vitest';

import { parseInstallation } from '../parse.js';

const THIRTY_TWO_BYTE_KEY = Buffer.alloc(32, 1).toString('base64');

const fullInstallation = {
  schemaVersion: 1,
  runner: {
    agent: 'runner-agent',
    model: 'runner-model',
    variant: 'runner-variant',
    remotePort: 46000,
    host: 'lane-host.example',
    ocmRunBin: '/home/operator/.config/fleet/ocm-run',
    fallbackChain: [{ agent: 'fallback-agent', model: 'fallback-model' }],
  },
  worktree: { sshHost: 'lane-host.example' },
  verification: {
    sshHost: 'verify-host.example',
    procedures: {
      'unit-gate': { command: 'yarn', args: ['test'] },
      lint: { command: 'yarn', args: ['lint'] },
    },
  },
  forge: { owner: 'example-owner', repo: 'example-repo' },
  reviewer: { agent: 'reviewer-agent', model: 'reviewer-model', variant: 'reviewer-variant' },
  waves: {
    baseUrl: 'https://waves.example',
    tokenFile: '/home/operator/.config/fleet/waves-token',
    caFile: '/home/operator/.config/fleet/waves-ca.pem',
    ownerPublicKey: THIRTY_TWO_BYTE_KEY,
  },
  shelf: {
    baseUrl: 'https://shelf.example',
    keyFile: '/home/operator/.config/fleet/shelf-key',
  },
};

describe('parseInstallation', () => {
  it('accepts a valid full installation', () => {
    const result = parseInstallation(fullInstallation);
    expect(result).toEqual({ ok: true, installation: fullInstallation });
  });

  it('accepts a minimal installation with only the schema version', () => {
    const result = parseInstallation({ schemaVersion: 1 });
    expect(result).toEqual({ ok: true, installation: { schemaVersion: 1 } });
  });

  it('rejects a value that is not an object', () => {
    for (const value of ['nope', 42, null, [1], []]) {
      const result = parseInstallation(value);
      expect(result).toEqual({ ok: false, errors: ['installation: must be an object'] });
    }
  });

  it('requires schemaVersion', () => {
    const result = parseInstallation({ runner: { agent: 'a', model: 'm' } });
    expect(result).toEqual({ ok: false, errors: ['schemaVersion: required'] });
  });

  it('requires schemaVersion to be 1', () => {
    for (const version of [2, 0, 1.5, '1', null]) {
      const result = parseInstallation({ schemaVersion: version });
      expect(result).toEqual({ ok: false, errors: ['schemaVersion: must be 1'] });
    }
  });

  it('rejects an unknown top-level key', () => {
    const result = parseInstallation({ schemaVersion: 1, oops: true });
    expect(result).toEqual({ ok: false, errors: ['oops: unknown key'] });
  });

  it('rejects an unknown nested key inside waves', () => {
    const result = parseInstallation({
      schemaVersion: 1,
      waves: {
        baseUrl: 'https://waves.example',
        tokenFile: '/home/operator/.config/fleet/waves-token',
        token: 'never-echo',
      },
    });
    expect(result).toEqual({ ok: false, errors: ['waves.token: unknown key'] });
  });

  it('rejects a section that is not an object', () => {
    const result = parseInstallation({ schemaVersion: 1, runner: 'nope' });
    expect(result).toEqual({ ok: false, errors: ['runner: must be an object'] });
  });

  it('requires agent and model when the file has a runner section', () => {
    const result = parseInstallation({ schemaVersion: 1, runner: {} });
    expect(result).toEqual({
      ok: false,
      errors: ['runner.agent: required', 'runner.model: required'],
    });
  });

  it('rejects a string that is empty after trim', () => {
    const result = parseInstallation({ schemaVersion: 1, runner: { agent: '   ', model: 'm' } });
    expect(result).toEqual({
      ok: false,
      errors: ['runner.agent: must be a non-empty string'],
    });
  });

  it('rejects a remotePort outside 1..65535', () => {
    for (const remotePort of [70000, 0, -1, 8080.5, '8080', null]) {
      const result = parseInstallation({
        schemaVersion: 1,
        runner: { agent: 'a', model: 'm', remotePort },
      });
      expect(result).toEqual({
        ok: false,
        errors: ['runner.remotePort: must be an integer 1..65535'],
      });
    }
  });

  it('rejects a fallbackChain that is not an array', () => {
    const result = parseInstallation({
      schemaVersion: 1,
      runner: { agent: 'a', model: 'm', fallbackChain: 'nope' },
    });
    expect(result).toEqual({ ok: false, errors: ['runner.fallbackChain: must be an array'] });
  });

  it('collects all errors across fallback seats', () => {
    const result = parseInstallation({
      schemaVersion: 1,
      runner: {
        agent: 'a',
        model: 'm',
        fallbackChain: [{ model: 'm' }, 'nope', { agent: 'a' }],
      },
    });
    expect(result).toEqual({
      ok: false,
      errors: [
        'runner.fallbackChain[0].agent: required',
        'runner.fallbackChain[1]: must be an object',
        'runner.fallbackChain[2].model: required',
      ],
    });
  });

  it('requires worktree.sshHost when the section is present', () => {
    const result = parseInstallation({ schemaVersion: 1, worktree: {} });
    expect(result).toEqual({ ok: false, errors: ['worktree.sshHost: required'] });
  });

  it('requires verification.procedures when the section is present', () => {
    const result = parseInstallation({ schemaVersion: 1, verification: {} });
    expect(result).toEqual({
      ok: false,
      errors: ['verification.procedures: required'],
    });
  });

  it('rejects a procedure name outside the allowed pattern', () => {
    const result = parseInstallation({
      schemaVersion: 1,
      verification: { procedures: { 'Bad_Name': { command: 'yarn' } } },
    });
    expect(result).toEqual({
      ok: false,
      errors: [
        'verification.procedures.Bad_Name: procedure name must match ^[a-z0-9][a-z0-9-]*$',
      ],
    });
  });

  it('rejects procedure args that are not an array of non-empty strings', () => {
    const result = parseInstallation({
      schemaVersion: 1,
      verification: {
        procedures: {
          gate: { command: 'yarn', args: 'nope' },
          lint: { command: 'yarn', args: ['ok', '   '] },
        },
      },
    });
    expect(result).toEqual({
      ok: false,
      errors: [
        'verification.procedures.gate.args: must be an array',
        'verification.procedures.lint.args[1]: must be a non-empty string',
      ],
    });
  });

  it('rejects an ownerPublicKey that is not base64 of exactly 32 bytes', () => {
    const thirtyOneBytes = Buffer.alloc(31, 1).toString('base64');
    for (const ownerPublicKey of [thirtyOneBytes, 'not base64!', '', 'AAAA']) {
      const result = parseInstallation({
        schemaVersion: 1,
        waves: {
          baseUrl: 'https://waves.example',
          tokenFile: '/home/operator/.config/fleet/waves-token',
          ownerPublicKey,
        },
      });
      expect(result).toEqual({
        ok: false,
        errors: ['waves.ownerPublicKey: must be base64 of exactly 32 bytes'],
      });
    }
  });

  it('collects every error across sections', () => {
    const result = parseInstallation({
      schemaVersion: 2,
      runner: { agent: '  ', model: 'm' },
      waves: { baseUrl: 'http://waves.example', tokenFile: 'relative/token' },
      shelf: { baseUrl: 'https://shelf.example' },
    });
    expect(result).toEqual({
      ok: false,
      errors: [
        'schemaVersion: must be 1',
        'runner.agent: must be a non-empty string',
        'waves.baseUrl: must be an https URL',
        'waves.tokenFile: must be an absolute path',
        'shelf.keyFile: required',
      ],
    });
  });

  it('never echoes an offending value in an error', () => {
    const sentinel = 'SENTINEL-never-echo-me';
    const result = parseInstallation({
      schemaVersion: 1,
      runner: { agent: 'a', model: 'm', remotePort: 0, host: sentinel },
      waves: {
        baseUrl: `http://${sentinel}.example`,
        tokenFile: sentinel,
        ownerPublicKey: sentinel,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        'runner.remotePort: must be an integer 1..65535',
        'waves.baseUrl: must be an https URL',
        'waves.tokenFile: must be an absolute path',
        'waves.ownerPublicKey: must be base64 of exactly 32 bytes',
      ]);
      for (const error of result.errors) {
        expect(error.includes(sentinel)).toBe(false);
      }
    }
  });
});
