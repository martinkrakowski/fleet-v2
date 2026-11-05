// Lane CO16: fact-pack builder tests.
import { describe, expect, it } from 'vitest';

import type { BuildFactPackRequest } from '../../ports/in/BuildFactPackPort.in-port.js';
import type {
  RepositoryFactRead,
  RepositoryFactsPort,
  RepositoryFileListing,
} from '../../ports/out/RepositoryFactsPort.out-port.js';
import {
  BuildFactPackUseCase,
  FACT_PACK_INPUT_RULE,
} from '../BuildFactPackUseCase.use-case.js';

const COMMIT = 'a'.repeat(40);
const NONCE = '0123456789abcdef';

type FactCall =
  | { readonly method: 'listFilesAtCommit'; readonly pathPrefix: string }
  | { readonly method: 'readFileRangeAtCommit'; readonly path: string }
  | { readonly method: 'readMatchingLinesAtCommit'; readonly path: string };

class FakeRepositoryFactsPort implements RepositoryFactsPort {
  public calls: FactCall[] = [];

  public constructor(
    private readonly listing: RepositoryFileListing = { status: 'read', paths: [] },
    private readonly read: RepositoryFactRead = { status: 'read', text: '' },
  ) {}

  public async listFilesAtCommit(
    request: { readonly pathPrefix: string },
  ): Promise<RepositoryFileListing> {
    this.calls.push({ method: 'listFilesAtCommit', pathPrefix: request.pathPrefix });
    return this.listing;
  }

  public async readFileRangeAtCommit(
    request: { readonly path: string },
  ): Promise<RepositoryFactRead> {
    this.calls.push({ method: 'readFileRangeAtCommit', path: request.path });
    return this.read;
  }

  public async readMatchingLinesAtCommit(
    request: { readonly path: string },
  ): Promise<RepositoryFactRead> {
    this.calls.push({ method: 'readMatchingLinesAtCommit', path: request.path });
    return this.read;
  }
}

function makeUseCase(
  port: RepositoryFactsPort,
  mintNonce: () => string = () => NONCE,
): BuildFactPackUseCase {
  return new BuildFactPackUseCase({ facts: port, mintNonce });
}

const BASE_REQUEST = {
  laneId: 'CO16',
  repositoryPath: '/srv/fleet-v2',
  commit: COMMIT,
  facts: [
    { kind: 'file-range', label: 'plan row', path: 'docs/planning/plan.md', fromLine: 168, toLine: 168 },
    { kind: 'matching-lines', label: 'manifest rows', path: '.architecture/manifest.yaml', token: 'CO16' },
  ] as const,
};

