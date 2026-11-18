/**
 * ManageDaemonSchedulerUseCase: render the daemon tick's user-scope scheduler
 * units (systemd service and timer) and, per action, read, write or remove the
 * pair through the scheduler port (CO6). The port only ever returns codes; the
 * use case maps them to the CLI's codes and supplies the install-only operator
 * enable/linger hint lines. It renders no command, starts no process and never
 * enables a unit.
 */

import {
  DAEMON_SERVICE_UNIT_KEY,
  DAEMON_TIMER_UNIT_KEY,
  SHADOW_INTAKE_SERVICE_UNIT_KEY,
  SHADOW_INTAKE_TIMER_UNIT_KEY,
  SHADOW_RECORD_DAY_SERVICE_UNIT_KEY,
  SHADOW_RECORD_DAY_TIMER_UNIT_KEY,
} from '../ports/out/DaemonSchedulerPort.out-port.js';
import type { DaemonSchedulerPort } from '../ports/out/DaemonSchedulerPort.out-port.js';
import { containsSecretShape } from '@fleet/shared';
import type {
  ManageDaemonSchedulerPort,
  ManageDaemonSchedulerRequest,
  ManageDaemonSchedulerResult,
  ManageDaemonSchedulerUnitLine,
} from '../ports/in/ManageDaemonSchedulerPort.in-port.js';

/** Cap on the own keys read from one shadow config object; linear cost. */
export const MAX_SHADOW_CONFIG_KEYS = 8;
/** Cap on one shadow config value's length before validation; linear cost. */
export const MAX_SHADOW_CONFIG_VALUE_LENGTH = 4096;

