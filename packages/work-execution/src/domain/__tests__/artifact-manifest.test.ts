import { describe, expect, it } from 'vitest';

import {
  ARTIFACT_MANIFEST_SCHEMA_VERSION,
  buildArtifactManifest,
  compareArtifactManifest,
  parseArtifactManifest,
  serializeArtifactManifest,
  type ArtifactManifestEntry,
  type ObservedArtifact,
} from '../artifact-manifest.js';

/** A deterministic 64-lowercase-hex digest derived from a number. */
function hex(n: number): string {
  return n.toString(16).padStart(64, '0');
}

function entry(path: string, size: number, sha256 = hex(size)): ArtifactManifestEntry {
  return { path, size, sha256 };
}

function rawManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const files = [{ path: 'docs/a.md', size: 2, sha256: hex(1) }];
  return {
    schemaVersion: 1,
    attemptId: 'attempt-1',
    files,
    total: { files: 1, bytes: 2 },
    ...overrides,
  };
}

describe('buildArtifactManifest', () => {
  it('sorts unsorted input by path and computes totals', () => {
    const manifest = buildArtifactManifest('attempt-1', [
      entry('docs/b.md', 3),
      entry('docs/a.md', 2),
      entry('.lane/notes.md', 10),
    ]);
    expect(manifest.files.map((f) => f.path)).toEqual(['.lane/notes.md', 'docs/a.md', 'docs/b.md']);
    expect(manifest.total).toEqual({ files: 3, bytes: 15 });
    expect(manifest.schemaVersion).toBe(ARTIFACT_MANIFEST_SCHEMA_VERSION);
    expect(manifest.attemptId).toBe('attempt-1');
  });

  it('empty list gives zero totals', () => {
    const manifest = buildArtifactManifest('attempt-1', []);
    expect(manifest.files).toEqual([]);
    expect(manifest.total).toEqual({ files: 0, bytes: 0 });
  });
});

describe('serializeArtifactManifest / parseArtifactManifest', () => {
  it('round-trips to an equal manifest and ends with a newline', () => {
    const manifest = buildArtifactManifest('attempt-1', [
      entry('docs/b.md', 3),
      entry('docs/a.md', 2),
    ]);
    const text = serializeArtifactManifest(manifest);
    expect(text.endsWith('\n')).toBe(true);
    expect(parseArtifactManifest(text)).toEqual(manifest);
  });

  it.each([
    ['not JSON', 'not json'],
    ['schemaVersion 2', JSON.stringify(rawManifest({ schemaVersion: 2 }))],
    ['empty attemptId', JSON.stringify(rawManifest({ attemptId: '' }))],
    ['path ../x', JSON.stringify(rawManifest({ files: [{ path: '../x', size: 2, sha256: hex(1) }] }))],
    [
      'path /etc/passwd',
      JSON.stringify(rawManifest({ files: [{ path: '/etc/passwd', size: 2, sha256: hex(1) }] })),
    ],
    ['negative size', JSON.stringify(rawManifest({ files: [{ path: 'docs/a.md', size: -1, sha256: hex(1) }] }))],
    ['size 1.5', JSON.stringify(rawManifest({ files: [{ path: 'docs/a.md', size: 1.5, sha256: hex(1) }] }))],
    [
      'sha256 of 63 chars',
      JSON.stringify(rawManifest({ files: [{ path: 'docs/a.md', size: 2, sha256: hex(1).slice(1) }] })),
    ],
    [
      'uppercase sha256',
      JSON.stringify(rawManifest({ files: [{ path: 'docs/a.md', size: 2, sha256: 'a'.repeat(64).toUpperCase() }] })),
    ],
    [
      'duplicate path',
      JSON.stringify(
        rawManifest({
          files: [
            { path: 'docs/a.md', size: 2, sha256: hex(1) },
            { path: 'docs/a.md', size: 2, sha256: hex(1) },
          ],
          total: { files: 2, bytes: 4 },
        }),
      ),
    ],
    ['wrong total.files', JSON.stringify(rawManifest({ total: { files: 2, bytes: 2 } }))],
    ['wrong total.bytes', JSON.stringify(rawManifest({ total: { files: 1, bytes: 3 } }))],
  ])('returns null for %s', (_label: string, text: string) => {
    expect(parseArtifactManifest(text)).toBeNull();
  });
});

describe('compareArtifactManifest', () => {
  const manifest = buildArtifactManifest('attempt-1', [entry('docs/a.md', 2, hex(1))]);

  it('all equal → sealed', () => {
    const observed: ObservedArtifact[] = [{ path: 'docs/a.md', state: 'file', size: 2, sha256: hex(1) }];
    expect(compareArtifactManifest(manifest, observed)).toEqual({ outcome: 'sealed', manifest });
  });

  it('observed absent → mismatch absent', () => {
    const observed: ObservedArtifact[] = [{ path: 'docs/a.md', state: 'absent' }];
    expect(compareArtifactManifest(manifest, observed)).toEqual({
      outcome: 'mismatch',
      mismatches: [{ path: 'docs/a.md', kind: 'absent' }],
    });
  });

  it('observed missing from the list → mismatch absent', () => {
    expect(compareArtifactManifest(manifest, [])).toEqual({
      outcome: 'mismatch',
      mismatches: [{ path: 'docs/a.md', kind: 'absent' }],
    });
  });

  it('observed not-a-file → mismatch not-a-file', () => {
    const observed: ObservedArtifact[] = [{ path: 'docs/a.md', state: 'not-a-file' }];
    expect(compareArtifactManifest(manifest, observed)).toEqual({
      outcome: 'mismatch',
      mismatches: [{ path: 'docs/a.md', kind: 'not-a-file' }],
    });
  });

  it('size differs → mismatch size', () => {
    const observed: ObservedArtifact[] = [{ path: 'docs/a.md', state: 'file', size: 3, sha256: hex(1) }];
    expect(compareArtifactManifest(manifest, observed)).toEqual({
      outcome: 'mismatch',
      mismatches: [{ path: 'docs/a.md', kind: 'size' }],
    });
  });

  it('same size, different digest → mismatch sha256', () => {
    const observed: ObservedArtifact[] = [{ path: 'docs/a.md', state: 'file', size: 2, sha256: hex(2) }];
    expect(compareArtifactManifest(manifest, observed)).toEqual({
      outcome: 'mismatch',
      mismatches: [{ path: 'docs/a.md', kind: 'sha256' }],
    });
  });

  it('two mismatches are reported in manifest order', () => {
    const two = buildArtifactManifest('attempt-1', [
      entry('docs/b.md', 3, hex(2)),
      entry('docs/a.md', 2, hex(1)),
    ]);
    const observed: ObservedArtifact[] = [
      { path: 'docs/a.md', state: 'file', size: 99, sha256: hex(1) },
      { path: 'docs/b.md', state: 'file', size: 3, sha256: hex(9) },
    ];
    expect(compareArtifactManifest(two, observed)).toEqual({
      outcome: 'mismatch',
      mismatches: [
        { path: 'docs/a.md', kind: 'size' },
        { path: 'docs/b.md', kind: 'sha256' },
      ],
    });
  });
});
