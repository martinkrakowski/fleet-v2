/**
 * FC2A: pure import-boundary scanner for hosted, organisation-aware packages.
 *
 * No core package (`packages/*`) or self-host app (`apps/cli`, `apps/mcp`,
 * `apps/web`) may import or depend on `@fleet/tenancy`, `@fleet/billing` or any
 * `@fleet/cloud-[a-z0-9-]+` package. `apps/api` is explicitly exempt because a
 * hosted composition root will live there later.
 *
 * Cost bound: the scan reads each `package.json` once and each `.ts`/`.tsx`
 * source file once, bounded by O(F) over the file count F of the scanned tree;
 * it skips `node_modules`, `dist`, `.next`, `.output` and `.turbo`. Module
 * specifiers are collected with the TypeScript compiler API, so comments and
 * template literals need no stripping: only real module specifiers (including
 * cooked values such as `\x40fleet/billing` resolving to `@fleet/billing`) are
 * inspected. A source file whose parse reports diagnostics is a refusal for
 * that file, never a clean pass.
 *
 * Hostile input is refused, never passed: invalid roots, malformed or
 * non-object manifests, unreadable files, getters (never invoked), hostile
 * `Proxy` traps, prototype-polluting keys, enormous key counts, array holes and
 * array-likes each record a typed `unreadable` violation. A `Proxy` that lies
 * consistently in every trap is an accepted residual: specifiers and
 * dependency names are read through property descriptors and cooked literal
 * text, so a lying `get` trap cannot hide a real dependency name, but no
 * detection can be total against a fully lying `Proxy`.
 */

import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { extname, join } from 'node:path';

import * as ts from 'typescript';

export type BoundaryViolationKind = 'dependency' | 'import' | 'unreadable';

export interface BoundaryViolation {
  /** Path of the offending file, relative to the scanned root. */
  file: string;
  kind: BoundaryViolationKind;
  /** The hosted specifier, or an empty string for unreadable findings. */
  specifier: string;
}

export type HostedScanResult = readonly BoundaryViolation[];

/** Literal marker for a refused root; a hostile value is never echoed back. */
export const INVALID_ROOT_FILE = '<root>';

/** Dependency-field keys that can pollute prototypes and are always refused. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Above this many own keys a dependency field is refused as enormous. */
export const MAX_DEPENDENCY_KEYS = 10_000;

const HOSTED_PACKAGE_NAMES: readonly string[] = ['@fleet/tenancy', '@fleet/billing'];

const CLOUD_PACKAGE_PATTERN = /^@fleet\/cloud-[a-z0-9-]+$/;

const SKIP_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  '.next',
  '.output',
  '.turbo',
]);

const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set(['.ts', '.tsx']);

/** Self-host apps scanned for hosted imports; apps/api is exempt. */
const SCANNED_APPS: readonly string[] = ['cli', 'mcp', 'web'];

const DEPENDENCY_FIELDS: readonly string[] = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The hosted package a specifier refers to, or `null` for any lookalike. */
export function hostedPackageName(specifier: unknown): string | null {
  if (typeof specifier !== 'string' || specifier.length === 0) {
    return null;
  }
  if (HOSTED_PACKAGE_NAMES.includes(specifier) || CLOUD_PACKAGE_PATTERN.test(specifier)) {
    return specifier;
  }
  return null;
}

function packageNameOf(specifier: string): string | null {
  if (!specifier.startsWith('@')) {
    return null;
  }
  const scopeEnd = specifier.indexOf('/');
  if (scopeEnd <= 1) {
    return null;
  }
  const subpath = specifier.indexOf('/', scopeEnd + 1);
  return subpath === -1 ? specifier : specifier.slice(0, subpath);
}

/** Whether a specifier targets a hosted package or a subpath of one. */
export function isHostedSpecifier(specifier: unknown): boolean {
  if (typeof specifier !== 'string') {
    return false;
  }
  const name = packageNameOf(specifier);
  return name !== null && hostedPackageName(name) !== null;
}

/**
 * Reads the hosted dependency names of one manifest dependency field without
 * ever invoking a getter or trusting a hostile shape. Returns the hosted names
 * found, or `'unreadable'` when the field must be refused.
 */