/** Characters a shadow config value never carries: whitespace, `%`, `$`, quotes, backslash. */
const SHADOW_VALUE_REFUSED_PATTERN = /[\s%$'"\\]/;

/** The own keys a shadow config object never carries (prototype pollution). */
const SHADOW_PROTOTYPE_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

export const DAEMON_SERVICE_TEMPLATE = `[Unit]
Description=Fleet v2 daemon tick

[Service]
Type=oneshot
ExecStart={{nodePath}} {{cliPath}} --state-dir {{stateDir}} daemon tick
Environment=FLEET_STATE_DIR={{stateDir}}
Environment=FLEET_INSTALLATION_FILE={{installationFile}}
Nice=5
`;

export const DAEMON_TIMER_TEMPLATE = `[Unit]
Description=Fleet v2 daemon tick timer

[Timer]
Unit=fleet-v2-daemon.service
OnBootSec=60s
OnUnitActiveSec=60s
AccuracySec=1s
Persistent=true

[Install]
WantedBy=timers.target
`;

export interface RenderedDaemonUnits {
  readonly service: string;
  readonly timer: string;
}

export interface RenderedShadowIntakeUnits {
  readonly service: string;
  readonly timer: string;
}

export interface RenderedShadowRecordDayUnits {
  readonly service: string;
  readonly timer: string;
}

export const SHADOW_INTAKE_SERVICE_TEMPLATE = `[Unit]
Description=Fleet v2 shadow intake

[Service]
Type=oneshot
ExecStart={{nodePath}} {{cliPath}} --state-dir {{stateDir}} merge import --repository {{repository}} --legacy-state-dir {{legacyStateDir}} --apply --project {{projectId}} --scheduled
Environment=FLEET_STATE_DIR={{stateDir}}
Environment=FLEET_INSTALLATION_FILE={{installationFile}}
Nice=5
`;

export const SHADOW_INTAKE_TIMER_TEMPLATE = `[Unit]
Description=Fleet v2 shadow intake timer

[Timer]
Unit=fleet-v2-shadow-intake.service
OnBootSec=120s
OnUnitActiveSec=180s
AccuracySec=5s
Persistent=true

[Install]
WantedBy=timers.target
`;

export const SHADOW_RECORD_DAY_SERVICE_TEMPLATE = `[Unit]
Description=Fleet v2 shadow record-day

[Service]
Type=oneshot
ExecStart={{nodePath}} {{cliPath}} --state-dir {{stateDir}} cutover shadow record-day --repository {{repository}} --legacy-state-dir {{legacyStateDir}} --scheduled
Environment=FLEET_STATE_DIR={{stateDir}}
Environment=FLEET_INSTALLATION_FILE={{installationFile}}
Nice=5
`;

export const SHADOW_RECORD_DAY_TIMER_TEMPLATE = `[Unit]
Description=Fleet v2 shadow record-day timer

[Timer]
Unit=fleet-v2-shadow-record-day.service
OnCalendar=*-*-* 00:20:00 UTC
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
`;

/** One validated shadow scheduler config value. */
export interface ShadowSchedulerConfig {
  readonly repository: string;
  readonly legacyStateDir: string;
  readonly projectId: string;
}

export type ShadowSchedulerConfigRead =
  | { readonly ok: true; readonly config: ShadowSchedulerConfig }
  | { readonly ok: false; readonly reason: 'invalid-shadow-config' };

/**
 * Pure, hostile-input-safe validation of the shadow scheduler config
 * (OD7a1). It reads own enumerable data-property descriptors only — a getter
 * or a Proxy `get` trap never runs — and its cost is linear in the capped
 * input: at most `MAX_SHADOW_CONFIG_KEYS` own keys, each value at most
 * `MAX_SHADOW_CONFIG_VALUE_LENGTH` code units, each tested once. It never
 * throws; every refusal is `{ ok: false, reason: 'invalid-shadow-config' }`
 * and the input value is never echoed. Each of `repository`, `legacyStateDir`
 * and `projectId` must be a non-empty string carrying no whitespace, `%`,
 * `$`, quote or backslash — the ExecStart substitution rule — and must not
 * match the repository's secret-shaped detector (`containsSecretShape`):
 * a credential-shaped value is refused, never rendered. The object
 * must be a plain record with exactly those three own keys. A prototype-
 * polluting own key, an array, a sparse or array-like input is refused.
 */
export function readShadowSchedulerConfig(
  input: unknown,
): ShadowSchedulerConfigRead {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, reason: 'invalid-shadow-config' };
  }
  const names = Object.keys(input);
  if (names.length !== 3) {
    return { ok: false, reason: 'invalid-shadow-config' };
  }
  const snapshot: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const name of names) {
    if (SHADOW_PROTOTYPE_KEYS.has(name)) {
      return { ok: false, reason: 'invalid-shadow-config' };
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      return { ok: false, reason: 'invalid-shadow-config' };
    }
    snapshot[name] = descriptor.value;
  }
  const config: Record<string, string> = {};
  for (const key of ['repository', 'legacyStateDir', 'projectId'] as const) {
    const value = snapshot[key];
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > MAX_SHADOW_CONFIG_VALUE_LENGTH ||
      SHADOW_VALUE_REFUSED_PATTERN.test(value) ||
      // A secret-shaped value that avoids the substitution characters would
      // otherwise be rendered into `ExecStart`; screen every unit text value
      // (including paths) with the repository's existing detector.
      containsSecretShape(value)
    ) {
      return { ok: false, reason: 'invalid-shadow-config' };
    }
    config[key] = value;
  }
  return {
    ok: true,
    config: {
      repository: config['repository']!,
      legacyStateDir: config['legacyStateDir']!,
      projectId: config['projectId']!,
    },
  };
}

