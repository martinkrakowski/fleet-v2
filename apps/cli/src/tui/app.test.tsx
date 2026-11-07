// TUI view tests — P9.
import { describe, expect, it } from 'vitest';
import { renderToString } from 'ink';

import { TuiApp } from './app.js';

describe('TuiApp', () => {
  it('renders the header, rows and footer', () => {
    const output = renderToString(
      <TuiApp
        title="Runs"
        rows={['row one', 'row two']}
        readAtIso="2026-11-03T10:04:00.000Z"
        onAction={() => {}}
      />,
    );
    expect(output).toContain('fleet-v2 tui - Runs - read 10:04');
    expect(output).toContain('row one');
    expect(output).toContain('row two');
    expect(output).toContain('n next screen   p prev screen   r re-read   q quit');
  });
});
