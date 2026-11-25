// Pure verifier and replay cache for inbound webhooks (XS02). Every key-shaped value
// is built at runtime; no fixture names a host, address or token.
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { createReplayCache, verifyWebhookSignature } from "../webhook-signature";

// Counts HMAC constructions so a test can prove the size check ran before any hashing.
const hmacCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    createHmac: (algorithm: string, key: string | Uint8Array) => {
      hmacCalls.count += 1;
      return actual.createHmac(algorithm, key);
    },
  };
});

const SECRET = "Qz7!".repeat(8);
const OTHER_SECRET = "Mp4$".repeat(8);
const BODY_TEXT = "Bx3#".repeat(8);
const MIB = 1048576;
const OK = { ok: true };

// Counts every Proxy trap that fires; a verifier that never touches a Proxy leaves it at 0.
const touches = { count: 0 };

function trapped<T extends object>(target: T): T {
  const trap = (): never => {
    touches.count += 1;
    throw new Error("trap");
  };
  return new Proxy(target, {
    get: trap,
    has: trap,
    ownKeys: trap,
    getOwnPropertyDescriptor: trap,
    getPrototypeOf: trap,
  });
}

function sign(secret: string | Uint8Array, body: Uint8Array): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

function validInput(): { secret: string; body: Buffer; signatureHeader: string } {
  const body = Buffer.from(BODY_TEXT, "utf8");
  return { secret: SECRET, body, signatureHeader: sign(SECRET, body) };
}

function withFields(fields: Record<string, unknown>): Record<string, unknown> {
  return { ...validInput(), ...fields };
}

