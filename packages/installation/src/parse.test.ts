import { describe, expect, it } from 'vitest';

import { parseInstallation } from './parse.js';

describe('parseInstallation hardening', () => {
  describe('Part A1: error text never includes key name or procedure name', () => {
    it('reports "<parent path>: unknown key" for root level unknown keys without leaking key name', () => {
      const result = parseInstallation({
        schemaVersion: 1,
        SENTINEL_SECRET_KEY: 'sensitive-value',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toEqual(['installation: unknown key']);
        expect(result.errors[0]).not.toContain('SENTINEL_SECRET_KEY');
      }
    });

    it('reports "<parent path>: unknown key" for nested sections without leaking key name', () => {
      const result = parseInstallation({
        schemaVersion: 1,
        runner: {
          agent: 'codex',
          model: 'gpt-4',
          RUNNER_SECRET: 'val',
        },
        worktree: {
          sshHost: 'host.internal',
          WORKTREE_SECRET: 'val',
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toEqual([
          'runner: unknown key',
          'worktree: unknown key',
        ]);
        expect(JSON.stringify(result.errors)).not.toContain('RUNNER_SECRET');
        expect(JSON.stringify(result.errors)).not.toContain('WORKTREE_SECRET');
      }
    });

    it('reports "<parent path>: unknown key" inside fallbackChain seats without leaking key name', () => {
      const result = parseInstallation({
        schemaVersion: 1,
        runner: {
          agent: 'codex',
          model: 'gpt-4',
          fallbackChain: [
            {
              agent: 'backup',
              model: 'gpt-3.5',
              SEAT_SECRET: 'val',
            },
          ],
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toEqual(['runner.fallbackChain[0]: unknown key']);
        expect(result.errors[0]).not.toContain('SEAT_SECRET');
      }
    });

    it('reports "<parent path>: unknown key" inside a verification procedure without leaking key name', () => {
      const result = parseInstallation({
        schemaVersion: 1,
        verification: {
          procedures: {
            check: {
              command: 'npm test',
              PROC_KEY_SECRET: 'val',
            },
          },
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toEqual([
          'verification.procedures.check: unknown key',
        ]);
        expect(result.errors[0]).not.toContain('PROC_KEY_SECRET');
      }
    });

    it('reports "verification.procedures: invalid procedure name" for bad procedure names without leaking procedure name', () => {
      const result = parseInstallation({
        schemaVersion: 1,
        verification: {
          procedures: {
            BAD_PROC_NAME_WITH_SENTINEL: {
              command: 'npm test',
            },
          },
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toEqual([
          'verification.procedures: invalid procedure name',
        ]);
        expect(result.errors[0]).not.toContain('BAD_PROC_NAME_WITH_SENTINEL');
      }
    });
  });

  describe('Part A2: ownerPublicKey canonical base64 check', () => {
    it('accepts canonical 32-byte base64 string', () => {
      const validKey = Buffer.alloc(32, 1).toString('base64');
      const result = parseInstallation({
        schemaVersion: 1,
        waves: {
          baseUrl: 'https://waves.internal',
          tokenFile: '/etc/waves/token',
          ownerPublicKey: validKey,
        },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.installation.waves?.ownerPublicKey).toBe(validKey);
      }
    });

    it('rejects non-canonical base64 with non-zero unused padding bits', () => {
      // 32 zero bytes canonical base64 ends in 'A='
      // In base64, 'A' has unused bits 00. 'B' has unused bits 01 (non-canonical).
      const canonical32 = Buffer.alloc(32, 0).toString('base64');
      expect(canonical32).toBe('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
      const nonCanonical = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB=';
      // Buffer.from decodes both to 32 zero bytes:
      expect(Buffer.from(nonCanonical, 'base64').length).toBe(32);
      // But re-encoding does not match nonCanonical:
      expect(Buffer.from(nonCanonical, 'base64').toString('base64')).not.toBe(
        nonCanonical,
      );

      const result = parseInstallation({
        schemaVersion: 1,
        waves: {
          baseUrl: 'https://waves.internal',
          tokenFile: '/etc/waves/token',
          ownerPublicKey: nonCanonical,
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toEqual([
          'waves.ownerPublicKey: must be base64 of exactly 32 bytes',
        ]);
      }
    });

    it('rejects base64 decoding to length other than 32 bytes', () => {
      const key16 = Buffer.alloc(16, 1).toString('base64');
      const key33 = Buffer.alloc(33, 1).toString('base64');

      const result16 = parseInstallation({
        schemaVersion: 1,
        waves: {
          baseUrl: 'https://waves.internal',
          tokenFile: '/etc/waves/token',
          ownerPublicKey: key16,
        },
      });
      expect(result16.ok).toBe(false);
      if (!result16.ok) {
        expect(result16.errors).toEqual([
          'waves.ownerPublicKey: must be base64 of exactly 32 bytes',
        ]);
      }

      const result33 = parseInstallation({
        schemaVersion: 1,
        waves: {
          baseUrl: 'https://waves.internal',
          tokenFile: '/etc/waves/token',
          ownerPublicKey: key33,
        },
      });
      expect(result33.ok).toBe(false);
      if (!result33.ok) {
        expect(result33.errors).toEqual([
          'waves.ownerPublicKey: must be base64 of exactly 32 bytes',
        ]);
      }
    });

    it('rejects base64 with surrounding whitespace', () => {
      const validKey = Buffer.alloc(32, 1).toString('base64');
      const result = parseInstallation({
        schemaVersion: 1,
        waves: {
          baseUrl: 'https://waves.internal',
          tokenFile: '/etc/waves/token',
          ownerPublicKey: `  ${validKey}  `,
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toEqual([
          'waves.ownerPublicKey: must be base64 of exactly 32 bytes',
        ]);
      }
    });
  });

  describe('Part A3: procedures built with Object.create(null) and forbidden names rejected', () => {
    it('creates procedures with null prototype', () => {
      const result = parseInstallation({
        schemaVersion: 1,
        verification: {
          procedures: {
            check: { command: 'npm test' },
          },
        },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.installation.verification?.procedures).toBeDefined();
        expect(
          Object.getPrototypeOf(result.installation.verification!.procedures),
        ).toBeNull();
      }
    });

    it('rejects forbidden procedure name "constructor"', () => {
      const result = parseInstallation({
        schemaVersion: 1,
        verification: {
          procedures: {
            constructor: { command: 'echo 1' },
          },
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toEqual([
          'verification.procedures: invalid procedure name',
        ]);
      }
    });

    it('rejects forbidden procedure name "prototype"', () => {
      const result = parseInstallation({
        schemaVersion: 1,
        verification: {
          procedures: {
            prototype: { command: 'echo 1' },
          },
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toEqual([
          'verification.procedures: invalid procedure name',
        ]);
      }
    });

    it('rejects forbidden procedure name "__proto__"', () => {
      const parsed = JSON.parse(
        '{"schemaVersion":1,"verification":{"procedures":{"__proto__":{"command":"echo 1"}}}}',
      ) as unknown;
      const result = parseInstallation(parsed);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toEqual([
          'verification.procedures: invalid procedure name',
        ]);
      }
    });

    it('rejects forbidden procedure name "hasownproperty"', () => {
      const result = parseInstallation({
        schemaVersion: 1,
        verification: {
          procedures: {
            hasownproperty: { command: 'echo 1' },
          },
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toEqual([
          'verification.procedures: invalid procedure name',
        ]);
      }
    });
  });

  describe('Part A5: baseUrl with username or password is invalid', () => {
    it('rejects waves baseUrl with username and password', () => {
      const result = parseInstallation({
        schemaVersion: 1,
        waves: {
          baseUrl: 'https://user:secret@waves.internal',
          tokenFile: '/etc/waves/token',
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toEqual(['waves.baseUrl: must be an https URL']);
      }
    });

    it('rejects waves baseUrl with username only', () => {
      const result = parseInstallation({
        schemaVersion: 1,
        waves: {
          baseUrl: 'https://operator@waves.internal',
          tokenFile: '/etc/waves/token',
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toEqual(['waves.baseUrl: must be an https URL']);
      }
    });

    it('rejects waves baseUrl with password only', () => {
      const result = parseInstallation({
        schemaVersion: 1,
        waves: {
          baseUrl: 'https://:secret@waves.internal',
          tokenFile: '/etc/waves/token',
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toEqual(['waves.baseUrl: must be an https URL']);
      }
    });

    it('rejects shelf baseUrl with username or password', () => {
      const result = parseInstallation({
        schemaVersion: 1,
        shelf: {
          baseUrl: 'https://admin:pass@shelf.internal',
          keyFile: '/etc/shelf/key',
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toEqual(['shelf.baseUrl: must be an https URL']);
      }
    });

    it('accepts clean https baseUrl without credentials', () => {
      const result = parseInstallation({
        schemaVersion: 1,
        waves: {
          baseUrl: 'https://waves.internal:8443/v1',
          tokenFile: '/etc/waves/token',
        },
        shelf: {
          baseUrl: 'https://shelf.internal/api',
          keyFile: '/etc/shelf/key',
        },
      });
      expect(result.ok).toBe(true);
    });
  });
});

describe('parseInstallation host sshAlias safety', () => {
  const baseFile = {
    schemaVersion: 2,
    forge: { mode: 'none' },
    hosts: {
      here: {
        transport: 'local',
        worktreeRoot: '/home/dev/fleet-v2',
        roles: ['orchestrator', 'lane-runner'],
        runner: { kind: 'opencode', port: 46000 },
      },
    },
  };

  function fileWith(sshAlias: string) {
    return {
      ...baseFile,
      hosts: {
        ...baseFile.hosts,
        midnight: {
          transport: 'ssh',
          sshAlias,
          worktreeRoot: '/srv/fleet-v2/worktrees',
          roles: ['verifier'],
        },
      },
    };
  }

  it('refuses an alias that could be read as an ssh option', () => {
    const result = parseInstallation(fileWith('-oProxyCommand=x'));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors).toEqual([
      'hosts.midnight.sshAlias: must match ^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+$ and must not start with "-", so it can never be read as an ssh option',
    ]);
    expect(JSON.stringify(result.errors)).not.toContain('-oProxyCommand');
  });

  it('refuses an alias that is an option at the destination position (-J)', () => {
    const result = parseInstallation(fileWith('-J'));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors).toEqual([
      'hosts.midnight.sshAlias: must match ^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+$ and must not start with "-", so it can never be read as an ssh option',
    ]);
  });

  it('accepts a valid alias, a user@alias and a dotted host', () => {
    for (const sshAlias of ['midnight', 'deployer@midnight', 'midnight.lan']) {
      const result = parseInstallation(fileWith(sshAlias));
      expect(result.ok).toBe(true);
    }
  });
});
