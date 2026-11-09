import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');

/**
 * Tests that importing the package root does not load the provider SDK.
 *
 * The provider SDK (`ai` and `@ai-sdk/openai-compatible`) must only be loaded
 * when the function returned by `createSdkApiReviewGenerate` is actually called,
 * not when the package root (`@fleet/evidence-and-acceptance`) is imported.
 *
 * This test uses static analysis of the built output: it walks the dependency
 * graph from `dist/index.js` through relative imports and asserts that no
 * reachable file carries a top-level `import … from 'ai'` or
 * `import … from '@ai-sdk/openai-compatible'`, including side-effect imports
 * like `import 'ai';`.
 */

// A simple cache to avoid re-reading files during the walk
const fileCache = new Map<string, string>();

function readFileCached(filePath: string): string {
  let content = fileCache.get(filePath);
  if (content === undefined) {
    content = readFileSync(filePath, 'utf8');
    fileCache.set(filePath, content);
  }
  return content;
}

/**
 * Extracts top-level import specifiers from a JavaScript/TypeScript file.
 * Matches static `import ... from 'specifier'`, `import 'specifier'`,
 * and `export * from 'specifier'` at the top level.
 */
function extractTopLevelImports(content: string): string[] {
  const imports: string[] = [];
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trimStart();
    // Match `import ... from 'specifier'` or `import ... from "specifier"`
    if (trimmed.startsWith('import ') && trimmed.includes(" from ")) {
      const match = trimmed.match(/import\s+.*\s+from\s+['"]([^'"]+)['"]/);
      if (match) {
        imports.push(match[1]);
      }
    }
    // Match side-effect import `import 'specifier'` or `import "specifier"`
    if (trimmed.startsWith('import ') && !trimmed.includes(" from ")) {
      const match = trimmed.match(/import\s+['"]([^'"]+)['"]/);
      if (match) {
        imports.push(match[1]);
      }
    }
    // Match `export * from 'specifier'` or `export * from "specifier"`
    if (trimmed.startsWith('export ') && trimmed.includes(" from ")) {
      const match = trimmed.match(/export\s+.*\s+from\s+['"]([^'"]+)['"]/);
      if (match) {
        imports.push(match[1]);
      }
    }
  }
  return imports;
}

/**
 * Resolves a relative import specifier to an absolute file path.
 */
function resolveImport(importerPath: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) {
    return null; // External/absolute import, not a relative file we can walk
  }
  const dir = resolve(importerPath, '..');
  const resolved = resolve(dir, specifier);
  // Try with .js extension if not present
  if (!resolved.endsWith('.js')) {
    return resolved + '.js';
  }
  return resolved;
}

/**
 * Walks the dependency graph from an entry point, checking for forbidden top-level imports.
 */
function walkDependencies(
  entryPoint: string,
  visited: Set<string> = new Set(),
): { forbiddenImports: Array<{ file: string; specifier: string }>; errors: string[] } {
  const forbiddenImports: Array<{ file: string; specifier: string }> = [];
  const errors: string[] = [];

  function walk(filePath: string) {
    const normalized = resolve(filePath);
    if (visited.has(normalized)) return;
    visited.add(normalized);

    let content: string;
    try {
      content = readFileCached(normalized);
    } catch {
      errors.push(`Cannot read file: ${normalized}`);
      return;
    }

    const imports = extractTopLevelImports(content);
    for (const specifier of imports) {
      if (specifier === 'ai' || specifier === '@ai-sdk/openai-compatible') {
        forbiddenImports.push({ file: normalized, specifier });
      }
      const resolved = resolveImport(normalized, specifier);
      if (resolved) {
        walk(resolved);
      }
    }
  }

  walk(entryPoint);
  return { forbiddenImports, errors };
}

describe('Package root import: lazy SDK import (static analysis)', () => {
  it('no reachable file from dist/index.js imports "ai" at top level', () => {
    // __dirname is packages/evidence-and-acceptance/src/infrastructure/adapters
    // Go up to package root: ../../..
    const packageRoot = resolve(__dirname, '../../..');
    const entryPoint = resolve(packageRoot, 'dist/index.js');

    const { forbiddenImports, errors } = walkDependencies(entryPoint);

    // The walk should succeed without read errors
    expect(errors).toEqual([]);

    // No reachable file should import 'ai' at top level
    expect(forbiddenImports.filter((i) => i.specifier === 'ai')).toEqual([]);
  });

  it('no reachable file from dist/index.js imports "@ai-sdk/openai-compatible" at top level', () => {
    const packageRoot = resolve(__dirname, '../../..');
    const entryPoint = resolve(packageRoot, 'dist/index.js');

    const { forbiddenImports, errors } = walkDependencies(entryPoint);

    // The walk should succeed without read errors
    expect(errors).toEqual([]);

    // No reachable file should import '@ai-sdk/openai-compatible' at top level
    expect(forbiddenImports.filter((i) => i.specifier === '@ai-sdk/openai-compatible')).toEqual([]);
  });

  it('scanner catches side-effect imports of forbidden modules', () => {
    // This test verifies that the scanner detects bare side-effect imports
    // like `import 'ai';` or `import '@ai-sdk/openai-compatible';`.
    const testContent = `
// Side-effect imports that would load the SDK at package-root import time
import 'ai';
import '@ai-sdk/openai-compatible';

// Regular imports (also forbidden at top level in reachable files)
import { generateObject } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

// Export re-exports
export * from 'ai';
export * from '@ai-sdk/openai-compatible';
`;

    const imports = extractTopLevelImports(testContent);

    // Should catch all six forbidden specifiers (side-effect, named, re-export)
    expect(imports).toContain('ai');
    expect(imports).toContain('@ai-sdk/openai-compatible');
    // Three 'ai' and three '@ai-sdk/openai-compatible' imports detected
    expect(imports.filter((s) => s === 'ai')).toHaveLength(3);
    expect(imports.filter((s) => s === '@ai-sdk/openai-compatible')).toHaveLength(3);
  });
});