/** Substitute the placeholders of the validated shadow intake config. */
export function renderShadowIntakeUnits(
  facts: ManageDaemonSchedulerRequest['daemon'],
  config: ShadowSchedulerConfig,
): RenderedShadowIntakeUnits {
  // Function replacements keep the values literal: string replacements would
  // run `GetSubstitution` on `$` sequences; the substitution rule already
  // refuses `$` in the config values, and the facts keep the daemon rule.
  const service = SHADOW_INTAKE_SERVICE_TEMPLATE
    .replaceAll('{{nodePath}}', () => facts.nodePath)
    .replaceAll('{{cliPath}}', () => facts.cliPath)
    .replaceAll('{{stateDir}}', () => facts.stateDir)
    .replaceAll('{{installationFile}}', () => facts.installationFile)
    .replaceAll('{{repository}}', () => config.repository)
    .replaceAll('{{legacyStateDir}}', () => config.legacyStateDir)
    .replaceAll('{{projectId}}', () => config.projectId);
  return { service, timer: SHADOW_INTAKE_TIMER_TEMPLATE };
}

/** Substitute the placeholders of the validated shadow record-day config (OD7a2). */
export function renderShadowRecordDayUnits(
  facts: ManageDaemonSchedulerRequest['daemon'],
  config: ShadowSchedulerConfig,
): RenderedShadowRecordDayUnits {
  // The same function-replacement rule as the intake units: values stay
  // literal and the substitution rule already refuses `$` in them.
  const service = SHADOW_RECORD_DAY_SERVICE_TEMPLATE
    .replaceAll('{{nodePath}}', () => facts.nodePath)
    .replaceAll('{{cliPath}}', () => facts.cliPath)
    .replaceAll('{{stateDir}}', () => facts.stateDir)
    .replaceAll('{{installationFile}}', () => facts.installationFile)
    .replaceAll('{{repository}}', () => config.repository)
    .replaceAll('{{legacyStateDir}}', () => config.legacyStateDir);
  return { service, timer: SHADOW_RECORD_DAY_TIMER_TEMPLATE };
}

/** Substitute the five placeholders of the validated `daemon` section. */
export function renderDaemonUnits(
  facts: ManageDaemonSchedulerRequest['daemon'],
): RenderedDaemonUnits {
  // Function replacements keep the facts literal: string replacements would
  // run `GetSubstitution`, turning `$$` into `$` and `$&` into the matched
  // placeholder text.
  const service = DAEMON_SERVICE_TEMPLATE
    .replaceAll('{{nodePath}}', () => facts.nodePath)
    .replaceAll('{{cliPath}}', () => facts.cliPath)
    .replaceAll('{{stateDir}}', () => facts.stateDir)
    .replaceAll('{{installationFile}}', () => facts.installationFile);
  return { service, timer: DAEMON_TIMER_TEMPLATE };
}

const INSTALL_OPERATOR_LINES: readonly string[] = [
  'enable: systemctl --user enable fleet-v2-daemon.timer',
  'linger: loginctl enable-linger',
];

const SHADOW_ENABLE_OPERATOR_LINE =
  'enable: systemctl --user enable fleet-v2-shadow-intake.timer';

/** OD7a2: the record-day timer is enabled alongside the intake timer. */
const SHADOW_RECORD_DAY_ENABLE_OPERATOR_LINE =
  'enable: systemctl --user enable fleet-v2-shadow-record-day.timer';

/** Install without `--apply`: only unchanged stays unchanged. */
function installDryRunCode(code: string): string {
  if (code === 'unchanged' || code === 'unreadable') {
    return code;
  }
  return 'would-write';
}

/** Uninstall without `--apply`: only absent stays absent. */
function uninstallDryRunCode(code: string): string {
  if (code === 'absent' || code === 'unreadable') {
    return code;
  }
  return 'would-remove';
}

export class ManageDaemonSchedulerUseCase implements ManageDaemonSchedulerPort {
  constructor(
    private readonly deps: { readonly scheduler: DaemonSchedulerPort },
  ) {}

