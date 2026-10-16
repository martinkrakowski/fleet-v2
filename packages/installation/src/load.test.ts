import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadInstallation } from './load.js';

describe('loadInstallation hardening', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'fleet-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Part A4: OCM_REMOTE_PORT must match ^\\d+$ before Number()', () => {
    it('accepts valid decimal integer ports', () => {
      const result = loadInstallation({
        env: { OCM_REMOTE_PORT: '8080' },
        cwd: tempDir,
      });
      expect(result.status).toBe('absent');
      if (result.status === 'absent') {
        expect(result.installation.runner?.remotePort).toBe(8080);
      }
    });

    it('rejects hexadecimal representation "0x50"', () => {
      const result = loadInstallation({
        env: { OCM_REMOTE_PORT: '0x50' },
        cwd: tempDir,
      });
      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.errors).toEqual(['runner.remotePort: must be an integer 1..65535']);
      }
    });

    it('rejects scientific notation "1e3"', () => {
      const result = loadInstallation({
        env: { OCM_REMOTE_PORT: '1e3' },
        cwd: tempDir,
      });
      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.errors).toEqual(['runner.remotePort: must be an integer 1..65535']);
      }
    });

    it('rejects non-digit strings such as negative numbers or floats', () => {
      const negativeResult = loadInstallation({
        env: { OCM_REMOTE_PORT: '-8080' },
        cwd: tempDir,
      });
      expect(negativeResult.status).toBe('invalid');
      if (negativeResult.status === 'invalid') {
        expect(negativeResult.errors).toEqual(['runner.remotePort: must be an integer 1..65535']);
      }

      const floatResult = loadInstallation({
        env: { OCM_REMOTE_PORT: '80.5' },
        cwd: tempDir,
      });
      expect(floatResult.status).toBe('invalid');
      if (floatResult.status === 'invalid') {
        expect(floatResult.errors).toEqual(['runner.remotePort: must be an integer 1..65535']);
      }

      const explicitPlusResult = loadInstallation({
        env: { OCM_REMOTE_PORT: '+8080' },
        cwd: tempDir,
      });
      expect(explicitPlusResult.status).toBe('invalid');
      if (explicitPlusResult.status === 'invalid') {
        expect(explicitPlusResult.errors).toEqual(['runner.remotePort: must be an integer 1..65535']);
      }
    });

    it('rejects port 0 and ports above 65535', () => {
      const zeroResult = loadInstallation({
        env: { OCM_REMOTE_PORT: '0' },
        cwd: tempDir,
      });
      expect(zeroResult.status).toBe('invalid');

      const overflowResult = loadInstallation({
        env: { OCM_REMOTE_PORT: '65536' },
        cwd: tempDir,
      });
      expect(overflowResult.status).toBe('invalid');
    });
  });

  describe('loadInstallation with files', () => {
    it('returns absent when installation file does not exist', () => {
      const result = loadInstallation({
        file: 'non-existent.json',
        cwd: tempDir,
      });
      expect(result.status).toBe('absent');
      if (result.status === 'absent') {
        expect(result.installation.schemaVersion).toBe(1);
      }
    });

    it('returns invalid without leaking secret sentinel key when unknown key is present', () => {
      const filePath = join(tempDir, 'fleet.json');
      writeFileSync(
        filePath,
        JSON.stringify({
          schemaVersion: 1,
          TOP_SECRET_UNKNOWN_KEY: 'secret-token-12345',
        }),
      );

      const result = loadInstallation({
        file: filePath,
        cwd: tempDir,
      });

      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.file).toBe(filePath);
        expect(result.errors).toEqual(['installation: unknown key']);
        expect(result.errors[0]).not.toContain('TOP_SECRET_UNKNOWN_KEY');
      }
    });

    it('returns loaded and applies environment overrides correctly', () => {
      const filePath = join(tempDir, 'fleet.json');
      writeFileSync(
        filePath,
        JSON.stringify({
          schemaVersion: 1,
          runner: {
            agent: 'file-agent',
            model: 'file-model',
          },
        }),
      );

      const result = loadInstallation({
        file: filePath,
        env: {
          FLEET_RUNNER_MODEL: 'override-model',
          FLEET_WORKTREE_SSH_HOST: 'ssh.internal',
        },
        cwd: tempDir,
      });

      expect(result.status).toBe('loaded');
      if (result.status === 'loaded') {
        expect(result.installation.runner?.agent).toBe('file-agent');
        expect(result.installation.runner?.model).toBe('override-model');
        expect(result.installation.worktree?.sshHost).toBe('ssh.internal');
      }
    });
  });
});
