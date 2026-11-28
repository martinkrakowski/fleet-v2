/**
 * The `fleet-v2 tui` CLI boundary: help/usage handling, interactive-terminal
 * refusal, and the shell loop. The Runs screen reads in-process from the local
 * state stores; Questions and Permissions read and submit over /v1 only with an
 * explicit confirmation before each write. A token lives in memory only.
 */
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { render } from 'ink';

import type { CliIo } from '../index.js';
import type { FleetCliRuntime } from '../composition.js';
import { TuiApp } from './app.js';
import { createTuiApiClient, exchangeSessionToken } from './api.js';
import { createTuiDataSource } from './data.js';
import {
  capturesKeys,
  initialInputState,
  reduceInput,
  renderInputLines,
  type TuiInputEffect,
  type TuiInputState,
  type TuiKey,
} from './input.js';
import { nextScreenId, type TuiAction, type TuiScreen } from './shell.js';

export const TUI_HELP = `Usage: fleet-v2 tui [--thread-id <id>]

Open the shared fleet-v2 terminal shell. The Runs screen is read in-process
from the local state stores. The Questions and Permissions screens read and
submit over /v1 HTTP when FLEET_API_URL is configured, with an explicit
confirmation before every write; one-way questions stay read-only.

  n   next screen
  p   previous screen
  r   re-read the current screen's data
  q   quit

Questions and Permissions:
  j/k or arrows   move        Enter   open
  a / x / o       accept, reject, choose an option (questions)
  a / d           allow, deny (permissions)
  y               confirm the write    n or Esc   cancel

Options and environment:
  --thread-id <id>   thread for Permissions
  FLEET_API_URL      the /v1 base URL

Writes need a bearer token, or an interactive session secret exchanged once for
one, that the host supplies in memory. A token is never read from disk, never
taken from a flag and never put in a URL.

Exit codes: 0 quit, 1 refused (no interactive terminal), 2 usage error.`;

export interface TuiRendered {
  readonly waitUntilExit: () => Promise<unknown>;
  readonly rerender: (tree: ReactElement) => void;
  readonly unmount: () => void;
}

export interface TuiCommandOptions {
  /** Default: process.stdin.isTTY === true && process.stdout.isTTY === true. */
  readonly interactive?: boolean;
  /** Default: ink's render(). */
  readonly render?: (tree: ReactElement) => TuiRendered;
  /** Default: () => new Date().toISOString(). */
  readonly nowIso?: () => string;
  /** The /v1 base URL; default process.env.FLEET_API_URL. */
  readonly apiUrl?: string;
  /** In-memory bearer token; never read from disk or argv. */
  readonly token?: string;
  /** Interactive session secret, exchanged once in memory for a scoped token. */
  readonly sessionSecret?: string;
  /** Thread for the Permissions screen; `--thread-id` overrides it. */
  readonly threadId?: string;
  /** Default: global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Request timeout in ms; default 5000. */
  readonly timeoutMs?: number;
}

const NOT_CONFIGURED_ROWS = ['API not configured (set FLEET_API_URL)'] as const;
const EXCHANGE_SCOPES = ['read', 'message', 'verdict'] as const;

type ParsedArgs =
  | { readonly ok: true; readonly threadId: string | null }
  | { readonly ok: false; readonly message: string };

