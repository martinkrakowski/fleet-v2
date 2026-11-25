// FC17A: additive-only field-path contract for the two recorded /v1 route
// fixtures. This file only READS fixtures and the checked-in snapshot; it
// never writes. To regenerate route-field-paths.snapshot.json by hand, run
// exactly this one-line command from the repository root (its path derivation
// must match `jsonPaths` below; the real-snapshot test fails on any drift):
//
// node -e 'const fs=require("fs");const MAXD=64,MAXN=1e5;function jp(v){const res=new Set(),act=new Set();let n=0;const st=[{v,p:"",d:1,x:false}];while(st.length){const f=st.pop();if(f.x){act.delete(f.v);continue;}n+=1;if(Array.isArray(f.v)&&f.v.length>MAXN)throw new Error("NodeBudgetExceededError");const ks=Reflect.ownKeys(f.v);n+=ks.length;if(n>MAXN)throw new Error("NodeBudgetExceededError");for(const k of ks){const d=Object.getOwnPropertyDescriptor(f.v,k);if(!d)continue;if(d.get!==undefined||d.set!==undefined)throw new Error("GetterPropertyError");if(typeof k==="symbol")throw new Error("UnsupportedValueError");}const kids=[];if(Array.isArray(f.v)){if(f.v.length===0)res.add(f.p+"[]");for(let i=0;i<f.v.length;i++)kids.push({v:f.v[i],p:f.p+"["+i+"]"});}else{for(const k of ks)kids.push({v:f.v[k],p:f.p===""?String(k):f.p+"."+String(k)});}for(const c of kids){if(c.v===null||["string","boolean"].includes(typeof c.v)||(typeof c.v==="number"&&Number.isFinite(c.v))){res.add(c.p);continue;}if(typeof c.v!=="object")throw new Error("UnsupportedValueError");const pr=Object.getPrototypeOf(c.v);if(!Array.isArray(c.v)&&pr!==Object.prototype&&pr!==null)throw new Error("UnsupportedObjectError");if(f.d+1>MAXD)throw new Error("DepthLimitExceededError");if(act.has(c.v))throw new Error("CycleDetectedError");st.push({v:c.v,p:c.p,d:f.d+1,x:false});}st.push({v:f.v,p:f.p,d:f.d,x:true});}return Array.from(res).sort();}const out={};for(const e of [["v1-runs.recorded.json","apps/api/server/wiring/__tests__/fixtures/v1-runs.recorded.json"],["v1-runs-passes.json","apps/api/test/fixtures/v1-runs-passes.json"]]){out[e[0]]=jp(JSON.parse(fs.readFileSync(e[1],"utf8")));}fs.writeFileSync("apps/api/server/wiring/__tests__/route-field-paths.snapshot.json",JSON.stringify(out,null,2)+"\n");'
//
// Map-like object rule: a path is a dotted key chain; array elements are
// recorded as `<parent>[<index>]` and `*` is reserved for map-like objects
// whose keys are data (for example an object keyed by `runId` or
// `sessionId`). Neither current fixture contains a data-keyed map — every
// object uses fixed schema keys (`operationId`, `code`, `result`, `schedule`,
// `runs`, `cursors`, `seatsByRole`, `passes`, `report`, `steps`, ...) — so no
// `*` path is ever recorded for them. An empty JSON array records the path
// `[]` (nested: `<parent>[]`).
//
// Cost bounds: every check below is O(N) time and space over the visited
// fixture graph, bounded by MAX_DEPTH = 64 and MAX_NODES = 100_000. Array
// length and snapshot-list length refusals are O(1) and fire before any
// per-property walk.
import "./nitro-globals.js";

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** Maximum nesting depth accepted by `jsonPaths` (root is depth 1). */
const MAX_DEPTH = 64;
/** Maximum number of visited values plus own keys accepted by every helper. */
const MAX_NODES = 100_000;

class UnsupportedValueError extends Error {
  constructor(value: unknown) {
    super(
      `UnsupportedValueError: value is not valid JSON (${describeRefusedValue(value)})`,
    );
    this.name = "UnsupportedValueError";
  }
}