export function dependencyNames(value: unknown): readonly string[] | 'unreadable' {
  try {
    // Checked inside the try: `isPlainRecord` touches `Object.getPrototypeOf`,
    // and a Proxy whose `getPrototypeOf` trap throws (or a revoked Proxy) must
    // be refused, never allowed to escape.
    if (!isPlainRecord(value)) {
      return 'unreadable';
    }
    // Descriptors are inspected, never invoked: a getter is a refusal, not data.
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > MAX_DEPENDENCY_KEYS) {
      return 'unreadable';
    }
    const hosted: string[] = [];
    for (const key of keys) {
      if (typeof key !== 'string' || FORBIDDEN_KEYS.has(key)) {
        return 'unreadable';
      }
      const descriptor = descriptors[key] as PropertyDescriptor | undefined;
      if (descriptor === undefined) {
        return 'unreadable';
      }
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        return 'unreadable';
      }
      if (typeof descriptor.value !== 'string') {
        // Array-likes such as `{ length: 3 }` and wrong primitives land here.
        return 'unreadable';
      }
      if (isHostedSpecifier(key)) {
        hosted.push(key);
      }
    }
    return hosted;
  } catch {
    // A hostile Proxy whose traps throw is refused, never passed as clean.
    return 'unreadable';
  }
}

function unreadableViolation(file: string): BoundaryViolation {
  return { file, kind: 'unreadable', specifier: '' };
}

interface ScanState {
  readonly violations: BoundaryViolation[];
  /** Relative paths of the top-level scanned targets, sorted. */
  readonly targets: string[];
}

function readManifest(state: ScanState, root: string, relativePath: string): void {
  let text: string;
  try {
    text = readFileSync(join(root, relativePath), 'utf8');
  } catch {
    state.violations.push(unreadableViolation(relativePath));
    return;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(text) as unknown;
  } catch {
    state.violations.push(unreadableViolation(relativePath));
    return;
  }
  if (!isPlainRecord(manifest)) {
    // `null`, arrays and primitives are never treated as a clean manifest.
    state.violations.push(unreadableViolation(relativePath));
    return;
  }
  const fields = Object.getOwnPropertyDescriptors(manifest);
  for (const field of DEPENDENCY_FIELDS) {
    const descriptor = fields[field] as PropertyDescriptor | undefined;
    if (descriptor === undefined) {
      continue;
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      state.violations.push(unreadableViolation(relativePath));
      return;
    }
    const names = dependencyNames(descriptor.value);
    if (names === 'unreadable') {
      state.violations.push(unreadableViolation(relativePath));
      return;
    }
    for (const name of names) {
      state.violations.push({ file: relativePath, kind: 'dependency', specifier: name });
    }
  }
}