function parseTuiArgs(argv: readonly string[]): ParsedArgs {
  let threadId: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    let value: string | undefined;
    if (arg === '--thread-id') {
      value = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--thread-id=')) {
      value = arg.slice('--thread-id='.length);
    } else {
      return { ok: false, message: `unknown tui option: ${arg}` };
    }
    if (value === undefined || value.trim().length === 0 || value.startsWith('--')) {
      return { ok: false, message: '--thread-id needs a value' };
    }
    threadId = value.trim();
  }
  return { ok: true, threadId };
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export async function tuiCommand(
  argv: readonly string[],
  io: CliIo,
  runtime: FleetCliRuntime,
  options?: TuiCommandOptions,
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout(`${TUI_HELP}\n`);
    return 0;
  }
  const parsed = parseTuiArgs(argv);
  if (!parsed.ok) {
    io.stderr(`${parsed.message}\n${TUI_HELP}\n`);
    return 2;
  }
  const interactive =
    options?.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  if (!interactive) {
    io.stderr('tui needs an interactive terminal\n');
    return 1;
  }

  const nowIso = options?.nowIso ?? (() => new Date().toISOString());
  const renderTree = options?.render ?? render;
  const apiUrl = nonEmpty(options?.apiUrl ?? process.env.FLEET_API_URL);
  const threadId = parsed.threadId ?? nonEmpty(options?.threadId);
  const sessionSecret = nonEmpty(options?.sessionSecret);
  let token = nonEmpty(options?.token);
  const dataSource = createTuiDataSource((readIso) =>
    runtime.conductor.listLaneRuns.listLaneRuns({ nowIso: readIso }),
  );
  const screens: readonly TuiScreen[] = [
    { id: 'runs', title: 'Runs', rows: [] },
    { id: 'questions', title: 'Questions', rows: [] },
    { id: 'permissions', title: 'Permissions', rows: [] },
  ];

  let currentId = 'runs';
  let rows: readonly string[] = [];
  let readAtIso = nowIso();
  let inputState: TuiInputState | null = null;
  let busy = false;
  let rendered: TuiRendered | null = null;
  let exchangeTried = false;

  async function client() {
    if (token === null && sessionSecret !== null && apiUrl !== null && !exchangeTried) {
      exchangeTried = true;
      const exchanged = await exchangeSessionToken(apiUrl, sessionSecret, EXCHANGE_SCOPES, {
        ...(options?.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      if (exchanged.ok) {
        token = exchanged.token;
      }
    }
    return createTuiApiClient({
      baseUrl: apiUrl ?? '',
      ...(token === null ? {} : { token }),
      ...(options?.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  }

  async function loadScreen(status: string | null = null): Promise<void> {
    readAtIso = nowIso();
    inputState = null;
    if (currentId === 'runs') {
      rows = await dataSource.listRuns(readAtIso);
      return;
    }
    if (apiUrl === null) {
      rows = NOT_CONFIGURED_ROWS;
      return;
    }
    const api = await client();
    if (currentId === 'questions') {
      const result = await api.listOpenQuestions();
      if (!result.ok) {
        rows = [`questions not read: ${result.reason}`];
        return;
      }
      inputState = initialInputState(
        'questions',
        { questions: result.questions },
        status ?? (result.truncated ? 'list truncated' : null),
      );
      return;
    }
    if (threadId === null) {
      rows = ['thread id not set (pass --thread-id <id>)'];
      return;
    }
    const result = await api.listPendingPermissions(threadId);
    if (!result.ok) {
      rows = [`permissions not read: ${result.reason}`];
      return;
    }
    inputState = initialInputState(
      'permissions',
      { permissions: result.requests },
      status ?? (result.truncated ? 'list truncated' : null),
    );
  }

  function draw(): void {
    const screen = screens.find((entry) => entry.id === currentId);
    if (screen === undefined || rendered === null) {
      return;
    }
    const state = inputState;
    rendered.rerender(
      createElement(TuiApp, {
        title: screen.title,
        rows,
        readAtIso,
        onAction: (action) => {
          void handleAction(action);
        },
        ...(state === null
          ? {}
          : {
              inputLines: renderInputLines(state),
              capturing: capturesKeys(state),
              onRawInput: (key: TuiKey) => {
                void handleKey(key);
              },
            }),
      }),
    );
  }

  async function submit(effect: TuiInputEffect): Promise<string> {
    const api = await client();
    if (effect.kind === 'answer') {
      const result = await api.answerQuestion(effect.input);
      if (!result.ok) {
        return `refused: ${result.reason}`;
      }
      return result.replayed ? 'answer was already recorded' : 'answer recorded';
    }
    if (threadId === null) {
      return 'refused: thread id not set';
    }
    const result = await api.givePermissionVerdict(threadId, effect.requestId, effect.decision);
    if (!result.ok) {
      return `refused: ${result.reason}`;
    }
    return result.conflict ? `a different verdict was recorded first: ${result.decision}` : `verdict recorded: ${result.decision}`;
  }

  async function handleKey(key: TuiKey): Promise<void> {
    if (busy || inputState === null) {
      return;
    }
    try {
      const stepped = reduceInput(inputState, key);
      inputState = stepped.state;
      draw();
      if (stepped.effect !== null) {
        busy = true;
        try {
          const status = await submit(stepped.effect);
          await loadScreen(status);
        } finally {
          busy = false;
        }
        draw();
      }
    } catch {
      // A failed write shows nothing as sent; it never exits the shell.
    }
  }

  async function handleAction(action: TuiAction): Promise<void> {
    try {
      if (action === 'quit') {
        rendered?.unmount();
        return;
      }
      if (action === 'next' || action === 'prev') {
        currentId = nextScreenId(screens, currentId, action);
      }
      if (action !== 'none') {
        await loadScreen();
        draw();
      }
    } catch {
      // A failed read shows the not-read rows; it never exits the shell.
    }
  }

  await loadScreen();
  rendered = renderTree(
    createElement(TuiApp, {
      title: 'Runs',
      rows,
      readAtIso,
      onAction: (action) => {
        void handleAction(action);
      },
    }),
  );

  await rendered.waitUntilExit();
  return 0;
}