class UnsupportedObjectError extends Error {
  constructor() {
    super("UnsupportedObjectError: value is not a plain object or array");
    this.name = "UnsupportedObjectError";
  }
}

class SparseArrayError extends Error {
  constructor() {
    super("SparseArrayError: array has a hole");
    this.name = "SparseArrayError";
  }
}

class GetterPropertyError extends Error {
  constructor() {
    super("GetterPropertyError: own property is an accessor");
    this.name = "GetterPropertyError";
  }
}

class DepthLimitExceededError extends Error {
  constructor() {
    super("DepthLimitExceededError: structure is deeper than MAX_DEPTH");
    this.name = "DepthLimitExceededError";
  }
}

class NodeBudgetExceededError extends Error {
  constructor() {
    super("NodeBudgetExceededError: structure exceeds MAX_NODES");
    this.name = "NodeBudgetExceededError";
  }
}

class CycleDetectedError extends Error {
  constructor() {
    super("CycleDetectedError: cyclic reference");
    this.name = "CycleDetectedError";
  }
}

class SnapshotFormatError extends Error {
  constructor(detail: string) {
    super(`SnapshotFormatError: ${detail}`);
    this.name = "SnapshotFormatError";
  }
}

/**
 * Describes a refused value using `typeof` and `Array.isArray` only — never
 * `Object.prototype.toString` (or any implicit stringification), which could
 * run an own or inherited `Symbol.toStringTag` getter.
 */
function describeRefusedValue(value: unknown): string {
  return `typeof ${typeof value}${Array.isArray(value) ? " (array)" : ""}`;
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * A canonical array index is only `String(Number(key)) === key` for an
 * integer between 0 and length - 1; "01", "1.0" and "-0" are therefore
 * non-index own properties. Array children are only ever enumerated through
 * those canonical indices (`0 .. length - 1`); every other own property is
 * rejected when it is an accessor and ignored when it is a data property
 * (for example the non-enumerable `length`).
 */

/**
 * Refuses every own property of `value` that is not a JSON data property:
 * any accessor (string or symbol key, indexed or not), and any symbol-keyed
 * property. Getters are inspected through `Object.getOwnPropertyDescriptor`
 * and never invoked.
 */
function assertJsonOwnProperties(
  value: object,
  keys: readonly (string | symbol)[],
): void {
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      continue;
    }
    if (
      typeof descriptor.get === "function" ||
      typeof descriptor.set === "function"
    ) {
      throw new GetterPropertyError();
    }
    if (typeof key === "symbol") {
      throw new UnsupportedValueError(key);
    }
    // Non-index own *data* string properties on arrays (for example the
    // non-enumerable `length`) are ignored; any non-index own *accessor* was
    // already refused above.
  }
}

interface Frame {
  value: object;
  path: string;
  depth: number;
  /** null until the frame has been visited once; then an exit marker. */
  children: boolean | null;
}

/**
 * Pure field-path enumeration over a parsed JSON value. Iterative explicit
 * stack (no recursion), cycles refused by construction via the active
 * ancestor set, O(N) time and space bounded by MAX_DEPTH and MAX_NODES.
 * Returns sorted unique path strings; values are never included.
 */