function refused(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function rangeErrorOf(run: () => unknown): RangeError {
  try {
    run();
  } catch (error) {
    if (error instanceof RangeError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a RangeError");
}

describe("verifyWebhookSignature", () => {
  it("accepts valid Buffer and Uint8Array bodies under string and Uint8Array secrets", () => {
    // Cost: one HMAC per case over a body of at most 1 MiB; nothing loops over input.
    const buffer = Buffer.from(BODY_TEXT, "utf8");
    expect(
      verifyWebhookSignature({ secret: SECRET, body: buffer, signatureHeader: sign(SECRET, buffer) }),
    ).toEqual(OK);
    const secretBytes = new Uint8Array(32).fill(0x5a);
    const bytes = new Uint8Array(buffer);
    expect(
      verifyWebhookSignature({
        secret: secretBytes,
        body: bytes,
        signatureHeader: sign(secretBytes, bytes),
      }),
    ).toEqual(OK);
    // An empty body is a legitimate Uint8Array and its own signature verifies.
    const empty = Buffer.alloc(0);
    expect(
      verifyWebhookSignature({ secret: SECRET, body: empty, signatureHeader: sign(SECRET, empty) }),
    ).toEqual(OK);
    // A body exactly at the 1 MiB default cap still verifies.
    const atCap = Buffer.alloc(MIB, 7);
    expect(
      verifyWebhookSignature({ secret: SECRET, body: atCap, signatureHeader: sign(SECRET, atCap) }),
    ).toEqual(OK);
    // Eight two-byte characters are exactly the 16-byte minimum secret.
    const minimal = "\u00e9".repeat(8);
    expect(
      verifyWebhookSignature(withFields({ secret: minimal, signatureHeader: sign(minimal, buffer) })),
    ).toEqual(OK);
  });

  it("lowers the body cap with maxBodyBytes and falls back to 1 MiB for any other value", () => {
    // Cost: a 100-byte HMAC per accepted call; oversize calls are refused before hashing.
    const body = Buffer.alloc(100, 1);
    const base = { secret: SECRET, body, signatureHeader: sign(SECRET, body) };
    expect(verifyWebhookSignature({ ...base, maxBodyBytes: 100 })).toEqual(OK);
    expect(verifyWebhookSignature({ ...base, maxBodyBytes: 99 })).toEqual(refused("body-too-large"));
    expect(verifyWebhookSignature({ ...base, maxBodyBytes: 1 })).toEqual(refused("body-too-large"));
    const huge = Buffer.alloc(MIB + 1, 2);
    const hugeInput = { secret: SECRET, body: huge, signatureHeader: sign(SECRET, huge) };
    const junkCaps: unknown[] = [0, -1, 1.5, Number.NaN, Infinity, -Infinity, 2 ** 31, 2 ** 53, MIB + 1, "10", "100", null, undefined, true, {}, [100]];
    for (const maxBodyBytes of junkCaps) {
      // A junk cap keeps the 1 MiB default: the small body verifies and the over-1 MiB
      // body is refused, so a cap can never be raised above the default.
      expect(verifyWebhookSignature({ ...base, maxBodyBytes })).toEqual(OK);
      expect(verifyWebhookSignature({ ...hugeInput, maxBodyBytes })).toEqual(refused("body-too-large"));
    }
    // A cap of exactly the default is allowed but still refuses one byte over it.
    expect(verifyWebhookSignature({ ...hugeInput, maxBodyBytes: MIB })).toEqual(refused("body-too-large"));
  });

  it("refuses a body one byte over maxBodyBytes as body-too-large without hashing", () => {
    // Cost: fixtures are signed before the counted window; each counted call is O(1).
    const cap = 64;
    const over = Buffer.alloc(cap + 1, 3);
    // The signature is VALID, so only the size check can refuse this input.
    const overInput = { secret: SECRET, body: over, signatureHeader: sign(SECRET, over) };
    hmacCalls.count = 0;
    expect(verifyWebhookSignature({ ...overInput, maxBodyBytes: cap })).toEqual(refused("body-too-large"));
    expect(hmacCalls.count).toBe(0);
    const huge = Buffer.alloc(MIB + 1, 4);
    const hugeInput = { secret: SECRET, body: huge, signatureHeader: sign(SECRET, huge) };
    hmacCalls.count = 0;
    expect(verifyWebhookSignature(hugeInput)).toEqual(refused("body-too-large"));
    expect(hmacCalls.count).toBe(0);
    // Exactly at the cap the body is hashed once and verifies.
    const atCap = over.subarray(0, cap);
    const atCapHeader = sign(SECRET, atCap);
    hmacCalls.count = 0;
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        body: atCap,
        signatureHeader: atCapHeader,
        maxBodyBytes: cap,
      }),
    ).toEqual(OK);
    expect(hmacCalls.count).toBe(1);
  });

  it("refuses missing or empty signatureHeader as header-missing", () => {
    // Cost: O(1) per case; the header is classified before any hashing.
    for (const signatureHeader of [undefined, null, ""]) {
      expect(verifyWebhookSignature(withFields({ signatureHeader }))).toEqual(
        refused("header-missing"),
      );
    }
    const { secret, body } = validInput();
    expect(verifyWebhookSignature({ secret, body })).toEqual(refused("header-missing"));
    expect(verifyWebhookSignature(withFields({}))).toEqual(OK);
  });

  it("refuses malformed headers and array headers as header-malformed", () => {
    // Cost: O(1) per case (a length check, then an anchored 71-character regex); the
    // million-character header is refused on length alone, before the regex or any hashing.
    const valid = validInput().signatureHeader;
    const hex = valid.slice(7);
    const malformed: unknown[] = [
      "sha256=" + hex.toUpperCase(),
      "SHA256=" + hex,
      "sha1=" + hex,
      "sha512=" + hex,
      " " + valid,
      valid + " ",
      valid + "\n",
      valid.slice(0, -1),
      valid + "0",
      hex,
      "sha256=",
      "sha256=" + "g".repeat(64),
      "sha256=" + hex.slice(0, 63) + "G",
      "sha256=" + hex + hex,
      [valid, valid],
      [valid],
      5,
      true,
      {},
      Object(valid),
      Buffer.from(valid),
      Symbol("signature"),
      "a".repeat(MIB),
    ];
    for (const signatureHeader of malformed) {
      expect(verifyWebhookSignature(withFields({ signatureHeader }))).toEqual(
        refused("header-malformed"),
      );
    }
    expect(verifyWebhookSignature(withFields({ signatureHeader: valid }))).toEqual(OK);
  });

  it("refuses tampered body, tampered nibble, wrong secret, and empty-body signature as mismatch", () => {
    // Every header here is well formed (71 characters, lowercase hex), so each refusal is a
    // genuine timingSafeEqual mismatch and never header-malformed. Cost: one HMAC each.
    const { secret, body, signatureHeader } = validInput();
    const flipped = Buffer.from(body);
    flipped.writeUInt8(flipped.readUInt8(0) ^ 0x01, 0);
    const first = signatureHeader.charAt(7) === "0" ? "1" : "0";
    const last = signatureHeader.charAt(70) === "0" ? "1" : "0";
    const cases: Record<string, unknown>[] = [
      { secret, body: flipped, signatureHeader },
      { secret, body: Buffer.concat([body, Buffer.from("x")]), signatureHeader },
      { secret, body: body.subarray(0, body.length - 1), signatureHeader },
      { secret, body, signatureHeader: signatureHeader.slice(0, 7) + first + signatureHeader.slice(8) },
      { secret, body, signatureHeader: signatureHeader.slice(0, 70) + last },
      { secret: OTHER_SECRET, body, signatureHeader },
      { secret, body, signatureHeader: sign(OTHER_SECRET, body) },
      { secret, body, signatureHeader: sign(secret, Buffer.alloc(0)) },
    ];
    for (const input of cases) {
      expect(verifyWebhookSignature(input)).toEqual(refused("mismatch"));
    }
    expect(verifyWebhookSignature({ secret, body, signatureHeader })).toEqual(OK);
  });

  it("refuses empty, short, non-string/Uint8Array, and getter-backed secrets as secret-invalid", () => {
    // Cost: O(1) per case; string secrets are length-guarded before bytes are counted and
    // typed arrays are measured through an O(1) intrinsic getter.
    touches.count = 0;
    const arrayLike: Record<string, unknown> = { length: 32 };
    for (let index = 0; index < 32; index += 1) {
      arrayLike[String(index)] = 7;
    }
    const secrets: unknown[] = [
      "",
      "a".repeat(15),
      "\u00e9".repeat(7),
      new Uint8Array(15),
      Buffer.alloc(0),
      null,
      undefined,
      42,
      true,
      Symbol("secret"),
      {},
      [],
      Array.from({ length: 32 }, () => 7),
      arrayLike,
      { byteLength: 32, length: 32 },
      trapped(new Uint8Array(32)),
      new Uint16Array(32),
      new ArrayBuffer(32),
      new DataView(new ArrayBuffer(32)),
      "a".repeat(4097),
      new Uint8Array(4097),
    ];
    for (const secret of secrets) {
      expect(verifyWebhookSignature(withFields({ secret }))).toEqual(refused("secret-invalid"));
    }
    let reads = 0;
    const getterInput = withFields({});
    Object.defineProperty(getterInput, "secret", {
      enumerable: true,
      get() {
        reads += 1;
        return SECRET;
      },
    });
    expect(verifyWebhookSignature(getterInput)).toEqual(refused("secret-invalid"));
    expect(reads).toBe(0);
    expect(touches.count).toBe(0);
    const { body, signatureHeader } = validInput();
    expect(verifyWebhookSignature({ body, signatureHeader })).toEqual(refused("secret-invalid"));
    // Boundary controls: exactly 16 bytes verifies for both secret types.
    const sixteen = new Uint8Array(16).fill(9);
    expect(verifyWebhookSignature({ secret: sixteen, body, signatureHeader: sign(sixteen, body) })).toEqual(OK);
    const sixteenText = "a".repeat(16);
    expect(verifyWebhookSignature({ secret: sixteenText, body, signatureHeader: sign(sixteenText, body) })).toEqual(OK);
  });

  it("refuses non-Uint8Array bodies including string, null, array, and array-like as body-invalid", () => {
    // Cost: O(1) per case; the type brand is checked first and no element, key or length
    // of an untrusted body is ever read, so a 2**53 length or a 2**32 sparse array is free.
    touches.count = 0;
    const holes: number[] = [];
    holes[2] = 1;
    const bodies: unknown[] = [
      BODY_TEXT,
      null,
      undefined,
      7,
      true,
      {},
      Array.from(Buffer.from(BODY_TEXT, "utf8")),
      holes,
      new Array<number>(2 ** 32 - 1),
      { length: 3, 0: 1, 1: 2, 2: 3 },
      { length: Number.MAX_SAFE_INTEGER },
      { byteLength: 4 },
      trapped([1, 2, 3]),
      trapped(Buffer.from(BODY_TEXT, "utf8")),
      trapped(new Uint8Array(4)),
      new Uint16Array(4),
      new ArrayBuffer(8),
      new DataView(new ArrayBuffer(8)),
    ];
    for (const body of bodies) {
      expect(verifyWebhookSignature(withFields({ body }))).toEqual(refused("body-invalid"));
    }
    let reads = 0;
    const getterInput = withFields({});
    Object.defineProperty(getterInput, "body", {
      enumerable: true,
      get() {
        reads += 1;
        return Buffer.from(BODY_TEXT, "utf8");
      },
    });
    expect(verifyWebhookSignature(getterInput)).toEqual(refused("body-invalid"));
    expect(reads).toBe(0);
    expect(touches.count).toBe(0);
    const { secret, signatureHeader } = validInput();
    expect(verifyWebhookSignature({ secret, signatureHeader })).toEqual(refused("body-invalid"));
    expect(verifyWebhookSignature(withFields({}))).toEqual(OK);
  });

  it("refuses hostile inputs without invoking getters or echoing secrets, headers, or body bytes", () => {
    // Cost: O(1) per case (own-property descriptor lookups only); the result list is
    // bounded by the fixed case table below.
    touches.count = 0;
    const base = validInput();
    const results: unknown[] = [];
    const record = (input: unknown, reason: string): void => {
      const result = verifyWebhookSignature(input);
      expect(result).toEqual(refused(reason));
      results.push(result);
    };
    for (const input of [null, undefined, 0, "text", true, Symbol("input"), () => base, []]) {
      record(input, "secret-invalid");
    }
    record(trapped({ ...base }), "secret-invalid");
    record(Object.create(base), "secret-invalid");
    record(JSON.parse('{"__proto__":{"secret":"x"}}'), "secret-invalid");
    // Hostile property values and getters on each of the four fields.
    record({ ...base, secret: trapped(new Uint8Array(32)) }, "secret-invalid");
    record({ ...base, body: trapped(new Uint8Array(32)) }, "body-invalid");
    record({ ...base, signatureHeader: trapped([base.signatureHeader]) }, "header-malformed");
    const reads = { count: 0 };
    const getterReasons: [string, string][] = [
      ["secret", "secret-invalid"],
      ["body", "body-invalid"],
      ["signatureHeader", "header-malformed"],
      ["maxBodyBytes", "body-too-large"],
    ];
    for (const [field, reason] of getterReasons) {
      const input = { ...base } as Record<string, unknown>;
      Object.defineProperty(input, field, {
        enumerable: true,
        configurable: true,
        get() {
          reads.count += 1;
          throw new Error(SECRET);
        },
      });
      record(input, reason);
    }
    expect(reads.count).toBe(0);
    // Prototype-polluting own keys are ignored and pollute nothing.
    const polluting = JSON.parse(
      '{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}}}',
    ) as Record<string, unknown>;
    Object.assign(polluting, base);
    const okResult = verifyWebhookSignature(polluting);
    expect(okResult).toEqual(OK);
    results.push(okResult);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // Plain refusals, to prove no result echoes what it refused.
    record({ ...base, secret: OTHER_SECRET }, "mismatch");
    record({ ...base, signatureHeader: base.signatureHeader.toUpperCase() }, "header-malformed");
    record({ ...base, body: BODY_TEXT }, "body-invalid");
    record({ ...base, maxBodyBytes: 1 }, "body-too-large");
    const serialised = JSON.stringify(results);
    for (const echoed of [SECRET, OTHER_SECRET, BODY_TEXT, base.signatureHeader, base.signatureHeader.slice(7), base.signatureHeader.toUpperCase()]) {
      expect(serialised).not.toContain(echoed);
    }
    for (const result of results) {
      const keys = Object.keys(result as object);
      expect(keys).toEqual((result as { ok: boolean }).ok ? ["ok"] : ["ok", "reason"]);
    }
    expect(touches.count).toBe(0);
  });
});

