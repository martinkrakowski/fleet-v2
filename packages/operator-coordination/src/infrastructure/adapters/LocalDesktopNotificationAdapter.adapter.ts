/**
 * LocalDesktopNotificationAdapter implements OwnerNotificationDeliveryPort
 * over one macOS desktop notification (`/usr/bin/osascript`). The message
 * body and title travel as their own argv words — no text is ever
 * interpolated into an AppleScript source string and no shell is used. A
 * channel that cannot deliver (a non-macOS host, a failed call) is a value,
 * never a throw.
 */

import { spawn } from 'node:child_process';

import type {
  OwnerNotificationDeliveryOutcome,
  OwnerNotificationDeliveryPort,
  OwnerNotificationMessage,
} from '../../application/ports/out/OwnerNotificationDeliveryPort.out-port.js';

/** The macOS notifier binary the adapter calls. */
export const MACOS_NOTIFIER_PATH = '/usr/bin/osascript';

/**
 * The frozen argv prefix: an AppleScript run block that displays a
 * notification from the first argv word with the second as its title.
 */
export const MACOS_NOTIFICATION_ARGV_PREFIX = [
  '-e',
  'on run argv',
  '-e',
  'display notification (item 1 of argv) with title (item 2 of argv)',
  '-e',
  'end run',
] as const;

/**
 * The runner boundary: spawn the binary and report its exit, never reject.
 * `error` carries a spawn failure message; `exitCode` is null then.
 */
export type DesktopNotificationRunner = (
  file: string,
  args: readonly string[],
) => Promise<{ exitCode: number | null; error?: string }>;

export interface LocalDesktopNotificationAdapterOptions {
  /** Overrides the default spawned runner; tests inject this. */
  readonly run?: DesktopNotificationRunner;
  /** Overrides `process.platform`; tests inject this. */
  readonly platform?: string;
}

const UNAVAILABLE_NON_MACOS = 'desktop notifications need macOS';
const UNAVAILABLE_CALL_FAILED = 'the desktop notification call did not succeed';
const MINIMAL_ENVIRONMENT = Object.freeze({ PATH: '/usr/bin:/bin' });

/** The default runner: one spawned process, minimal environment, never rejects. */
function defaultRunner(file: string, args: readonly string[]): Promise<{
  exitCode: number | null;
  error?: string;
}> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, [...args], { stdio: 'ignore', env: { ...MINIMAL_ENVIRONMENT } });
    } catch (error) {
      resolve({ exitCode: null, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    child.on('error', (error: Error) => {
      resolve({ exitCode: null, error: error.message });
    });
    child.on('close', (exitCode: number | null) => {
      resolve({ exitCode });
    });
  });
}

export class LocalDesktopNotificationAdapter implements OwnerNotificationDeliveryPort {
  constructor(private readonly options: LocalDesktopNotificationAdapterOptions = {}) {}

  async deliverOwnerNotification(
    message: OwnerNotificationMessage,
  ): Promise<OwnerNotificationDeliveryOutcome> {
    const platform = this.options.platform ?? process.platform;
    if (platform !== 'darwin') {
      return { outcome: 'unavailable', reason: UNAVAILABLE_NON_MACOS };
    }
    const run = this.options.run ?? defaultRunner;
    try {
      const result = await run(MACOS_NOTIFIER_PATH, [
        ...MACOS_NOTIFICATION_ARGV_PREFIX,
        message.body,
        message.title,
      ]);
      if (result.error !== undefined || result.exitCode !== 0) {
        return { outcome: 'unavailable', reason: UNAVAILABLE_CALL_FAILED };
      }
      return { outcome: 'delivered' };
    } catch {
      return { outcome: 'unavailable', reason: UNAVAILABLE_CALL_FAILED };
    }
  }
}