  async execute(
    request: ManageDaemonSchedulerRequest,
  ): Promise<ManageDaemonSchedulerResult> {
    const shadow =
      request.daemon.shadow !== undefined
        ? readShadowSchedulerConfig(request.daemon.shadow)
        : undefined;
    if (shadow !== undefined && !shadow.ok) {
      // The typed refusal: no unit is rendered, read, written or removed.
      return { units: [], operatorLines: null, refusal: shadow.reason };
    }
    const config = shadow?.ok === true ? shadow.config : undefined;
    const rendered = renderDaemonUnits(request.daemon);
    const shadowIntake =
      config !== undefined
        ? renderShadowIntakeUnits(request.daemon, config)
        : undefined;
    const shadowRecordDay =
      config !== undefined
        ? renderShadowRecordDayUnits(request.daemon, config)
        : undefined;
    const portInput = {
      ...rendered,
      ...(shadowIntake !== undefined ? { shadowIntake } : {}),
      ...(shadowRecordDay !== undefined ? { shadowRecordDay } : {}),
    };

    if (request.action === 'install') {
      const operatorLines =
        shadowIntake === undefined
          ? INSTALL_OPERATOR_LINES
          : [
              ...INSTALL_OPERATOR_LINES,
              SHADOW_ENABLE_OPERATOR_LINE,
              // OD7a2: the record-day timer is enabled with the intake timer.
              SHADOW_RECORD_DAY_ENABLE_OPERATOR_LINE,
            ];
      if (request.apply) {
        const result = await this.safeWrite(portInput);
        return {
          units: shadowUnitLines(result, config !== undefined),
          operatorLines,
        };
      }
      const result = await this.safeRead(portInput);
      return {
        units: shadowUnitLines(result, config !== undefined, installDryRunCode),
        operatorLines,
      };
    }

    if (request.action === 'show') {
      const result = await this.safeRead(portInput);
      return {
        units: shadowUnitLines(result, config !== undefined),
        operatorLines: null,
      };
    }

    if (request.apply) {
      const result = await this.safeRemove();
      // OD7a1 fix round 2: the port always removes the intake pair, even when
      // the rendered facts carried none (shadow off), so its codes are not in
      // `units` here. An intake removal that is `unreadable` must be surfaced
      // typed or the command would print two `absent` lines and exit 0.
      // OD7a2: the same holds for the record-day pair, which the port also
      // always removes.
      const intakeUnreadable =
        (shadowIntake === undefined &&
          result.shadowIntake !== undefined &&
          (result.shadowIntake.service === 'unreadable' ||
            result.shadowIntake.timer === 'unreadable')) ||
        (shadowRecordDay === undefined &&
          result.shadowRecordDay !== undefined &&
          (result.shadowRecordDay.service === 'unreadable' ||
            result.shadowRecordDay.timer === 'unreadable'));
      return {
        units: shadowUnitLines(result, config !== undefined),
        operatorLines: null,
        ...(intakeUnreadable ? { intakeUnreadable: true } : {}),
      };
    }

    const result = await this.safeRead(portInput);
    return {
      units: shadowUnitLines(result, config !== undefined, uninstallDryRunCode),
      operatorLines: null,
    };
  }

  /**
   * A port rejection or a missing port method is a typed `'unreadable'` for
   * every affected unit, never a thrown error and never unknown-as-success.
   */
  private async safeRead(
    input: Parameters<DaemonSchedulerPort['read']>[0],
  ): Promise<Awaited<ReturnType<DaemonSchedulerPort['read']>>> {
    if (typeof this.deps.scheduler.read !== 'function') {
      return unreadableFrom(input);
    }
    try {
      return await this.deps.scheduler.read(input);
    } catch {
      return unreadableFrom(input);
    }
  }

  private async safeWrite(
    input: Parameters<DaemonSchedulerPort['write']>[0],
  ): Promise<Awaited<ReturnType<DaemonSchedulerPort['write']>>> {
    if (typeof this.deps.scheduler.write !== 'function') {
      return unreadableFrom(input);
    }
    try {
      return await this.deps.scheduler.write(input);
    } catch {
      return unreadableFrom(input);
    }
  }