export function jsonPaths(value: unknown): string[] {
  if (value === null) {
    return [];
  }
  if (typeof value !== "object") {
    if (typeof value === "string" || typeof value === "boolean") {
      return [];
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return [];
    }
    throw new UnsupportedValueError(value);
  }
  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw new UnsupportedObjectError();
  }
  const results = new Set<string>();
  const activeAncestors = new Set<object>();
  let nodes = 0;
  const stack: Frame[] = [{ value, path: "", depth: 1, children: null }];
  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    if (frame.children !== null) {
      activeAncestors.delete(frame.value);
      continue;
    }
    nodes += 1;
    // Budget-first, O(1): an array's own keys always include one per
    // canonical index, and `nodes` already charges this node itself, so
    // `nodes + length` is a lower bound on the node charge. Refusing here
    // avoids the full `Reflect.ownKeys` walk and its key-array allocation
    // for any array that cannot fit in the budget, whether because of its
    // length alone or because of nodes already spent.
    if (Array.isArray(frame.value) && nodes + frame.value.length > MAX_NODES) {
      throw new NodeBudgetExceededError();
    }
    const keys = Reflect.ownKeys(frame.value);
    // The non-enumerable own `length` of an array is an internal marker, not
    // a JSON value, so it is excluded from the node charge.
    const chargedKeys =
      Array.isArray(frame.value) &&
      Object.prototype.hasOwnProperty.call(frame.value, "length")
        ? keys.length - 1
        : keys.length;
    nodes += chargedKeys;
    if (nodes > MAX_NODES) {
      throw new NodeBudgetExceededError();
    }
    assertJsonOwnProperties(frame.value, keys);
    if (activeAncestors.has(frame.value)) {
      throw new CycleDetectedError();
    }
    activeAncestors.add(frame.value);
    const isArray = Array.isArray(frame.value);
    const pending: { child: unknown; path: string }[] = [];
    if (isArray) {
      const arr = frame.value as unknown[];
      if (arr.length === 0) {
        results.add(`${frame.path}[]`);
      }
      for (let i = 0; i < arr.length; i += 1) {
        if (!Object.prototype.hasOwnProperty.call(arr, String(i))) {
          throw new SparseArrayError();
        }
        pending.push({ child: arr[i], path: `${frame.path}[${i}]` });
      }
    } else {
      for (const key of keys) {
        const keyText = String(key);
        const child = (frame.value as Record<string, unknown>)[keyText];
        const childPath =
          frame.path === "" ? keyText : `${frame.path}.${keyText}`;
        pending.push({ child, path: childPath });
      }
    }
    const childFrames: Frame[] = [];
    for (const entry of pending) {
      const childFrame = makeChildFrame(
        entry.child,
        entry.path,
        frame.depth + 1,
        results,
      );
      if (childFrame !== null) {
        childFrames.push(childFrame);
      }
    }
    // The exit frame is pushed before the child frames so it pops last: the
    // node stays an active ancestor while its whole subtree is processed.
    stack.push({
      value: frame.value,
      path: frame.path,
      depth: frame.depth,
      children: true,
    });
    for (const childFrame of childFrames) {
      stack.push(childFrame);
    }
  }
  return Array.from(results).sort();
}

/**
 * Validates one child value and either records its leaf path immediately
 * (primitives) or returns the stack frame for its subtree (plain object or
 * array). Refuses non-JSON primitives, non-plain objects, and depth over
 * MAX_DEPTH.
 */
function makeChildFrame(
  child: unknown,
  path: string,
  depth: number,
  results: Set<string>,
): Frame | null {
  if (child === null) {
    results.add(path);
    return null;
  }
  if (typeof child !== "object") {
    if (typeof child === "string" || typeof child === "boolean") {
      results.add(path);
      return null;
    }
    if (typeof child === "number" && Number.isFinite(child)) {
      results.add(path);
      return null;
    }
    throw new UnsupportedValueError(child);
  }
  if (!Array.isArray(child) && !isPlainObject(child)) {
    throw new UnsupportedObjectError();
  }
  if (depth > MAX_DEPTH) {
    throw new DepthLimitExceededError();
  }
  return { value: child, path, depth, children: null };
}

/** Shared O(1)/O(k) guard for path lists consumed by `compareFieldPaths`. */
function assertPathList(label: string, value: unknown): readonly string[] {
  if (value === null || value === undefined || !Array.isArray(value)) {
    throw new TypeError(`${label} must be an array of strings`);
  }
  // O(1) budget refusal before any per-property walk.
  if (value.length > MAX_NODES) {
    throw new NodeBudgetExceededError();
  }
  const keys = Reflect.ownKeys(value);
  const chargedKeys =
    Object.prototype.hasOwnProperty.call(value, "length") &&
    value.length === keys.length - 1
      ? keys.length - 1
      : keys.length;
  if (1 + chargedKeys > MAX_NODES) {
    throw new NodeBudgetExceededError();
  }
  assertJsonOwnProperties(value, keys);
  for (let i = 0; i < value.length; i += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, String(i))) {
      throw new SparseArrayError();
    }
    if (typeof value[i] !== "string") {
      throw new TypeError(`${label} must contain only strings`);
    }
  }
  return value;
}

