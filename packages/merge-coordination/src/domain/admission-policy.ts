/**
 * Admission policy: how a pull request's changed paths decide the strictness
 * class it may be batched under, and the per-class batch size cap.
 *
 * File compatibility is a scheduling heuristic, never proof: two PRs with
 * disjoint paths may still conflict at runtime, and a shared path does not
 * mean the PRs cannot land together. This module only ranks and caps; the
 * validation gate decides what actually lands.
 */

import { accepted, isPositiveInteger, refused, type ValidationResult } from './entities/validation.js';

/** How strict a changed path set is. The earlier in ADMISSION_CLASS_ORDER, the stricter. */
export type AdmissionClass = 'alone' | 'migration' | 'dependency' | 'normal';

/** Strictness order: `alone` is strictest, `normal` is free. */
export const ADMISSION_CLASS_ORDER: readonly AdmissionClass[] = ['alone', 'migration', 'dependency', 'normal'];

/**
 * Normalize a changed path for comparison: backslashes become slashes,
 * leading `./` and `/` are stripped repeatedly, the result is lower-cased,
 * and repeated slashes collapse to one.
 */
export function normalizeChangedPath(path: string): string {
  let out = path.split('\\').join('/');
  for (;;) {
    if (out.startsWith('./')) {
      out = out.slice(2);
    } else if (out.startsWith('/')) {
      out = out.slice(1);
    } else {
      break;
    }
  }
  out = out.toLowerCase();
  let previous: string;
  do {
    previous = out;
    out = out.split('//').join('/');
  } while (out !== previous);
  return out;
}

const ALONE_DIR_PREFIXES: readonly string[] = ['.github/', '.gitlab/', '.circleci/'];

const MIGRATION_SEGMENTS: readonly string[] = ['migrations', 'migration', 'migrate'];

const DEPENDENCY_BASENAMES: ReadonlySet<string> = new Set([
  'package.json',
  'yarn.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'npm-shrinkwrap.json',
  '.yarnrc.yml',
  'go.mod',
  'go.sum',
  'cargo.toml',
  'cargo.lock',
  'requirements.txt',
  'poetry.lock',
  'gemfile.lock',
  'composer.lock',
]);

function basenameOf(normalized: string): string {
  const segments = normalized.split('/');
  return segments[segments.length - 1] ?? normalized;
}

function isAlonePath(normalized: string): boolean {
  if (normalized === '.gitlab-ci.yml') {
    return true;
  }
  for (const prefix of ALONE_DIR_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      return true;
    }
  }
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment.includes('branch-protection')) {
      return true;
    }
  }
  if (segments[0] === '.buildkite' || segments[0] === '.circleci' || basenameOf(normalized) === 'Jenkinsfile') {
    return true;
  }
  if (segments.includes('security')) {
    return true;
  }
  const base = basenameOf(normalized);
  if (base.startsWith('security') || base.startsWith('release') || base.startsWith('.releaserc')) {
    return true;
  }
  for (const segment of segments) {
    if (segment === 'release' || segment === 'releases' || segment === 'release-infra') {
      return true;
    }
  }
  return false;
}

/**
 * Classify one changed path. The first matching rule wins; unmatched paths
 * are `normal`. This is a heuristic over file names, never proof of
 * compatibility.
 */
export function classifyChangedPath(path: string): AdmissionClass {
  const normalized = normalizeChangedPath(path);
  if (isAlonePath(normalized)) {
    return 'alone';
  }
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (MIGRATION_SEGMENTS.includes(segment)) {
      return 'migration';
    }
  }
  if (DEPENDENCY_BASENAMES.has(basenameOf(normalized))) {
    return 'dependency';
  }
  return 'normal';
}

function classRank(cls: AdmissionClass): number {
  const index = ADMISSION_CLASS_ORDER.indexOf(cls);
  return index === -1 ? ADMISSION_CLASS_ORDER.length : index;
}

/**
 * Classify a whole change. An empty list is `alone`: unknown paths are never
 * batched. Otherwise the strictest class wins.
 */
export function classifyChange(changedPaths: readonly string[]): AdmissionClass {
  let strictest: AdmissionClass = 'alone';
  let rank = ADMISSION_CLASS_ORDER.length;
  for (const path of changedPaths) {
    const cls = classifyChangedPath(path);
    const clsRank = classRank(cls);
    if (clsRank < rank) {
      strictest = cls;
      rank = clsRank;
    }
  }
  return strictest;
}

/** The largest batch an admission class may join. */
export function admissionClassCap(cls: AdmissionClass, maxBatchSize: number): number {
  if (cls === 'alone') {
    return 1;
  }
  if (cls === 'migration' || cls === 'dependency') {
    return Math.min(2, maxBatchSize);
  }
  return maxBatchSize;
}

/**
 * Whether any normalized path appears in both lists. Exact path equality
 * only: there is no directory logic, so this is a weak overlap signal, a
 * heuristic rather than proof of a real conflict.
 */
export function changesOverlap(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a.map(normalizeChangedPath));
  for (const path of b) {
    if (left.has(normalizeChangedPath(path))) {
      return true;
    }
  }
  return false;
}

/** The scheduling knobs of batch formation. */
export interface BatchPolicy {
  readonly maxBatchSize: number;
  readonly minBatchSize: number;
  readonly collectionWaitMs: number;
  readonly speculativeDepth: number;
}

/** The default policy the station starts from. */
export const DEFAULT_BATCH_POLICY: Readonly<BatchPolicy> = Object.freeze({
  maxBatchSize: 4,
  minBatchSize: 2,
  collectionWaitMs: 90_000,
  speculativeDepth: 2,
});

/**
 * Validate unknown input as a BatchPolicy. Refusals carry a reason and
 * nothing ever throws. On success the value is a fresh object with only the
 * four fields.
 */
export function validateBatchPolicy(value: unknown): ValidationResult<BatchPolicy> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return refused('batch policy must be an object');
  }
  const record = value as Record<string, unknown>;
  if (!isPositiveInteger(record.maxBatchSize)) {
    return refused('batch policy maxBatchSize must be a positive integer');
  }
  if (!isPositiveInteger(record.minBatchSize)) {
    return refused('batch policy minBatchSize must be a positive integer');
  }
  const wait = record.collectionWaitMs;
  if (typeof wait !== 'number' || !Number.isInteger(wait) || wait < 0) {
    return refused('batch policy collectionWaitMs must be a non-negative integer');
  }
  if (!isPositiveInteger(record.speculativeDepth)) {
    return refused('batch policy speculativeDepth must be a positive integer');
  }
  if (record.minBatchSize > record.maxBatchSize) {
    return refused('batch policy minBatchSize must not exceed maxBatchSize');
  }
  return accepted({
    maxBatchSize: record.maxBatchSize,
    minBatchSize: record.minBatchSize,
    collectionWaitMs: wait,
    speculativeDepth: record.speculativeDepth,
  });
}