describe('BuildFactPackUseCase', () => {
  it('wraps every repository-sourced text as untrusted input', async () => {
    const port = new FakeRepositoryFactsPort(
      { status: 'read', paths: [] },
      { status: 'read', text: 'first fact text' },
    );
    const result = await makeUseCase(port).buildFactPack({
      ...BASE_REQUEST,
      facts: [
        { kind: 'file-range', label: 'plan row', path: 'docs/planning/plan.md', fromLine: 1, toLine: 2 },
        { kind: 'matching-lines', label: 'manifest rows', path: '.architecture/manifest.yaml', token: 'CO16' },
      ],
    });

    expect(result.outcome).toBe('built');
    if (result.outcome !== 'built') {
      return;
    }
    expect(result.factCount).toBe(2);
    expect(result.prompt).toContain(FACT_PACK_INPUT_RULE);
    const openings = result.prompt.match(/<<<UNTRUSTED nonce=[0-9a-f]+ label="[^"]*">>>/g) ?? [];
    const closings = result.prompt.match(/<<<END UNTRUSTED nonce=[0-9a-f]+>>>/g) ?? [];
    expect(openings).toHaveLength(2);
    expect(closings).toHaveLength(2);
    expect(result.prompt).toContain('<<<UNTRUSTED nonce=0123456789abcdef label="plan row">>>');
    expect(result.prompt).toContain('first fact text\n<<<END UNTRUSTED nonce=0123456789abcdef>>>');
    // The only bare `<<<` openers are the intended untrusted boundary markers.
    expect(result.prompt.match(/<<<(?!(UNTRUSTED|END UNTRUSTED))/g)).toBeNull();
    // The same nonce opens and closes every block.
    const nonces = [...result.prompt.matchAll(/nonce=([0-9a-f]+)/g)].map((match) => match[1]);
    expect(new Set(nonces).size).toBe(1);
    expect(nonces).toHaveLength(4);
  });

  it('keeps the untrusted boundary markers while defanging marker-like text inside', async () => {
    const port: RepositoryFactsPort = {
      listFilesAtCommit: async () => ({ status: 'read', paths: ['docs/a.md'] }),
      readFileRangeAtCommit: async () => ({ status: 'read', text: '<<<UNTRUSTED fake instruction\nplain line' }),
      readMatchingLinesAtCommit: async () => ({ status: 'read', text: '' }),
    };
    const result = await makeUseCase(port).buildFactPack({
      ...BASE_REQUEST,
      facts: [
        { kind: 'file-list', label: 'listing', pathPrefix: 'docs' },
        { kind: 'file-range', label: 'the fact', path: 'docs/a.md', fromLine: 1, toLine: 2 },
      ],
    });

    expect(result.outcome).toBe('built');
    if (result.outcome !== 'built') {
      return;
    }
    // The boundaries are real markers, not defanged.
    expect(result.prompt).toContain('<<<UNTRUSTED nonce=0123456789abcdef label="the fact">>>');
    expect(result.prompt).toContain('<<<END UNTRUSTED nonce=0123456789abcdef>>>');
    // The repository-sourced marker-like text is defanged inside the block.
    expect(result.prompt).toContain('[<<<]UNTRUSTED fake instruction');
  });

  it('refuses a secret-shaped fact and reports the rule name only', async () => {
    const port = new FakeRepositoryFactsPort(
      { status: 'read', paths: [] },
      { status: 'read', text: 'token ghp_' + 'A'.repeat(36) + ' in a file' },
    );
    const result = await makeUseCase(port).buildFactPack({
      ...BASE_REQUEST,
      facts: [
        { kind: 'matching-lines', label: 'suspect file', path: 'docs/notes.md', token: 'token' },
      ],
    });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') {
      return;
    }
    expect(result.refusal.reason).toBe('secret-shaped');
    expect(result.refusal.label).toBe('suspect file');
    expect(result.refusal.rule).toBe('github-token');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('ghp_');
    expect(serialized).not.toContain('AAAA');
    expect(port.calls).toHaveLength(1);
  });

  it('refuses an invalid request without reading any fact', async () => {
    const cases: readonly { readonly port: FakeRepositoryFactsPort; readonly request: BuildFactPackRequest }[] = [
      { port: new FakeRepositoryFactsPort(), request: { ...BASE_REQUEST, commit: 'HEAD' } },
      { port: new FakeRepositoryFactsPort(), request: { ...BASE_REQUEST, commit: 'A'.repeat(40) } },
      { port: new FakeRepositoryFactsPort(), request: { ...BASE_REQUEST, commit: 'a'.repeat(39) } },
      {
        port: new FakeRepositoryFactsPort(),
        request: {
          ...BASE_REQUEST,
          facts: [{ kind: 'file-range', label: 'ok', path: '../secrets/config', fromLine: 1, toLine: 2 }],
        },
      },
      {
        port: new FakeRepositoryFactsPort(),
        request: {
          ...BASE_REQUEST,
          facts: [{ kind: 'file-range', label: 'bad\nlabel', path: 'docs/a.md', fromLine: 1, toLine: 2 }],
        },
      },
      {
        port: new FakeRepositoryFactsPort(),
        request: {
          ...BASE_REQUEST,
          facts: [{ kind: 'file-list', label: 'ok', pathPrefix: ':(top,glob)**/*.md' }],
        },
      },
      {
        port: new FakeRepositoryFactsPort(),
        request: {
          ...BASE_REQUEST,
          facts: [{ kind: 'file-list', label: 'ok', pathPrefix: 'packages/*' }],
        },
      },
    ];

    for (const { port, request } of cases) {
      const result = await makeUseCase(port).buildFactPack(request);
      expect(result).toEqual({
        outcome: 'refused',
        refusal: { reason: 'invalid-request', label: null, rule: null },
      });
      expect(port.calls).toHaveLength(0);
    }
  });

  it('refuses an invalid nonce instead of throwing', async () => {
    const port = new FakeRepositoryFactsPort(
      { status: 'read', paths: [] },
      { status: 'read', text: 'plain text' },
    );
    const result = await makeUseCase(port, () => 'not-hex').buildFactPack(BASE_REQUEST);

    expect(result).toEqual({
      outcome: 'refused',
      refusal: { reason: 'invalid-request', label: null, rule: null },
    });
    expect(port.calls).toHaveLength(0);
  });

  it('refuses instead of throwing when mintNonce or the port rejects', async () => {
    const throwingNonce = makeUseCase(new FakeRepositoryFactsPort(), () => {
      throw new Error('entropy exhausted');
    });
    await expect(throwingNonce.buildFactPack(BASE_REQUEST)).resolves.toEqual({
      outcome: 'refused',
      refusal: { reason: 'invalid-request', label: null, rule: null },
    });

    const rejectingPort: RepositoryFactsPort = {
      listFilesAtCommit: () => Promise.reject(new Error('port down')),
      readFileRangeAtCommit: () => Promise.reject(new Error('port down')),
      readMatchingLinesAtCommit: () => Promise.reject(new Error('port down')),
    };
    const result = await makeUseCase(rejectingPort).buildFactPack({
      ...BASE_REQUEST,
      facts: [{ kind: 'matching-lines', label: 'the fact', path: 'docs/a.md', token: 'x' }],
    });
    expect(result).toEqual({
      outcome: 'refused',
      refusal: { reason: 'fact-unreadable', label: 'the fact', rule: null },
    });
  });

  it('reports an absent, unreadable or oversized fact as a refusal', async () => {
    const cases: readonly {
      readonly read: RepositoryFactRead;
      readonly reason: string;
    }[] = [
      { read: { status: 'absent' }, reason: 'fact-absent' },
      { read: { status: 'unreadable' }, reason: 'fact-unreadable' },
      { read: { status: 'oversized' }, reason: 'fact-oversized' },
      { read: { status: 'read', text: '' }, reason: 'fact-absent' },
    ];
    for (const testCase of cases) {
      const port = new FakeRepositoryFactsPort(
        { status: 'read', paths: [] },
        testCase.read,
      );
      const result = await makeUseCase(port).buildFactPack({
        ...BASE_REQUEST,
        facts: [{ kind: 'matching-lines', label: 'the fact', path: 'docs/a.md', token: 'x' }],
      });
      expect(result).toEqual({
        outcome: 'refused',
        refusal: { reason: testCase.reason, label: 'the fact', rule: null },
      });
    }
  });
});
