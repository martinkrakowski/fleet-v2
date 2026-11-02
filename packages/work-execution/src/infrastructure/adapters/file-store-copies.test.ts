import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** The repository's `packages/` directory, four levels above this test file. */
const packagesRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/** Q5b versions work-execution's file-store.ts; the peer contexts keep their own copy. */
const PEER_CONTEXTS = [
  'evidence-and-acceptance',
  'brief-knowledge',
  'operator-coordination',
] as const;

function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('file-store.ts copies across contexts', () => {
  it('peer contexts stay byte-identical (same SHA-256)', async () => {
    const hashes = await Promise.all(
      PEER_CONTEXTS.map(async (ctx) => {
        const filePath = path.join(packagesRoot, ctx, 'src/infrastructure/adapters/file-store.ts');
        return sha256Of(await fs.readFile(filePath));
      }),
    );
    expect(new Set(hashes).size).toBe(1);
  });
});