/**
 * Additive-only subset check: every snapshot path must still exist in the
 * fixture. Extra fixture paths pass. Problems name only the file and the
 * missing path, never a value. O(N) time and space, bounded by MAX_NODES.
 */
export function compareFieldPaths(
  fileName: string,
  snapshotPaths: readonly string[],
  fixturePaths: readonly string[],
): string[] {
  if (typeof fileName !== "string") {
    throw new TypeError("fileName must be a string");
  }
  const snapshot = assertPathList("snapshotPaths", snapshotPaths);
  const fixture = assertPathList("fixturePaths", fixturePaths);
  const present = new Set(fixture);
  return snapshot
    .filter((path) => !present.has(path))
    .map((path) => `${fileName}: field path ${path} is missing`);
}

/**
 * Parses and validates the checked-in snapshot: a plain object mapping each
 * fixture file name to an array of path strings. Refuses a non-object root,
 * null, an array root, a non-array entry, a non-string path, and
 * prototype-polluting snapshot keys. O(N), bounded by MAX_NODES.
 */
export function parseFieldPathsSnapshot(
  text: string,
): Record<string, string[]> {
  if (typeof text !== "string") {
    throw new TypeError("snapshot text must be a string");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new SnapshotFormatError("snapshot is not valid JSON");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !isPlainObject(parsed)
  ) {
    throw new SnapshotFormatError("snapshot root must be a plain object");
  }
  let total = 0;
  for (const key of Object.keys(parsed)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new SnapshotFormatError("prototype-polluting snapshot key");
    }
    const entry: unknown = (parsed as Record<string, unknown>)[key];
    if (!Array.isArray(entry)) {
      throw new SnapshotFormatError(
        `snapshot entry for ${key} must be an array`,
      );
    }
    // Budget-first: charge the entry against the shared budget BEFORE
    // iterating its paths, so a single oversized path list is refused in
    // O(1) via its length instead of being traversed.
    total += 1 + entry.length;
    if (total > MAX_NODES) {
      throw new NodeBudgetExceededError();
    }
    for (const path of entry) {
      if (typeof path !== "string") {
        throw new SnapshotFormatError(
          `snapshot path for ${key} must be a string`,
        );
      }
    }
  }
  return parsed as Record<string, string[]>;
}

/** Reads a file, refusing failure with an error naming only the path. */
async function readTextFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new Error(`unreadable file: ${path}`);
  }
}

const FIXTURE_PATHS: Readonly<Record<string, URL>> = {
  "v1-runs-passes.json": new URL(
    "../../../test/fixtures/v1-runs-passes.json",
    import.meta.url,
  ),
  "v1-runs.recorded.json": new URL(
    "./fixtures/v1-runs.recorded.json",
    import.meta.url,
  ),
};

const SNAPSHOT_URL = new URL(
  "./route-field-paths.snapshot.json",
  import.meta.url,
);

/** Builds a chain of `count` nested plain objects, innermost value `1`. */
function nestedChain(count: number): object {
  let node: object = { value: 1 };
  for (let i = 0; i < count; i += 1) {
    node = { nested: node };
  }
  return node;
}

/** Object with a getter that records any invocation and then throws. */
function objectWithThrowingGetter(): object {
  let invoked = false;
  const target = {};
  Object.defineProperty(target, "prop", {
    enumerable: true,
    get() {
      invoked = true;
      throw new Error("getter invoked");
    },
  });
  (target as Record<string, unknown>).__invokedRef = {
    wasInvoked: () => invoked,
  };
  return target;
}

