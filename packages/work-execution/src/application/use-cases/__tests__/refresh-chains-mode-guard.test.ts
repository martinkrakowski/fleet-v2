/**
 * CO8 guard: no code path can merge yet. Every production construction of
 * `RefreshChainsUseCase` names `mode: 'shadow'`; none omits `mode` or passes `'live'`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
const ROOTS = ['apps', 'packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', '.next', '.output', 'coverage']);

function productionFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) {
      if (name === '__tests__') continue;
      productionFiles(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** The object literal after each `new RefreshChainsUseCase(` (balanced braces). */
function constructions(source: string): string[] {
  const found: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf('new RefreshChainsUseCase(', from);
    if (at < 0) return found;
    const open = source.indexOf('{', at);
    let depth = 0;
    let end = open;
    for (; end < source.length; end += 1) {
      if (source[end] === '{') depth += 1;
      if (source[end] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    found.push(source.slice(open, end + 1));
    from = end;
  }
}

describe('RefreshChainsUseCase mode guard', () => {
  it('every production construction passes mode shadow and none passes live or omits mode', () => {
    const sites: { file: string; literal: string }[] = [];
    for (const root of ROOTS) {
      for (const file of productionFiles(path.join(REPO_ROOT, root))) {
        const source = readFileSync(file, 'utf8');
        if (!source.includes('new RefreshChainsUseCase(')) continue;
        for (const literal of constructions(source)) sites.push({ file: path.relative(REPO_ROOT, file), literal });
      }
    }
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) {
      expect([site.file, /mode:\s*'shadow'/.test(site.literal)]).toEqual([site.file, true]);
      expect([site.file, /'live'/.test(site.literal)]).toEqual([site.file, false]);
    }
  });
});