describe("createReplayCache", () => {
  it("throws RangeError naming capacity or ttlMs without echoing values on invalid options", () => {
    // Cost: O(1) per case; options are read through two own-property descriptor lookups.
    touches.count = 0;
    const good = { capacity: 4, ttlMs: 1000 };
    const badCapacity: unknown[] = [0, -1, 10001, 1.5, Number.NaN, Infinity, 424242, 2 ** 53, "4", "s3cr3t-value", null, undefined, true, {}, [4]];
    const badTtl: unknown[] = [0, -1, 86400001, 1.5, Number.NaN, Infinity, 987654321, 2 ** 53, "1000", "s3cr3t-value", null, undefined, true, {}, [1000]];
    for (const value of badCapacity) {
      const error = rangeErrorOf(() => createReplayCache({ ...good, capacity: value }));
      expect(error.message).toContain("capacity");
      expect(error.message).not.toContain("ttlMs");
      expect(error.message).not.toContain("424242");
      expect(error.message).not.toContain("s3cr3t-value");
    }
    for (const value of badTtl) {
      const error = rangeErrorOf(() => createReplayCache({ ...good, ttlMs: value }));
      expect(error.message).toContain("ttlMs");
      expect(error.message).not.toContain("capacity");
      expect(error.message).not.toContain("987654321");
      expect(error.message).not.toContain("s3cr3t-value");
    }
    // Getter-backed, inherited, non-object and Proxy options are refused; no getter runs.
    let reads = 0;
    const getterCapacity = { ...good };
    Object.defineProperty(getterCapacity, "capacity", {
      enumerable: true,
      get() {
        reads += 1;
        return 4;
      },
    });
    const getterTtl = { ...good };
    Object.defineProperty(getterTtl, "ttlMs", {
      enumerable: true,
      get() {
        reads += 1;
        return 1000;
      },
    });
    expect(rangeErrorOf(() => createReplayCache(getterCapacity)).message).toContain("capacity");
    expect(rangeErrorOf(() => createReplayCache(getterTtl)).message).toContain("ttlMs");
    expect(rangeErrorOf(() => createReplayCache(Object.create(good))).message).toContain("capacity");
    for (const options of [null, undefined, 4, "options", true, trapped({ ...good })]) {
      expect(rangeErrorOf(() => createReplayCache(options)).message).toContain("options");
    }
    expect(reads).toBe(0);
    expect(touches.count).toBe(0);
    // Boundary values and own prototype-polluting keys are accepted and pollute nothing.
    for (const options of [
      { capacity: 1, ttlMs: 1 },
      { capacity: 10000, ttlMs: 86400000 },
      JSON.parse('{"__proto__":{"capacity":1},"capacity":4,"ttlMs":1000}'),
    ]) {
      expect(createReplayCache(options).size()).toBe(0);
    }
    expect(({} as Record<string, unknown>).capacity).toBeUndefined();
  });

  it("returns invalid and leaves cache unchanged for invalid deliveryId, hostile inputs, or invalid nowMs", () => {
    // Cost: O(1) per case: one typeof/length/regex check on at most 64 characters; the
    // million-character id is refused on length alone.
    touches.count = 0;
    const cache = createReplayCache({ capacity: 4, ttlMs: 1000 });
    const ID = "delivery-0001";
    let coerced = 0;
    const hostileIds: unknown[] = [
      null,
      undefined,
      12345678,
      true,
      {},
      [],
      [ID],
      "",
      "short",
      "abcdefg",
      "a".repeat(65),
      "abcdefgh\n",
      "abcdefgh ",
      "delivery_0001",
      "__proto__",
      "d\u00e9livery-1",
      Object(ID),
      { length: 13, 0: "d" },
      {
        toString() {
          coerced += 1;
          return ID;
        },
      },
      {
        get id() {
          coerced += 1;
          return ID;
        },
      },
      trapped({ id: ID }),
      trapped([ID]),
      Symbol("id"),
      "a".repeat(MIB),
    ];
    for (const deliveryId of hostileIds) {
      expect(cache.check(deliveryId, 10)).toBe("invalid");
      expect(cache.size()).toBe(0);
    }
    expect(coerced).toBe(0);
    expect(touches.count).toBe(0);
    const badTimes: unknown[] = [Number.NaN, -1, 1.5, Infinity, -Infinity, 2 ** 53, "10", null, undefined, true, {}];
    for (const nowMs of badTimes) {
      expect(cache.check(ID, nowMs as number)).toBe("invalid");
      expect(cache.size()).toBe(0);
    }
    // Nothing invalid was remembered: the first valid check is fresh and is then stored.
    expect(cache.check(ID, 10)).toBe("fresh");
    expect(cache.size()).toBe(1);
    for (const nowMs of badTimes) {
      expect(cache.check(ID, nowMs as number)).toBe("invalid");
    }
    expect(cache.size()).toBe(1);
    // Invalid times never refreshed the stored time: ttl 1000 from 10 expires at 1010.
    expect(cache.check(ID, 1009)).toBe("replay");
    expect(cache.check(ID, 1010)).toBe("fresh");
    // IDs named like Object.prototype members are plain keys in a Map and pollute nothing.
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    for (const name of ["constructor", "prototype", "hasOwnProperty", "isPrototypeOf", "toLocaleString"]) {
      expect(cache.check(name, 2000)).toBe("fresh");
      expect(cache.check(name, 2000)).toBe("replay");
    }
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
  });

  it("enforces TTL expiry and capacity-bounded oldest-first eviction", () => {
    // Cost: check is O(1) amortised; the loops are bounded by capacity * 3 = 15 inserts.
    const ttl = createReplayCache({ capacity: 3, ttlMs: 1000 });
    const ID = "delivery-0001";
    expect(ttl.check(ID, 5000)).toBe("fresh");
    expect(ttl.check(ID, 5999)).toBe("replay"); // younger than ttlMs
    expect(ttl.check(ID, 4000)).toBe("replay"); // earlier than the stored time
    expect(ttl.check(ID, 6000)).toBe("fresh"); // exactly ttlMs old: expired
    expect(ttl.size()).toBe(1);
    expect(ttl.check(ID, 6999)).toBe("replay"); // re-stored at 6000
    expect(ttl.check(ID, 7000)).toBe("fresh");
    // An expired ID that is re-inserted becomes the newest, so it is not evicted next.
    const order = createReplayCache({ capacity: 2, ttlMs: 10 });
    const [a, b, c] = ["aaaaaaaa", "bbbbbbbb", "cccccccc"];
    expect(order.check(a, 0)).toBe("fresh");
    expect(order.check(b, 1)).toBe("fresh");
    expect(order.check(a, 10)).toBe("fresh"); // expired, now newest
    expect(order.check(c, 11)).toBe("fresh"); // evicts b, the oldest
    expect(order.check(a, 12)).toBe("replay");
    expect(order.check(c, 12)).toBe("replay");
    expect(order.check(b, 12)).toBe("fresh");
    expect(order.size()).toBe(2);
    // capacity * 3 inserts keep size === capacity and evict oldest first.
    const capacity = 5;
    const cache = createReplayCache({ capacity, ttlMs: 100000 });
    const ids = Array.from(
      { length: capacity * 3 },
      (_, index) => "delivery-" + String(index).padStart(4, "0"),
    );
    ids.forEach((id, index) => {
      expect(cache.check(id, 1000 + index)).toBe("fresh");
      expect(cache.size()).toBe(Math.min(index + 1, capacity));
    });
    const evicted = ids.slice(0, ids.length - capacity);
    const survivors = ids.slice(ids.length - capacity);
    for (const id of survivors) {
      expect(cache.check(id, 2000)).toBe("replay");
    }
    expect(cache.size()).toBe(capacity);
    for (const id of evicted) {
      expect(cache.check(id, 2000)).toBe("fresh");
      expect(cache.size()).toBe(capacity);
    }
  });
});