describe("checked-in field-path snapshot (/v1 fixtures)", () => {
  it("keeps every snapshot field path present in its fixture for both /v1 fixtures", async () => {
    const snapshot = parseFieldPathsSnapshot(
      await readTextFile(fileURLToPath(SNAPSHOT_URL)),
    );
    for (const [fixtureName, fixtureUrl] of Object.entries(FIXTURE_PATHS)) {
      const listed = snapshot[fixtureName];
      if (!Array.isArray(listed)) {
        throw new Error(`unreadable file: ${fixtureName}`);
      }
      const fixturePaths = jsonPaths(
        JSON.parse(await readTextFile(fileURLToPath(fixtureUrl))) as unknown,
      );
      expect(compareFieldPaths(fixtureName, listed, fixturePaths)).toEqual([]);
    }
  });

  it("lists exactly the known /v1 fixtures, each with a non-empty sorted unique path list", async () => {
    const snapshot = parseFieldPathsSnapshot(
      await readTextFile(fileURLToPath(SNAPSHOT_URL)),
    );
    expect(Object.keys(snapshot).sort()).toEqual(
      Object.keys(FIXTURE_PATHS).sort(),
    );
    for (const [fixtureName, fixtureUrl] of Object.entries(FIXTURE_PATHS)) {
      const listed = snapshot[fixtureName] as string[];
      expect(listed.length, `${fixtureName} has paths`).toBeGreaterThan(0);
      expect([...listed].sort()).toEqual(listed);
      expect(new Set(listed).size).toBe(listed.length);
      // Every listed fixture exists on disk.
      await expect(readTextFile(fileURLToPath(fixtureUrl))).resolves.toContain(
        "{",
      );
    }
  });

  it("rejects a missing fixture file naming only the path", async () => {
    const missing = new URL("./fixtures/does-not-exist.json", import.meta.url);
    await expect(readTextFile(fileURLToPath(missing))).rejects.toThrow(
      new Error(`unreadable file: ${fileURLToPath(missing)}`),
    );
  });
});

describe("additive-only subset rules", () => {
  it("passes the subset check when a fixture adds a new field", () => {
    expect(
      compareFieldPaths(
        "f.json",
        ["result.code"],
        ["result.code", "result.newField"],
      ),
    ).toEqual([]);
  });

  it("trivially passes an empty snapshot list in compareFieldPaths", () => {
    expect(compareFieldPaths("f.json", [], ["result.code"])).toEqual([]);
  });

  it("fails the subset check when a field is removed from a parsed copy of a real fixture, naming only file and path", async () => {
    const recorded = JSON.parse(
      await readTextFile(
        fileURLToPath(FIXTURE_PATHS["v1-runs.recorded.json"] as URL),
      ),
    ) as Record<string, unknown>;
    const result = structuredClone(recorded.result) as Record<string, unknown>;
    const removedPath = "result.outcome";
    delete result.outcome;
    const mutatedPaths = jsonPaths({ ...recorded, result });
    const problems = compareFieldPaths(
      "v1-runs.recorded.json",
      [removedPath, ...mutatedPaths],
      mutatedPaths,
    );
    expect(problems).toEqual([
      `v1-runs.recorded.json: field path ${removedPath} is missing`,
    ]);
  });

  it("fails the subset check when a field is renamed, naming only file and path", () => {
    const problems = compareFieldPaths(
      "f.json",
      ["result.outcome"],
      ["result.outcomeRenamed"],
    );
    expect(problems).toEqual(["f.json: field path result.outcome is missing"]);
  });

  it("fails the subset check when a field changes from object to array", () => {
    const problems = compareFieldPaths(
      "f.json",
      ["result.schedule"],
      ["result[0].schedule"],
    );
    expect(problems).toEqual(["f.json: field path result.schedule is missing"]);
  });
});

