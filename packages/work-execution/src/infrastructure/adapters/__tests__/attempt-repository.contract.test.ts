import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe } from 'vitest';

import { AttemptRepositoryAdapter } from '../AttemptRepositoryAdapter.adapter.js';
import { describeAttemptRepositoryContract } from '../../../application/ports/out/__tests__/attempt-repository.contract.js';
import { InMemoryAttemptRepository } from '../../../application/ports/out/__tests__/in-memory-attempt-repository.js';

describe('AttemptRepositoryPort contract', () => {
  describeAttemptRepositoryContract('in-memory adapter', () => new AttemptRepositoryAdapter());
  describeAttemptRepositoryContract('shared in-memory fake', () => new InMemoryAttemptRepository());

  describe('file-backed adapter', () => {
    let stateDir = '';
    beforeEach(async () => {
      stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-attempt-contract-'));
    });
    afterEach(async () => {
      await fs.rm(stateDir, { recursive: true, force: true });
    });
    describeAttemptRepositoryContract(
      'file-backed adapter',
      () => new AttemptRepositoryAdapter({ stateDir }),
    );
  });
});