function scanSource(state: ScanState, root: string, relativePath: string): void {
  let text: string;
  try {
    text = readFileSync(join(root, relativePath), 'utf8');
  } catch {
    state.violations.push(unreadableViolation(relativePath));
    return;
  }
  // Parent nodes are not needed; skipping their construction keeps O(F) cheap.
  const sourceFile = ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, false);
  const diagnostics = (
    sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
  if (diagnostics !== undefined && diagnostics.length > 0) {
    // Malformed source is a refusal for that file, never a clean scan.
    state.violations.push(unreadableViolation(relativePath));
    return;
  }
  const checkSpecifier = (specifier: unknown): void => {
    if (isHostedSpecifier(specifier)) {
      state.violations.push({ file: relativePath, kind: 'import', specifier: specifier as string });
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      checkSpecifier(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      // `import x = require('...')`; the expression's text is the cooked value.
      checkSpecifier(node.moduleReference.expression.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      checkSpecifier(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const argument = node.arguments[0];
      if (argument === undefined || !ts.isStringLiteral(argument)) {
        // fall through to child traversal below
      } else if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        // Dynamic `import('...')`; the argument's text is the cooked value.
        checkSpecifier(argument.text);
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        checkSpecifier(argument.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

/** The package name declared by a directory's `package.json`, or `null`. */
function declaredPackageName(root: string, directoryRelative: string): string | null {
  try {
    const manifestPath = join(root, directoryRelative, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
    if (isPlainRecord(manifest) && typeof manifest['name'] === 'string') {
      return manifest['name'];
    }
    return null;
  } catch {
    return null;
  }
}

/** Reads one directory's entries, recording an unreadable violation on failure. */
function readDirectoryEntries(
  state: ScanState,
  root: string,
  directoryRelative: string,
): readonly Dirent[] {
  try {
    // lstat first: a symlink at this path is never followed, so no read can
    // escape the scanned tree. A missing or unreadable directory is a refusal,
    // never a thrown error.
    const stat = lstatSync(join(root, directoryRelative));
    if (stat.isSymbolicLink()) {
      return [];
    }
    if (!stat.isDirectory()) {
      // A non-directory impersonating this path is a refusal, not a pass.
      state.violations.push(unreadableViolation(directoryRelative));
      return [];
    }
    return readdirSync(join(root, directoryRelative), { withFileTypes: true });
  } catch {
    state.violations.push(unreadableViolation(directoryRelative));
    return [];
  }
}

function visitDirectory(state: ScanState, root: string, directoryRelative: string): void {
  for (const entry of readDirectoryEntries(state, root, directoryRelative)) {
    if (entry.isSymbolicLink()) {
      // Symlinks are never followed; out-of-tree reads cannot happen.
      continue;
    }
    const entryRelative = join(directoryRelative, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORY_NAMES.has(entry.name)) {
        continue;
      }
      if (entry.name === 'package.json' || SOURCE_EXTENSIONS.has(extname(entry.name))) {
        // A directory impersonating a manifest or source file is a refusal.
        state.violations.push(unreadableViolation(entryRelative));
        continue;
      }
      visitDirectory(state, root, entryRelative);
      continue;
    }
    if (entry.name === 'package.json') {
      readManifest(state, root, entryRelative);
    } else if (SOURCE_EXTENSIONS.has(extname(entry.name))) {
      scanSource(state, root, entryRelative);
    }
  }
}

/**
 * Collects the top-level scanned targets into `state` and returns them sorted.
 * The `packages` directory is `lstat`ed before being read: a symlink there is
 * never followed (so no out-of-tree read can happen), and a missing or
 * unreadable `packages` directory records an `unreadable` violation in `state`
 * instead of throwing. The self-host apps are still scanned in that case.
 */
function collectScannedTargets(state: ScanState, root: string): readonly string[] {
  const targets: string[] = [];
  for (const entry of readDirectoryEntries(state, root, 'packages')) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      continue;
    }
    const name = declaredPackageName(root, join('packages', entry.name));
    if (name !== null && hostedPackageName(name) !== null) {
      continue; // A hosted package directory itself is never a scanned target.
    }
    targets.push(join('packages', entry.name));
  }
  for (const app of SCANNED_APPS) {
    const appDirectory = join('apps', app);
    try {
      if (lstatSync(join(root, appDirectory)).isDirectory()) {
        targets.push(appDirectory);
      }
    } catch {
      // A missing app directory is simply not a scanned target.
    }
  }
  return targets.sort((left, right) => left.localeCompare(right));
}

/**
 * The set of top-level targets the scanner covers, as sorted paths relative to
 * `root`: every `packages/*` directory except a hosted package directory, plus
 * `apps/cli`, `apps/mcp` and `apps/web`. `apps/api` is exempt.
 */
export function listScannedTargets(root: string): readonly string[] {
  if (typeof root !== 'string' || root === '') {
    return [];
  }
  try {
    if (!lstatSync(root).isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }
  return collectScannedTargets({ violations: [], targets: [] }, root);
}

/**
 * Scans `root` for hosted-package boundary violations and returns every
 * finding. It never throws on missing, unreadable or malformed input: each
 * refusal is a typed `unreadable` violation. An invalid root records one
 * violation whose `file` is the literal `'<root>'`, never the supplied value.
 */
export function scanHostedBoundary(root: string): HostedScanResult {
  const violations: BoundaryViolation[] = [];
  if (typeof root !== 'string' || root === '') {
    violations.push(unreadableViolation(INVALID_ROOT_FILE));
    return violations;
  }
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch {
    violations.push(unreadableViolation(INVALID_ROOT_FILE));
    return violations;
  }
  if (!rootStat.isDirectory()) {
    violations.push(unreadableViolation(INVALID_ROOT_FILE));
    return violations;
  }
  const state: ScanState = { violations, targets: [] };
  for (const target of collectScannedTargets(state, root)) {
    state.targets.push(target);
    visitDirectory(state, root, target);
  }
  return violations;
}
