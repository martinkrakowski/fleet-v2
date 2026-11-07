import { describe, expect, it } from 'vitest';

import { screenFailingFile, FAILING_FILE_MAX_LENGTH } from '../failing-file.js';
import { VerificationReceipt, type VerificationReceiptProps } from '../entities/VerificationReceipt.js';

function receiptProps(overrides: Partial<VerificationReceiptProps> = {}): VerificationReceiptProps {
  return {
    id: 'verify-attempt-01M64PT1PX2MAZVQDYAYMZ7WNB-typecheck-8ec002789208',
    assessmentId: 'assessment-attempt-01M64PT1PX2MAZVQDYAYMZ7WNB',
    projectId: 'fleet-v2',
    attemptId: 'attempt-01M64PT1PX2MAZVQDYAYMZ7WNB',
    candidateHeadSha: '8ec0027892085ac2ff9a28c3107fc705f95aefcc',
    hostId: 'solstice',
    procedureName: 'typecheck',
    result: 'fail',
    exitCode: 1,
    evidenceRef: 'run-journal:run-01M63WPH4GMF2CA3NQ7JAM4HS1/r0/gate',
    policyRevision: 'policy:conductor@7844746b0277',
    completedAtIso: '2026-10-29T20:57:25.119Z',
    ...overrides,
  };
}

describe('screenFailingFile (PT1a)', () => {
  it('keeps a bounded repo-relative path', () => {
    expect(screenFailingFile('packages/work-execution/src/domain/stall-rules.test.ts')).toBe(
      'packages/work-execution/src/domain/stall-rules.test.ts',
    );
    expect(screenFailingFile('apps/cli/src/index.ts')).toBe('apps/cli/src/index.ts');
  });

  it('refuses absolute paths, parent traversal, backslashes, drive prefixes, empty and over-long values', () => {
    for (const value of [
      '/home/martin/Projects/fleet-v2/apps/cli/src/index.ts',
      '../outside/file.ts',
      'packages/../../etc/passwd',
      'a/b/../c.ts',
      'C:/work/file.ts',
      'packages\\x\\file.ts',
      '',
      'dir/',
      'a//b.ts',
      'with space.ts',
      'x'.repeat(FAILING_FILE_MAX_LENGTH + 1),
    ]) {
      expect(screenFailingFile(value)).toBeNull();
    }
    expect(screenFailingFile('x'.repeat(FAILING_FILE_MAX_LENGTH))).not.toBeNull();
  });

  it('reads a non-string as null without throwing', () => {
    for (const value of [undefined, null, 7, {}, [], true, Symbol('x')]) {
      expect(screenFailingFile(value)).toBeNull();
    }
  });
});

describe('VerificationReceipt failingFile (PT1a)', () => {
  it('records a screened failingFile and round-trips it through toRecord', () => {
    const created = VerificationReceipt.create(receiptProps({ failingFile: 'apps/cli/src/index.ts' }));
    expect(created.success).toBe(true);
    expect(created.value?.getFailingFile()).toBe('apps/cli/src/index.ts');
    expect(created.value?.toRecord().failingFile).toBe('apps/cli/src/index.ts');
  });

  it('keeps null and absent as null, and reads an old record without the field as null', () => {
    const withNull = VerificationReceipt.create(receiptProps({ failingFile: null }));
    expect(withNull.value?.getFailingFile()).toBeNull();
    const absent = VerificationReceipt.create(receiptProps());
    expect(absent.success).toBe(true);
    expect(absent.value?.getFailingFile()).toBeNull();
    expect('failingFile' in (absent.value?.toRecord() ?? {})).toBe(false);
  });

  it('refuses a receipt whose failingFile is absolute or climbs out of the repository', () => {
    for (const failingFile of ['/etc/passwd', '../x.ts', 'a/../b.ts', 'C:/x.ts']) {
      const created = VerificationReceipt.create(receiptProps({ failingFile }));
      expect(created.success).toBe(false);
      expect(created.error?.message ?? '').not.toContain(failingFile);
    }
  });
});
