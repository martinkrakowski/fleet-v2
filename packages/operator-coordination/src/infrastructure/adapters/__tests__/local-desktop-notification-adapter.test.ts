/**
 * Lane E4 part 1 unit tests for LocalDesktopNotificationAdapter.
 *
 * The argv contract: the body and the title travel as their own argv words
 * after the frozen osascript prefix, so no text is ever interpolated into an
 * AppleScript source string and no shell is used. A non-macOS platform and a
 * failed call are unavailable values, never throws.
 */

import { describe, expect, it } from 'vitest';

import {
  MACOS_NOTIFICATION_ARGV_PREFIX,
  MACOS_NOTIFIER_PATH,
  LocalDesktopNotificationAdapter,
  type DesktopNotificationRunner,
} from '../LocalDesktopNotificationAdapter.adapter.js';

const PREFIX = [...MACOS_NOTIFICATION_ARGV_PREFIX];

describe('LocalDesktopNotificationAdapter', () => {
  it('calls the runner with the osascript path and the exact argv on darwin', async () => {
    const calls: { file: string; args: readonly string[] }[] = [];
    const run: DesktopNotificationRunner = async (file, args) => {
      calls.push({ file, args });
      return { exitCode: 0 };
    };
    const adapter = new LocalDesktopNotificationAdapter({ run, platform: 'darwin' });
    const outcome = await adapter.deliverOwnerNotification({
      title: 'Fleet',
      body: 'Attempt attempt-a1 ended: collect is available',
    });
    expect(outcome).toEqual({ outcome: 'delivered' });
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe(MACOS_NOTIFIER_PATH);
    expect([...calls[0].args]).toEqual([
      ...PREFIX,
      'Attempt attempt-a1 ended: collect is available',
      'Fleet',
    ]);
  });

  it('keeps a body with quotes as one argv word', async () => {
    const calls: { file: string; args: readonly string[] }[] = [];
    const run: DesktopNotificationRunner = async (file, args) => {
      calls.push({ file, args });
      return { exitCode: 0 };
    };
    const adapter = new LocalDesktopNotificationAdapter({ run, platform: 'darwin' });
    const body = `he said "collect" and it's done; rm -rf /tmp/nothing`;
    const outcome = await adapter.deliverOwnerNotification({ title: 'Fleet', body });
    expect(outcome).toEqual({ outcome: 'delivered' });
    expect(calls).toHaveLength(1);
    expect(calls[0].args[calls[0].args.length - 2]).toBe(body);
    expect([...calls[0].args]).toHaveLength(PREFIX.length + 2);
  });

  it('never calls the runner on a platform other than darwin', async () => {
    let calls = 0;
    const run: DesktopNotificationRunner = async () => {
      calls += 1;
      return { exitCode: 0 };
    };
    for (const platform of ['linux', 'win32', 'freebsd']) {
      const adapter = new LocalDesktopNotificationAdapter({ run, platform });
      const outcome = await adapter.deliverOwnerNotification({
        title: 'Fleet',
        body: 'Attempt attempt-a1 ended: collect is available',
      });
      expect(outcome).toEqual({
        outcome: 'unavailable',
        reason: 'desktop notifications need macOS',
      });
    }
    expect(calls).toBe(0);
  });

  it('reports unavailable for a non-zero exit and for a throwing runner', async () => {
    const failing: DesktopNotificationRunner = async () => ({ exitCode: 1 });
    const failingAdapter = new LocalDesktopNotificationAdapter({ run: failing, platform: 'darwin' });
    await expect(
      failingAdapter.deliverOwnerNotification({ title: 'Fleet', body: 'body' }),
    ).resolves.toEqual({
      outcome: 'unavailable',
      reason: 'the desktop notification call did not succeed',
    });

    const spawnError: DesktopNotificationRunner = async () => ({
      exitCode: null,
      error: 'spawn /usr/bin/osascript ENOENT',
    });
    const spawnAdapter = new LocalDesktopNotificationAdapter({ run: spawnError, platform: 'darwin' });
    await expect(
      spawnAdapter.deliverOwnerNotification({ title: 'Fleet', body: 'body' }),
    ).resolves.toEqual({
      outcome: 'unavailable',
      reason: 'the desktop notification call did not succeed',
    });

    const throwing: DesktopNotificationRunner = async () => {
      throw new Error('the runner exploded');
    };
    const throwingAdapter = new LocalDesktopNotificationAdapter({
      run: throwing,
      platform: 'darwin',
    });
    await expect(
      throwingAdapter.deliverOwnerNotification({ title: 'Fleet', body: 'body' }),
    ).resolves.toEqual({
      outcome: 'unavailable',
      reason: 'the desktop notification call did not succeed',
    });
  });
});