describe("snapshot validation refusals", () => {
  it("rejects malformed snapshot roots, non-array path lists, non-string paths, and prototype-polluting keys", () => {
    expect(() => parseFieldPathsSnapshot("[]")).toThrow(SnapshotFormatError);
    expect(() => parseFieldPathsSnapshot("null")).toThrow(SnapshotFormatError);
    expect(() => parseFieldPathsSnapshot('"text"')).toThrow(
      SnapshotFormatError,
    );
    expect(() => parseFieldPathsSnapshot("{")).toThrow(SnapshotFormatError);
    expect(() => parseFieldPathsSnapshot('{"f.json": "result"}')).toThrow(
      SnapshotFormatError,
    );
    expect(() => parseFieldPathsSnapshot('{"f.json": ["result", 1]}')).toThrow(
      SnapshotFormatError,
    );
    expect(() =>
      parseFieldPathsSnapshot(
        '{"__proto__": ["result"], "f.json": ["result"]}',
      ),
    ).toThrow(SnapshotFormatError);
  });

  it("refuses null and undefined in snapshot validation and comparison", () => {
    expect(() => parseFieldPathsSnapshot(null as unknown as string)).toThrow(
      TypeError,
    );
    expect(() =>
      parseFieldPathsSnapshot(undefined as unknown as string),
    ).toThrow(TypeError);
    expect(() =>
      compareFieldPaths("f.json", null as unknown as string[], []),
    ).toThrow(TypeError);
    expect(() =>
      compareFieldPaths("f.json", undefined as unknown as string[], []),
    ).toThrow(TypeError);
    expect(() =>
      compareFieldPaths("f.json", [], undefined as unknown as string[]),
    ).toThrow(TypeError);
    expect(() => compareFieldPaths(null as unknown as string, [], [])).toThrow(
      TypeError,
    );
  });

  it("rejects missing or unreadable snapshot and fixture files naming only the file", async () => {
    const missing = new URL(
      "./fixtures/no-such-snapshot.json",
      import.meta.url,
    );
    await expect(readTextFile(fileURLToPath(missing))).rejects.toThrow(
      `unreadable file: ${fileURLToPath(missing)}`,
    );
  });
});

