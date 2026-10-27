// @generated value-object stub — refined for migration step 2.
/**
 * AcceptanceSpec is the gate a lane must pass, frozen into the brief manifest
 * and covered by its digest: a commit since the base, a clean lane diff check,
 * and fixed argv commands, each optionally declaring the coverage it must
 * show. Each command is an argv array; no shell string.
 */

export type GateCoverageReader = 'vitest-summary' | 'hexagen-lint-json' | 'eslint-json';
export type GateCoverageUnitKind = 'tests' | 'files' | 'checks';

/** Mirrors evidence-and-acceptance's COVERAGE_READER_UNIT_KINDS (V2a); S2b adds a parity test. */
export const GATE_COVERAGE_READER_UNIT_KINDS: Readonly<Record<GateCoverageReader, GateCoverageUnitKind>> = {
  'vitest-summary': 'tests',
  'hexagen-lint-json': 'files',
  'eslint-json': 'files',
};

export interface GateCommandCoverage {
  readonly reader: GateCoverageReader;
  readonly unitKind: GateCoverageUnitKind;
  readonly minUnits: number;
}

export interface GateCommand {
  readonly argv: readonly string[];
  readonly coverage?: GateCommandCoverage;
}

export interface AcceptanceSpecProps {
  readonly commitRequired: true;
  readonly diffCheck: true;
  readonly commands: readonly GateCommand[];
}

export const MAX_GATE_COMMANDS = 20;
export const MAX_GATE_ARGV_ENTRIES = 64;
export const MAX_GATE_ARG_CHARACTERS = 4096;

const SHELL_BASENAMES: readonly string[] = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh'];

function coverageError(value: unknown, n: number): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return `AcceptanceSpec command ${n} coverage must be { reader, unitKind, minUnits }`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 3 || keys.indexOf('reader') === -1 || keys.indexOf('unitKind') === -1 || keys.indexOf('minUnits') === -1) {
    return `AcceptanceSpec command ${n} coverage must be { reader, unitKind, minUnits }`;
  }
  const reader = record.reader;
  if (
    typeof reader !== 'string' ||
    !Object.prototype.hasOwnProperty.call(GATE_COVERAGE_READER_UNIT_KINDS, reader)
  ) {
    return `AcceptanceSpec command ${n} names an unknown coverage reader`;
  }
  if (record.unitKind !== GATE_COVERAGE_READER_UNIT_KINDS[reader as GateCoverageReader]) {
    return `AcceptanceSpec command ${n} coverage unitKind does not match its reader`;
  }
  const minUnits = record.minUnits;
  if (typeof minUnits !== 'number' || !Number.isSafeInteger(minUnits) || minUnits < 1) {
    return `AcceptanceSpec command ${n} coverage minUnits must be a whole number of at least 1`;
  }
  return null;
}

function commandError(value: unknown, n: number): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return `AcceptanceSpec command ${n} must be an object with argv and optional coverage`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    const key = keys[keyIndex];
    if (key !== 'argv' && key !== 'coverage') {
      return `AcceptanceSpec command ${n} has an unknown key: ${key}`;
    }
  }
  const argv = record.argv;
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_GATE_ARGV_ENTRIES) {
    return `AcceptanceSpec command ${n} argv must hold 1 to 64 strings`;
  }
  for (let entryIndex = 0; entryIndex < argv.length; entryIndex += 1) {
    const entry = argv[entryIndex];
    if (
      typeof entry !== 'string' ||
      entry.length > MAX_GATE_ARG_CHARACTERS ||
      entry.includes(String.fromCodePoint(0))
    ) {
      return `AcceptanceSpec command ${n} argv entries must be strings of at most 4096 characters without NUL`;
    }
  }
  const program = argv[0] as string;
  if (program === '' || program !== program.trim() || program.startsWith('-')) {
    return `AcceptanceSpec command ${n} argv[0] must name a program`;
  }
  if (argv.length === 1 && program.includes(' ')) {
    return `AcceptanceSpec command ${n} looks like a shell string; give each argument its own argv entry`;
  }
  const lastSegment = program.slice(program.lastIndexOf('/') + 1);
  if (SHELL_BASENAMES.indexOf(lastSegment) !== -1) {
    return `AcceptanceSpec command ${n} must not run a shell`;
  }
  if (record.coverage !== undefined) {
    return coverageError(record.coverage, n);
  }
  return null;
}

export class AcceptanceSpec {
  private constructor(private readonly props: AcceptanceSpecProps) {}

  /** Validates untyped input (CLI and stored manifests); never throws. */
  static create(input: unknown): { success: boolean; value?: AcceptanceSpec; error?: Error } {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return { success: false, error: new Error('AcceptanceSpec must be an object') };
    }
    const record = input as Record<string, unknown>;
    const keys = Object.keys(record);
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
      const key = keys[keyIndex];
      if (key !== 'commitRequired' && key !== 'diffCheck' && key !== 'commands') {
        return { success: false, error: new Error(`AcceptanceSpec has an unknown key: ${key}`) };
      }
    }
    if (record.commitRequired !== true) {
      return { success: false, error: new Error('AcceptanceSpec requires commitRequired: true') };
    }
    if (record.diffCheck !== true) {
      return { success: false, error: new Error('AcceptanceSpec requires diffCheck: true') };
    }
    if (!Array.isArray(record.commands) || record.commands.length < 1 || record.commands.length > MAX_GATE_COMMANDS) {
      return { success: false, error: new Error('AcceptanceSpec requires 1 to 20 commands') };
    }
    const commands: GateCommand[] = [];
    for (let index = 0; index < record.commands.length; index += 1) {
      const n = index + 1;
      const error = commandError(record.commands[index], n);
      if (error !== null) {
        return { success: false, error: new Error(error) };
      }
      const rawCommand = record.commands[index] as Record<string, unknown>;
      const argv = [...(rawCommand.argv as string[])];
      const command: GateCommand =
        rawCommand.coverage === undefined
          ? { argv }
          : {
              argv,
              coverage: {
                reader: (rawCommand.coverage as Record<string, unknown>).reader as GateCoverageReader,
                unitKind: (rawCommand.coverage as Record<string, unknown>).unitKind as GateCoverageUnitKind,
                minUnits: (rawCommand.coverage as Record<string, unknown>).minUnits as number,
              },
            };
      commands.push(command);
    }
    const props: AcceptanceSpecProps = { commitRequired: true, diffCheck: true, commands };
    return { success: true, value: new AcceptanceSpec(props) };
  }

  getCommitRequired(): true {
    return this.props.commitRequired;
  }

  getDiffCheck(): true {
    return this.props.diffCheck;
  }

  /** Fresh copies, so a caller cannot change the validated spec through the getter. */
  getCommands(): readonly GateCommand[] {
    return this.toJSON().commands;
  }

  /** Canonical plain form: key order commitRequired, diffCheck, commands; each command argv then coverage (reader, unitKind, minUnits); fresh arrays. */
  toJSON(): AcceptanceSpecProps {
    return {
      commitRequired: this.props.commitRequired,
      diffCheck: this.props.diffCheck,
      commands: this.props.commands.map((command) => ({
        argv: [...command.argv],
        ...(command.coverage === undefined ? {} : { coverage: { ...command.coverage } }),
      })),
    };
  }

  getProps(): AcceptanceSpecProps {
    return this.toJSON();
  }

  equals(other: AcceptanceSpec): boolean {
    return JSON.stringify(this.toJSON()) === JSON.stringify(other.toJSON());
  }
}
