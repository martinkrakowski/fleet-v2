/**
 * The TUI shell's pure frame logic: key mapping, screen navigation and the
 * shared frame lines. Pure: no React, no Ink, no I/O — the CLI boundary
 * (`command.ts`) and the view (`app.tsx`) build on it.
 */

export type TuiAction = 'next' | 'prev' | 'reload' | 'quit' | 'none';

/** Maps one input key to the TUI action it triggers; every other input is 'none'. */
export function tuiActionFor(input: string): TuiAction {
  switch (input) {
    case 'n':
      return 'next';
    case 'p':
      return 'prev';
    case 'r':
      return 'reload';
    case 'q':
      return 'quit';
    default:
      return 'none';
  }
}

export interface TuiScreen {
  readonly id: string;
  readonly title: string;
  readonly rows: readonly string[];
}

/**
 * The screen after (or before) the current one, wrapping at both ends. An
 * unknown current id lands on the first screen; an empty registry keeps the
 * current id.
 */
export function nextScreenId(
  screens: readonly TuiScreen[],
  currentId: string,
  action: 'next' | 'prev',
): string {
  if (screens.length === 0) {
    return currentId;
  }
  const index = screens.findIndex((screen) => screen.id === currentId);
  if (index === -1) {
    return screens[0].id;
  }
  if (action === 'next') {
    return screens[(index + 1) % screens.length].id;
  }
  return screens[(index - 1 + screens.length) % screens.length].id;
}

export const TUI_FOOTER = 'n next screen   p prev screen   r re-read   q quit';

/** The full frame: header, the screen's rows, then the footer. */
export function frameLines(screen: TuiScreen, readAtIso: string): readonly string[] {
  const header = `fleet-v2 tui - ${screen.title} - read ${readAtIso.slice(11, 16)}`;
  return [header, ...screen.rows, TUI_FOOTER];
}