describe("jsonPaths", () => {
  it("returns no nested field paths for JSON null, string, boolean, and finite number roots", () => {
    expect(jsonPaths(null)).toEqual([]);
    expect(jsonPaths("text")).toEqual([]);
    expect(jsonPaths(false)).toEqual([]);
    expect(jsonPaths(1.5)).toEqual([]);
  });

  it("records an empty root array as the path []", () => {
    expect(jsonPaths([])).toEqual(["[]"]);
  });

  it("records nested arrays as indexed paths", () => {
    expect(jsonPaths({ a: [{ b: [null] }] })).toEqual(["a[0].b[0]"]);
  });

  it("treats a __proto__ key from JSON.parse as an ordinary own key without mutating Object.prototype", () => {
    const parsed = JSON.parse(
      '{"a": {"__proto__": {"polluted": 1}}}',
    ) as unknown;
    expect(jsonPaths(parsed)).toContain("a.__proto__.polluted");
    expect(
      (Object.prototype as Record<string, unknown>).polluted,
    ).toBeUndefined();
  });

  it("refuses structures deeper than 64 with DepthLimitExceededError and accepts depth 64", () => {
    expect(() => jsonPaths(nestedChain(MAX_DEPTH))).toThrow(
      DepthLimitExceededError,
    );
    expect(jsonPaths(nestedChain(MAX_DEPTH - 1))).toHaveLength(1);
  });

  it("refuses just over the 100,000 node budget and accepts just under, for array length and own keys", () => {
    expect(() => jsonPaths(new Array<string>(MAX_NODES).fill("x"))).toThrow(
      NodeBudgetExceededError,
    );
    const justUnder = new Array<string>(MAX_NODES - 1).fill("x");
    expect(jsonPaths(justUnder)).toHaveLength(MAX_NODES - 1);
    const tooManyKeys: Record<string, number> = { base: 1 };
    for (let i = 0; i < MAX_NODES - 1; i += 1) {
      tooManyKeys[`k${i}`] = i;
    }
    expect(() => jsonPaths(tooManyKeys)).toThrow(NodeBudgetExceededError);
    const justUnderKeys: Record<string, number> = {};
    for (let i = 0; i < MAX_NODES - 1; i += 1) {
      justUnderKeys[`k${i}`] = i;
    }
    expect(jsonPaths(justUnderKeys)).toHaveLength(MAX_NODES - 1);
  });

  it("refuses an array whose many extra own keys exceed the budget, charged before any child walk", () => {
    // Budget-first: nodes(1) + length(1) alone stays under MAX_NODES, so only
    // the extra own keys push the charge over; the refusal still names
    // NodeBudgetExceededError rather than walking any child.
    const withExtras: string[] = ["only"];
    for (let i = 0; i < MAX_NODES - 1; i += 1) {
      Object.defineProperty(withExtras, `extra${i}`, {
        value: "x",
        enumerable: true,
      });
    }
    expect(() => jsonPaths(withExtras)).toThrow(NodeBudgetExceededError);
  });

  it("refuses an enormous array length above the budget in constant time, before any walk", () => {
    const enormous = new Array<number>(10 * MAX_NODES);
    enormous[0] = 1;
    expect(() => jsonPaths(enormous)).toThrow(NodeBudgetExceededError);
  });

  it("refuses a sparse array hole with SparseArrayError without reading through the prototype", () => {
    const sparse: string[] = new Array<string>(2);
    sparse[1] = "x";
    expect(() => jsonPaths(sparse)).toThrow(SparseArrayError);
  });

  it("refuses getter properties without invoking the getter, for objects and arrays", () => {
    const target = objectWithThrowingGetter();
    expect(() => jsonPaths({ wrapper: target })).toThrow(GetterPropertyError);
    const tracked = (target as Record<string, { wasInvoked: () => boolean }>)
      .__invokedRef as {
      wasInvoked: () => boolean;
    };
    expect(tracked.wasInvoked()).toBe(false);
    const withSetter: Record<string, number> = {};
    Object.defineProperty(withSetter, "onlySetter", {
      set() {},
      enumerable: true,
    });
    expect(() => jsonPaths(withSetter)).toThrow(GetterPropertyError);
    const arr = ["a", "b"];
    Object.defineProperty(arr, 0, {
      get() {
        throw new Error("getter invoked");
      },
    });
    expect(() => jsonPaths(arr)).toThrow(GetterPropertyError);
  });

  it("refuses an array with a getter at a non-canonical index key such as 01, 1.0 or -0", () => {
    for (const key of ["01", "1.0", "-0"]) {
      const arr: string[] = ["a", "b"];
      Object.defineProperty(arr, key, {
        enumerable: true,
        get() {
          throw new Error("getter invoked");
        },
      });
      expect(() => jsonPaths(arr)).toThrow(GetterPropertyError);
    }
  });

  it("refuses an own symbol-keyed getter", () => {
    const target: object = { plain: 1 };
    const symbolKey = Symbol("extra");
    Object.defineProperty(target, symbolKey, {
      enumerable: true,
      get() {
        throw new Error("getter invoked");
      },
    });
    expect(() => jsonPaths(target)).toThrow(GetterPropertyError);
  });

  it("refuses non-plain objects and array-like objects", () => {
    expect(() => jsonPaths(new Map([["k", 1]]))).toThrow(
      UnsupportedObjectError,
    );
    expect(() => jsonPaths(new Date(0))).toThrow(UnsupportedObjectError);
    expect(() => jsonPaths(new Uint8Array(2))).toThrow(UnsupportedObjectError);
    class Boxed {
      value = 1;
    }
    expect(() => jsonPaths(new Boxed())).toThrow(UnsupportedObjectError);
  });

  it("describes refused values using typeof only and never invokes Symbol.toStringTag", () => {
    let toStringTagInvoked = false;
    const exotic = new Proxy(new Date(0), {
      get(target, property) {
        if (property === Symbol.toStringTag) {
          toStringTagInvoked = true;
        }
        return Reflect.get(target, property);
      },
    });
    expect(() => jsonPaths({ wrapper: exotic })).toThrow(
      UnsupportedObjectError,
    );
    expect(toStringTagInvoked).toBe(false);
  });

  it("refuses cyclic object references", () => {
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic.self = cyclic;
    expect(() => jsonPaths(cyclic)).toThrow(CycleDetectedError);
  });

  it("refuses undefined, non-finite numbers, functions, symbols, and bigints", () => {
    expect(() => jsonPaths(undefined)).toThrow(UnsupportedValueError);
    expect(() => jsonPaths(Number.NaN)).toThrow(UnsupportedValueError);
    expect(() => jsonPaths(Number.POSITIVE_INFINITY)).toThrow(
      UnsupportedValueError,
    );
    expect(() => jsonPaths({ wrapper: undefined })).toThrow(
      UnsupportedValueError,
    );
    expect(() => jsonPaths({ wrapper: () => 1 })).toThrow(
      UnsupportedValueError,
    );
    expect(() => jsonPaths({ wrapper: Symbol("s") })).toThrow(
      UnsupportedValueError,
    );
    expect(() => jsonPaths({ wrapper: 1n })).toThrow(UnsupportedValueError);
    expect(() => jsonPaths([Number.NaN])).toThrow(UnsupportedValueError);
  });
});

