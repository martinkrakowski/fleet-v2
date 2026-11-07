/**
 * The `fleet-v2 tui` CLI boundary: help/usage handling, interactive-terminal
 * refusal, and the one-screen shell loop. The shell reads in-process from the
 * local state stores and never writes.
 */
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { render } from 'ink';

import type { CliIo } from '../index.js';
import type { FleetCliRuntime } from '../composition.js';
import { TuiApp } from './app.js';
import { createTuiDataSource } from './data.js';
import { nextScreenId, type TuiAction, type TuiScreen } from './shell.js';

export const TUI_HELP = `Usage: fleet-v2 tui

Open the shared fleet-v2 terminal shell. Screens are read in-process from the
local state stores, never over HTTP, and the shell never writes.

  n   next screen
  p   previous screen
  r   re-read the current screen's data
  q   quit

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
  if (argv.length > 0) {
    io.stderr(`unknown tui option: ${argv[0]}\n${TUI_HELP}\n`);
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
  const dataSource = createTuiDataSource((readIso) =>
    runtime.conductor.listLaneRuns.listLaneRuns({ nowIso: readIso }),
  );
  const screens: readonly TuiScreen[] = [{ id: 'runs', title: 'Runs', rows: [] }];

  let currentId = 'runs';

  async function loadRows(): Promise<{ rows: readonly string[]; readAtIso: string }> {
    const readAtIso = nowIso();
    const rows = await dataSource.listRuns(readAtIso);
    return { rows, readAtIso };
  }

  async function handleAction(action: TuiAction, rendered: TuiRendered): Promise<void> {
    try {
      if (action === 'quit') {
        rendered.unmount();
        return;
      }
      if (action === 'next' || action === 'prev') {
        currentId = nextScreenId(screens, currentId, action);
      }
      if (action !== 'none') {
        const loaded = await loadRows();
        const screen = screens.find((entry) => entry.id === currentId);
        if (screen === undefined) {
          return;
        }
        rendered.rerender(
          createElement(TuiApp, {
            title: screen.title,
            rows: loaded.rows,
            readAtIso: loaded.readAtIso,
            onAction: (nextAction) => {
              void handleAction(nextAction, rendered);
            },
          }),
        );
      }
    } catch {
      // A failed read shows the not-read rows; it never exits the shell.
    }
  }

  const initial = await loadRows();
  const rendered = renderTree(
    createElement(TuiApp, {
      title: 'Runs',
      rows: initial.rows,
      readAtIso: initial.readAtIso,
      onAction: (action) => {
        void handleAction(action, rendered);
      },
    }),
  );

  await rendered.waitUntilExit();
  return 0;
}
