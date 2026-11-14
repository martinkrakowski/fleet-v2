/**
 * Shared in-memory fakes for the three independent-review transports
 * (RTCONF1). Every transport is built through its injectable seams only:
 * `spawn` / `generate` / `makeScratchDir` / `makeNonce` / `location`. No
 * subprocess runs and no network call is made here.
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunIndependentReviewRequest } from '../../../application/ports/out/IndependentReviewPort.out-port.js';
import type { IndependentReviewTransportResult } from '../IndependentReviewAdapter.adapter.js';
import {
  createApiReviewTransport,
  type ApiReviewGenerate,
  type ApiReviewGenerateResult,
  type ApiReviewTransportOptions,
} from '../ApiReviewTransport.adapter.js';
import {
  createCliReviewTransport,
  GROK_REVIEW_ARGV_TEMPLATE,
  type CliReviewSpawn,
  type CliReviewTransportOptions,
} from '../CliReviewTransport.adapter.js';
import {
  createOcmReviewTransport,
  type OcmReviewTransportOptions,
  type OcmReviewTransportSpawn,
} from '../OcmReviewTransport.adapter.js';
import type { ReviewLocation } from '../ReviewTransportRouter.js';
import type { SpawnRunOutcome } from '../spawn-run.js';

export type TransportKind = 'cli' | 'opencode' | 'api';

export const CONFORMANCE_HEAD_SHA = 'sha-conformance-head';
export const CONFORMANCE_BASE_SHA = 'sha-conformance-base';
export const CONFORMANCE_DIFF = 'diff --git a/a.txt b/a.txt\n-old\n+new\n';
export const CONFORMANCE_REVIEWER_MODEL = 'grok-4.7';
export const CONFORMANCE_NONCE = 'a'.repeat(32);

/** A trailing fenced ```json reply block (RV5): the only shape that can pass or fail. */
export const jsonReply = (verdict: 'PASS' | 'FAIL', findings: readonly unknown[] = []): string =>
  '```json\n' + JSON.stringify({ verdict, findings }) + '\n```';

export function makeConformanceRequest(
  overrides: Partial<RunIndependentReviewRequest> = {},
): RunIndependentReviewRequest {
  return {
    attemptId: 'att-rtconf',
    candidateHeadSha: CONFORMANCE_HEAD_SHA,
    implementerModel: 'example-provider/glm-5.3',
    reviewerModel: CONFORMANCE_REVIEWER_MODEL,
    kind: 'code-review',
    ...overrides,
  };
}

export function makeFakeReviewLocation(
  overrides: Partial<ReviewLocation> = {},
): ReviewLocation {
  return {
    worktreePath: '/srv/rtconf/att-rtconf',
    baseCommit: CONFORMANCE_BASE_SHA,
    route: { kind: 'legacy' },
    readHead: async () => CONFORMANCE_HEAD_SHA,
    readStatus: async () => '',
    readDiff: async () => CONFORMANCE_DIFF,
    ...overrides,
  };
}

/** grok runs with `--output-format json`; its reply text lives in `text`. */
export const cliStdout = (reply: string): string => JSON.stringify({ text: reply });

/** A CLI spawn that never touches the scratch dir and answers with the given reply text. */
export function makeCliSpawn(reply: string, overrides: Partial<SpawnRunOutcome> = {}): CliReviewSpawn {
  return async () => ({
    exitCode: 0,
    signal: null,
    stdout: cliStdout(reply),
    stderr: '',
    ...overrides,
  });
}

/**
 * The JSON-lines stream an opencode review answers with: one `step_start`,
 * one text part (empty when the reply is empty, which is still a part), and
 * one `step_finish`. Options add a `bash` tool call (read-only voiding) or
 * replace the whole stream with something the transport never finished.
 */
export function ocmStream(reply: string, opts: { bashTool?: boolean } = {}): string {
  const lines = [
    JSON.stringify({ type: 'step_start' }),
    ...(opts.bashTool === true ? [JSON.stringify({ type: 'tool', tool: 'bash' })] : []),
    JSON.stringify({ type: 'text', part: { type: 'text', text: reply } }),
    JSON.stringify({ type: 'step_finish' }),
  ];
  return lines.join('\n') + '\n';
}

/** The opencode spawn seam: `--wait` proves the worktree idle, then the review spawn answers. */
export function makeOcmSpawn(
  reply: string,
  opts: { bashTool?: boolean; timeout?: boolean; stream?: string } = {},
): OcmReviewTransportSpawn {
  return async (_file, args) => {
    if (args[0] === '--wait') {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (opts.timeout === true) {
      return { exitCode: null, timedOut: true, stdout: '', stderr: '' };
    }
    return {
      exitCode: 0,
      stdout: opts.stream ?? ocmStream(reply, { bashTool: opts.bashTool }),
      stderr: '',
    };
  };
}

/** The api transport's provider call: returns a fixed answer without any network. */
export function makeApiGenerate(answer: ApiReviewGenerateResult): ApiReviewGenerate {
  return async () => answer;
}

/** A provider call that rejects, for the timeout and unreachable-endpoint classifications. */
export function makeApiGenerateRejecting(error: unknown): ApiReviewGenerate {
  return async () => {
    throw error;
  };
}

export interface ConformanceTransportOptions {
  readonly cli?: Partial<CliReviewTransportOptions>;
  readonly opencode?: Partial<OcmReviewTransportOptions>;
  readonly api?: Partial<ApiReviewTransportOptions>;
}

/** Default transport answers for the happy-path cases: a valid PASS with no findings. */
const defaultHappyPathReply = jsonReply('PASS', []);

export function makeConformanceTransport(
  kind: TransportKind,
  opts: ConformanceTransportOptions = {},
): (request: RunIndependentReviewRequest) => Promise<IndependentReviewTransportResult> {
  if (kind === 'cli') {
    return createCliReviewTransport({
      argvTemplate: GROK_REVIEW_ARGV_TEMPLATE,
      model: CONFORMANCE_REVIEWER_MODEL,
      location: makeFakeReviewLocation(),
      spawn: makeCliSpawn(defaultHappyPathReply),
      makeNonce: () => CONFORMANCE_NONCE,
      // A real temp dir under /tmp; createCliReviewTransport removes it in its finally.
      makeScratchDir: async () => mkdtemp(join(tmpdir(), 'rtconf-')),
      ...opts.cli,
    });
  }
  if (kind === 'opencode') {
    return createOcmReviewTransport({
      ocmRunBin: 'ocm-run',
      remotePort: 4176,
      agent: 'reviewer',
      model: CONFORMANCE_REVIEWER_MODEL,
      resolveReviewDir: async () => '/srv/rtconf/att-rtconf',
      readHead: async () => CONFORMANCE_HEAD_SHA,
      baseCommit: CONFORMANCE_BASE_SHA,
      readDiff: async () => CONFORMANCE_DIFF,
      spawn: makeOcmSpawn(defaultHappyPathReply),
      makeNonce: () => CONFORMANCE_NONCE,
      ...opts.opencode,
    });
  }
  return createApiReviewTransport({
    baseURL: 'http://127.0.0.1:4176/v1',
    model: CONFORMANCE_REVIEWER_MODEL,
    schemaEnforcement: 'native-json-schema',
    location: makeFakeReviewLocation(),
    generate: makeApiGenerate({ object: { result: 'pass', findings: [] }, readOnly: true }),
    makeNonce: () => CONFORMANCE_NONCE,
    ...opts.api,
  });
}