describe("compareFieldPaths hostilities", () => {
  it("refuses any own string property that is an accessor, including non-index keys like extra", () => {
    const snapshotPaths: string[] = ["result.code"];
    Object.defineProperty(snapshotPaths, "extra", {
      enumerable: true,
      get() {
        throw new Error("getter invoked");
      },
    });
    expect(() =>
      compareFieldPaths("f.json", snapshotPaths, ["result.code"]),
    ).toThrow(GetterPropertyError);
  });

  it("refuses path lists just over the shared 100,000 node bound and accepts just under", () => {
    const justOver = new Array<string>(MAX_NODES).fill("result.code");
    const justUnder = new Array<string>(MAX_NODES - 1).fill("result.code");
    expect(() => compareFieldPaths("f.json", justOver, justUnder)).toThrow(
      NodeBudgetExceededError,
    );
    expect(compareFieldPaths("f.json", justUnder, justUnder)).toEqual([]);
  });

  it("refuses a path list with a hole and a non-string entry", () => {
    const holed: string[] = new Array<string>(2);
    holed[1] = "result.code";
    expect(() => compareFieldPaths("f.json", holed, ["result.code"])).toThrow(
      SparseArrayError,
    );
    expect(() =>
      compareFieldPaths("f.json", ["result.code"], [1 as unknown as string]),
    ).toThrow(TypeError);
  });

  it("refuses an enormous path list length in constant time", () => {
    expect(() =>
      compareFieldPaths("f.json", new Array<string>(10 * MAX_NODES), []),
    ).toThrow(NodeBudgetExceededError);
  });
});

describe("parseFieldPathsSnapshot budget", () => {
  it("refuses a snapshot just over the shared 100,000 path bound and accepts just under", () => {
    const justOver = JSON.stringify(
      Object.fromEntries([
        ["f.json", new Array<string>(MAX_NODES).fill("result.code")],
      ]),
    );
    const justUnder = JSON.stringify(
      Object.fromEntries([
        ["f.json", new Array<string>(MAX_NODES - 1).fill("result.code")],
      ]),
    );
    expect(() => parseFieldPathsSnapshot(justOver)).toThrow(
      NodeBudgetExceededError,
    );
    expect(() => parseFieldPathsSnapshot(justUnder)).not.toThrow();
  });

  it("refuses a single oversized snapshot path list by its length before iterating any path", () => {
    // Budget-first: the entry's length is charged against the shared budget
    // before the per-path walk, so one oversized list is refused even though
    // the earlier entries stay tiny.
    const oversizeSingle = JSON.stringify({
      "f.json": ["result.code"],
      "g.json": new Array<string>(MAX_NODES).fill("result.code"),
    });
    expect(() => parseFieldPathsSnapshot(oversizeSingle)).toThrow(
      NodeBudgetExceededError,
    );
  });
});
