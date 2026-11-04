/**
 * The TUI view: one thin Ink component that renders the frame lines and maps
 * keys to actions. It writes nothing itself — all behaviour arrives through
 * props.
 */
import { Box, Text } from 'ink';
import { useInput } from 'ink';

import { frameLines, tuiActionFor, type TuiAction } from './shell.js';

export interface TuiAppProps {
  readonly title: string;
  readonly rows: readonly string[];
  readonly readAtIso: string;
  readonly onAction: (action: TuiAction) => void;
}

export function TuiApp(props: TuiAppProps) {
  useInput((input) => {
    const action = tuiActionFor(input);
    if (action !== 'none') {
      props.onAction(action);
    }
  });

  const lines = frameLines({ id: '', title: props.title, rows: props.rows }, props.readAtIso);

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={index}>{line}</Text>
      ))}
    </Box>
  );
}
