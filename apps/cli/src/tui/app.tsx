/**
 * The TUI view: one thin Ink component that renders the frame lines and maps
 * keys to actions. It writes nothing itself — all behaviour arrives through
 * props. On an input screen (`onRawInput` given), a key that is not a shell
 * action, or every key while `capturing`, goes to `onRawInput`, so typing a
 * reason never triggers n/p/r/q.
 */
import { Box, Text } from 'ink';
import { useInput } from 'ink';

import type { TuiKey } from './input.js';
import { frameLines, tuiActionFor, type TuiAction } from './shell.js';

export interface TuiAppProps {
  readonly title: string;
  readonly rows: readonly string[];
  readonly readAtIso: string;
  readonly onAction: (action: TuiAction) => void;
  /** Lines of an interactive screen; when set they replace `rows`. */
  readonly inputLines?: readonly string[];
  /** Receives raw keys on an interactive screen. */
  readonly onRawInput?: (key: TuiKey) => void;
  /** True while the interactive screen owns the keyboard (text entry, confirmation). */
  readonly capturing?: boolean;
}

export function TuiApp(props: TuiAppProps) {
  useInput((input, key) => {
    const raw: TuiKey = {
      input,
      upArrow: key.upArrow,
      downArrow: key.downArrow,
      return: key.return,
      escape: key.escape,
      backspace: key.backspace,
      delete: key.delete,
    };
    if (props.onRawInput !== undefined && props.capturing === true) {
      props.onRawInput(raw);
      return;
    }
    const action = tuiActionFor(input);
    if (action !== 'none') {
      props.onAction(action);
      return;
    }
    props.onRawInput?.(raw);
  });

  const rows = props.inputLines ?? props.rows;
  const lines = frameLines({ id: '', title: props.title, rows }, props.readAtIso);

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={index}>{line}</Text>
      ))}
    </Box>
  );
}
