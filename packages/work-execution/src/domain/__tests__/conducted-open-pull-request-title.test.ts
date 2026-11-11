import { describe, expect, it } from 'vitest';

import { conductedOpenPullRequestTitle } from '../held-work-order.js';

describe('conductedOpenPullRequestTitle', () => {
  it('returns Fleet work order wo-example-1 when pullRequestTitle is absent', () => {
    expect(conductedOpenPullRequestTitle({}, 'wo-example-1')).toEqual({
      ok: true,
      title: 'Fleet work order wo-example-1',
    });
  });

  it('returns Fleet work order wo-example-2 when pullRequestTitle is absent on another id', () => {
    expect(conductedOpenPullRequestTitle({}, 'wo-example-2')).toEqual({
      ok: true,
      title: 'Fleet work order wo-example-2',
    });
  });

  it('returns the stored title Open the gate and not the generic fallback', () => {
    expect(conductedOpenPullRequestTitle({ pullRequestTitle: 'Open the gate' }, 'wo-example-1')).toEqual({
      ok: true,
      title: 'Open the gate',
    });
  });

  it("returns a stored title of 256 a's unchanged", () => {
    const title = 'a'.repeat(256);
    expect(conductedOpenPullRequestTitle({ pullRequestTitle: title }, 'wo-example-1')).toEqual({
      ok: true,
      title,
    });
  });

  it("refuses a stored title of 257 a's with invalid-pull-request-title", () => {
    const title = 'a'.repeat(257);
    expect(() => conductedOpenPullRequestTitle({ pullRequestTitle: title }, 'wo-example-1')).not.toThrow();
    expect(conductedOpenPullRequestTitle({ pullRequestTitle: title }, 'wo-example-1')).toEqual({
      ok: false,
      reason: 'invalid-pull-request-title',
    });
  });

  it('refuses a 10000 character title with invalid-pull-request-title', () => {
    const title = 'a'.repeat(10000);
    expect(() => conductedOpenPullRequestTitle({ pullRequestTitle: title }, 'wo-example-1')).not.toThrow();
    expect(conductedOpenPullRequestTitle({ pullRequestTitle: title }, 'wo-example-1')).toEqual({
      ok: false,
      reason: 'invalid-pull-request-title',
    });
  });

  it('refuses null, a leading space, an empty string, a newline, and a secret-shaped token with invalid-pull-request-title', () => {
    const values = [null, ' Open the gate', '', 'Open\nthe gate', 'ghp_' + 'a'.repeat(20)];
    for (const value of values) {
      expect(() => conductedOpenPullRequestTitle({ pullRequestTitle: value }, 'wo-example-1')).not.toThrow();
      expect(conductedOpenPullRequestTitle({ pullRequestTitle: value }, 'wo-example-1')).toEqual({
        ok: false,
        reason: 'invalid-pull-request-title',
      });
    }
  });

  it('refuses null and undefined work orders with invalid-pull-request-title and does not throw', () => {
    for (const workOrder of [null, undefined]) {
      expect(() => conductedOpenPullRequestTitle(workOrder, 'wo-example-1')).not.toThrow();
      expect(conductedOpenPullRequestTitle(workOrder, 'wo-example-1')).toEqual({
        ok: false,
        reason: 'invalid-pull-request-title',
      });
    }
  });

  it('refuses a non-string work order id with invalid-work-order-id and does not read the work order', () => {
    for (const id of [null, undefined, 1]) {
      let reads = 0;
      const workOrder = new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            reads += 1;
            throw new Error('should not be read');
          },
        },
      );
      expect(() => conductedOpenPullRequestTitle(workOrder, id)).not.toThrow();
      expect(conductedOpenPullRequestTitle(workOrder, id)).toEqual({
        ok: false,
        reason: 'invalid-work-order-id',
      });
      expect(reads).toBe(0);
    }
  });

  it('refuses a work order id longer than 128 characters with invalid-work-order-id', () => {
    const id = 'a'.repeat(129);
    expect(() => conductedOpenPullRequestTitle({}, id)).not.toThrow();
    expect(conductedOpenPullRequestTitle({}, id)).toEqual({
      ok: false,
      reason: 'invalid-work-order-id',
    });
  });

  it('refuses an accessor pullRequestTitle without calling the getter', () => {
    let calls = 0;
    const workOrder = {};
    Object.defineProperty(workOrder, 'pullRequestTitle', {
      get() {
        calls += 1;
        throw new Error('getter called');
      },
    });
    expect(() => conductedOpenPullRequestTitle(workOrder, 'wo-example-1')).not.toThrow();
    expect(conductedOpenPullRequestTitle(workOrder, 'wo-example-1')).toEqual({
      ok: false,
      reason: 'invalid-pull-request-title',
    });
    expect(calls).toBe(0);
  });

  it('refuses a Proxy whose getOwnPropertyDescriptor throws and does not throw', () => {
    const workOrder = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('trap threw');
        },
      },
    );
    expect(() => conductedOpenPullRequestTitle(workOrder, 'wo-example-1')).not.toThrow();
    expect(conductedOpenPullRequestTitle(workOrder, 'wo-example-1')).toEqual({
      ok: false,
      reason: 'invalid-pull-request-title',
    });
  });

  it('refuses an array work order with a hole and a throwing index getter without calling the getter', () => {
    let calls = 0;
    const workOrder: unknown[] = [];
    Object.defineProperty(workOrder, '0', {
      get() {
        calls += 1;
        throw new Error('index getter called');
      },
    });
    expect(() => conductedOpenPullRequestTitle(workOrder, 'wo-example-1')).not.toThrow();
    expect(conductedOpenPullRequestTitle(workOrder, 'wo-example-1')).toEqual({
      ok: false,
      reason: 'invalid-pull-request-title',
    });
    expect(calls).toBe(0);
  });

  it('refuses an array-like title with a lying length getter without calling it', () => {
    let calls = 0;
    const lyingLength = {};
    Object.defineProperty(lyingLength, 'length', {
      get() {
        calls += 1;
        return 1e15;
      },
    });
    expect(() => conductedOpenPullRequestTitle({ pullRequestTitle: lyingLength }, 'wo-example-1')).not.toThrow();
    expect(conductedOpenPullRequestTitle({ pullRequestTitle: lyingLength }, 'wo-example-1')).toEqual({
      ok: false,
      reason: 'invalid-pull-request-title',
    });
    expect(calls).toBe(0);
  });

  it('refuses a numeric title, a boolean title, a symbol, a bigint, and a function title with invalid-pull-request-title and does not throw', () => {
    const values: unknown[] = [42, true, Symbol('s'), 10n, () => {}];
    for (const value of values) {
      expect(() => conductedOpenPullRequestTitle({ pullRequestTitle: value }, 'wo-example-1')).not.toThrow();
      expect(conductedOpenPullRequestTitle({ pullRequestTitle: value }, 'wo-example-1')).toEqual({
        ok: false,
        reason: 'invalid-pull-request-title',
      });
    }
  });

  it('refuses a work order with a custom prototype and does not call its pullRequestTitle getter', () => {
    let calls = 0;
    const proto = {
      get pullRequestTitle() {
        calls += 1;
        return 'stolen';
      },
    };
    const workOrder = Object.create(proto);
    expect(() => conductedOpenPullRequestTitle(workOrder, 'wo-example-1')).not.toThrow();
    expect(conductedOpenPullRequestTitle(workOrder, 'wo-example-1')).toEqual({
      ok: false,
      reason: 'invalid-pull-request-title',
    });
    expect(calls).toBe(0);
  });

  it('refuses a class instance work order with invalid-pull-request-title', () => {
    class WorkOrder {
      pullRequestTitle = 'Open the gate';
    }
    const workOrder = new WorkOrder();
    expect(() => conductedOpenPullRequestTitle(workOrder, 'wo-example-1')).not.toThrow();
    expect(conductedOpenPullRequestTitle(workOrder, 'wo-example-1')).toEqual({
      ok: false,
      reason: 'invalid-pull-request-title',
    });
  });

  it('accepts a null-prototype work order with a stored title', () => {
    const workOrder = Object.create(null);
    workOrder.pullRequestTitle = 'Open the gate';
    expect(conductedOpenPullRequestTitle(workOrder, 'wo-example-1')).toEqual({
      ok: true,
      title: 'Open the gate',
    });
  });
});