  private async safeRemove(): Promise<
    Awaited<ReturnType<DaemonSchedulerPort['remove']>>
  > {
    const allUnreadable = {
      service: 'unreadable',
      timer: 'unreadable',
      shadowIntake: { service: 'unreadable', timer: 'unreadable' },
      shadowRecordDay: { service: 'unreadable', timer: 'unreadable' },
    } as const;
    if (typeof this.deps.scheduler.remove !== 'function') {
      return allUnreadable;
    }
    try {
      return await this.deps.scheduler.remove();
    } catch {
      return allUnreadable;
    }
  }
}

/** Map a rendered input to the all-unreadable result of its own shape. */
function unreadableFrom(input: {
  readonly service: string;
  readonly timer: string;
  readonly shadowIntake?:
    | { readonly service: string; readonly timer: string }
    | undefined;
  readonly shadowRecordDay?:
    | { readonly service: string; readonly timer: string }
    | undefined;
}): {
  readonly service: 'unreadable';
  readonly timer: 'unreadable';
  readonly shadowIntake?:
    | { readonly service: 'unreadable'; readonly timer: 'unreadable' }
    | undefined;
  readonly shadowRecordDay?:
    | { readonly service: 'unreadable'; readonly timer: 'unreadable' }
    | undefined;
} {
  return {
    service: 'unreadable',
    timer: 'unreadable',
    ...(input.shadowIntake === undefined
      ? {}
      : { shadowIntake: { service: 'unreadable', timer: 'unreadable' } }),
    ...(input.shadowRecordDay === undefined
      ? {}
      : { shadowRecordDay: { service: 'unreadable', timer: 'unreadable' } }),
  };
}

/** The main pair's lines, then the shadow pairs' when present (OD7a2 adds the record-day pair). */
function shadowUnitLines(
  result: {
    readonly service: string;
    readonly timer: string;
    readonly shadowIntake?:
      | { readonly service: string; readonly timer: string }
      | undefined;
    readonly shadowRecordDay?:
      | { readonly service: string; readonly timer: string }
      | undefined;
  },
  includeShadow: boolean,
  map?: (code: string) => string,
): ManageDaemonSchedulerUnitLine[] {
  const lines: ManageDaemonSchedulerUnitLine[] = [
    { key: DAEMON_SERVICE_UNIT_KEY, code: map ? map(result.service) : result.service },
    { key: DAEMON_TIMER_UNIT_KEY, code: map ? map(result.timer) : result.timer },
  ];
  if (includeShadow) {
    // OD7a1 fix round 3: a scheduler that returns only the main pair's codes
    // (no `shadowIntake` codes) must not let the intake pair be silently
    // omitted: with shadow requested, any MISSING intake code is reported as
    // `unreadable` so the CLI exits 1 instead of 0. OD7a2 applies the same
    // rule to the record-day pair.
    const intakeService =
      result.shadowIntake === undefined ? 'unreadable' : result.shadowIntake.service;
    const intakeTimer =
      result.shadowIntake === undefined ? 'unreadable' : result.shadowIntake.timer;
    const recordDayService =
      result.shadowRecordDay === undefined ? 'unreadable' : result.shadowRecordDay.service;
    const recordDayTimer =
      result.shadowRecordDay === undefined ? 'unreadable' : result.shadowRecordDay.timer;
    lines.push(
      {
        key: SHADOW_INTAKE_SERVICE_UNIT_KEY,
        code: map ? map(intakeService) : intakeService,
      },
      {
        key: SHADOW_INTAKE_TIMER_UNIT_KEY,
        code: map ? map(intakeTimer) : intakeTimer,
      },
      {
        key: SHADOW_RECORD_DAY_SERVICE_UNIT_KEY,
        code: map ? map(recordDayService) : recordDayService,
      },
      {
        key: SHADOW_RECORD_DAY_TIMER_UNIT_KEY,
        code: map ? map(recordDayTimer) : recordDayTimer,
      },
    );
  }
  return lines;
}
