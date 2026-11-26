/**
 * Tests for the hosted-package import boundary scanner (FC2A).
 *
 * Fixture keys and specifiers are plain product names, never credentials.
 * The real-repository test asserts the scan is clean and that the scanned
 * target set matches the actual `packages/*` directories plus the three
 * scanned self-host apps, so a silently dropped package fails the suite.
 */
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  dependencyNames,
  hostedPackageName,
  isHostedSpecifier,
  listScannedTargets,
  scanHostedBoundary,
} from "./hosted-boundary-scan.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const createdDirectories: string[] = [];

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hosted-boundary-"));
  createdDirectories.push(root);
  mkdirSync(join(root, "packages"));
  mkdirSync(join(root, "apps"));
  return root;
}

function makePackage(root: string, name: string, manifest: unknown): string {
  const directory = join(root, "packages", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest),
  );
  return directory;
}

function makeSource(root: string, relativePath: string, text: string): void {
  const directory = join(root, relativePath, "..");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(root, relativePath), text);
}

const HOSTED_TENANCY = "@fleet/tenancy";
const HOSTED_BILLING = "@fleet/billing";

describe("hosted specifier matching", () => {
  it("matches the exact hosted names and cloud-[a-z0-9-]+ names, and subpaths of them", () => {
    expect(hostedPackageName(HOSTED_TENANCY)).toBe(HOSTED_TENANCY);
    expect(hostedPackageName(HOSTED_BILLING)).toBe(HOSTED_BILLING);
    expect(hostedPackageName("@fleet/cloud-runtime")).toBe(
      "@fleet/cloud-runtime",
    );
    expect(isHostedSpecifier(`${HOSTED_TENANCY}/sub`)).toBe(true);
    expect(isHostedSpecifier("@fleet/cloud-runtime/sub")).toBe(true);
  });

  it("does not match lookalike names that share only a hosted prefix", () => {
    expect(hostedPackageName("@fleet/tenancy-utils")).toBeNull();
    expect(hostedPackageName("@fleet/cloudy")).toBeNull();
    expect(hostedPackageName("@fleet/billingx")).toBeNull();
    expect(isHostedSpecifier("@fleet/cloud-")).toBe(false);
    expect(isHostedSpecifier("@fleet/core")).toBe(false);
  });

  it("refuses non-string specifiers and empty strings instead of matching them", () => {
    expect(hostedPackageName(null)).toBeNull();
    expect(hostedPackageName(undefined)).toBeNull();
    expect(hostedPackageName(42)).toBeNull();
    expect(hostedPackageName("")).toBeNull();
    expect(isHostedSpecifier(new Proxy({}, {}))).toBe(false);
  });
});

describe("dependencyNames refusal behaviour", () => {
  it("refuses null, undefined, non-iterables, wrong primitives and arrays as unreadable", () => {
    expect(dependencyNames(null)).toBe("unreadable");
    expect(dependencyNames(undefined)).toBe("unreadable");
    expect(dependencyNames(42)).toBe("unreadable");
    expect(dependencyNames("text")).toBe("unreadable");
    expect(dependencyNames([HOSTED_TENANCY])).toBe("unreadable");
  });

  it("refuses array holes and the array-like { length: 3 } as unreadable", () => {
    const holed = new Array<string>(3);
    holed[0] = HOSTED_TENANCY;
    expect(dependencyNames(holed)).toBe("unreadable");
    expect(dependencyNames({ length: 3 })).toBe("unreadable");
  });

  it("refuses a getter property without ever invoking the getter", () => {
    const getterField = {};
    let invocations = 0;
    Object.defineProperty(getterField, HOSTED_TENANCY, {
      enumerable: true,
      get() {
        invocations += 1;
        return "1.0.0";
      },
    });
    expect(dependencyNames(getterField)).toBe("unreadable");
    expect(invocations).toBe(0);
  });

  it("refuses a proxy whose ownKeys trap throws, and a proxy over a getter field", () => {
    const throwingProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("the scanner must refuse, not crash");
        },
      },
    );
    expect(dependencyNames(throwingProxy)).toBe("unreadable");
    const getterField = {};
    Object.defineProperty(getterField, HOSTED_TENANCY, {
      enumerable: true,
      get() {
        throw new Error(
          "the scanner must never invoke a getter through a proxy",
        );
      },
    });
    expect(dependencyNames(new Proxy(getterField, {}))).toBe("unreadable");
  });

  it("refuses a proxy whose getPrototypeOf trap throws, and a revoked proxy, as unreadable", () => {
    const prototypeProxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("the scanner must refuse, not crash");
        },
      },
    );
    expect(dependencyNames(prototypeProxy)).toBe("unreadable");
    const { proxy, revoke } = Proxy.revocable(
      { [HOSTED_TENANCY]: "1.0.0" },
      {},
    );
    revoke();
    expect(dependencyNames(proxy)).toBe("unreadable");
  });

  it("refuses enormous dependency fields and prototype-polluting keys as unreadable", () => {
    const enormous: Record<string, string> = {};
    for (let index = 0; index < 100_000; index += 1) {
      enormous[`dep-${index}`] = "1.0.0";
    }
    expect(dependencyNames(enormous)).toBe("unreadable");
    expect(dependencyNames(JSON.parse('{"__proto__": "1.0.0"}'))).toBe(
      "unreadable",
    );
    expect(dependencyNames({ constructor: "1.0.0" })).toBe("unreadable");
    expect(dependencyNames({ prototype: "1.0.0" })).toBe("unreadable");
  });

  it("returns only the hosted names of a well-formed dependency field", () => {
    expect(
      dependencyNames({
        [HOSTED_TENANCY]: "1.0.0",
        "@fleet/shared": "workspace:*",
      }),
    ).toEqual([HOSTED_TENANCY]);
    expect(dependencyNames({ "@fleet/shared": "workspace:*" })).toEqual([]);
  });
});

describe("scanHostedBoundary on the real repository", () => {
  it(
    "scans the real repository clean of hosted-package violations",
    { timeout: 120_000 },
    () => {
      expect(scanHostedBoundary(REPO_ROOT)).toEqual([]);
    },
  );

  it("covers every packages/* directory plus apps/cli, apps/mcp and apps/web", () => {
    const expected = readdirSync(join(REPO_ROOT, "packages"), {
      withFileTypes: true,
    })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          // Hosted package directories (tenancy, billing, cloud-*) are not
          // scanned targets; collectScannedTargets skips them by name.
          hostedPackageName(`@fleet/${entry.name}`) === null,
      )
      .map((entry) => `packages/${entry.name}`);
    expected.push("apps/cli", "apps/mcp", "apps/web");
    expect([...listScannedTargets(REPO_ROOT)].sort()).toEqual(expected.sort());
  });
});

describe("scanHostedBoundary dependency findings", () => {
  it("flags @fleet/tenancy listed in each dependency field of a core package once per field", () => {
    const root = makeRoot();
    makePackage(root, "core", {
      name: "@fleet/core",
      dependencies: { [HOSTED_TENANCY]: "1.0.0" },
      devDependencies: { [HOSTED_TENANCY]: "1.0.0" },
      peerDependencies: { [HOSTED_TENANCY]: "1.0.0" },
      optionalDependencies: { [HOSTED_TENANCY]: "1.0.0" },
    });
    const violations = scanHostedBoundary(root);
    expect(violations).toHaveLength(4);
    for (const violation of violations) {
      expect(violation.kind).toBe("dependency");
      expect(violation.specifier).toBe(HOSTED_TENANCY);
      expect(violation.file).toBe("packages/core/package.json");
    }
  });

  it("flags @fleet/cloud-* dependency names but not a hosted package directory itself", () => {
    const root = makeRoot();
    makePackage(root, "core", {
      name: "@fleet/core",
      dependencies: { "@fleet/cloud-runtime": "1.0.0" },
    });
    makePackage(root, "cloud-runtime", { name: "@fleet/cloud-runtime" });
    makeSource(
      root,
      "packages/cloud-runtime/index.ts",
      "export const self = 1;\n",
    );
    expect(scanHostedBoundary(root)).toEqual([
      {
        file: "packages/core/package.json",
        kind: "dependency",
        specifier: "@fleet/cloud-runtime",
      },
    ]);
  });

  it("records one unreadable violation for a malformed or non-object package.json", () => {
    const root = makeRoot();
    makePackage(root, "broken-json", "{ not json");
    makePackage(root, "null-manifest", "null");
    makePackage(root, "array-manifest", "[1, 2]");
    makePackage(root, "string-manifest", '"text"');
    makePackage(root, "numeric-deps", { name: "@fleet/x", dependencies: 5 });
    const violations = scanHostedBoundary(root);
    expect(violations).toHaveLength(5);
    for (const violation of violations) {
      expect(violation).toEqual({
        file: `packages/${violation.file.split("/")[1]}/package.json`,
        kind: "unreadable",
        specifier: "",
      });
    }
    expect(violations.map((violation) => violation.file)).toEqual([
      "packages/array-manifest/package.json",
      "packages/broken-json/package.json",
      "packages/null-manifest/package.json",
      "packages/numeric-deps/package.json",
      "packages/string-manifest/package.json",
    ]);
  });

  it("refuses hostile dependency objects written into a package.json as unreadable", () => {
    const root = makeRoot();
    makePackage(root, "proto-key", '{"dependencies": {"__proto__": "1.0.0"}}');
    makePackage(
      root,
      "huge-keys",
      JSON.stringify({
        name: "@fleet/huge",
        dependencies: Object.fromEntries(
          Array.from({ length: 100_001 }, (_, index) => [
            `dep-${index}`,
            "1.0.0",
          ]),
        ),
      }),
    );
    expect(scanHostedBoundary(root)).toEqual([
      {
        file: "packages/huge-keys/package.json",
        kind: "unreadable",
        specifier: "",
      },
      {
        file: "packages/proto-key/package.json",
        kind: "unreadable",
        specifier: "",
      },
    ]);
  });

  it("records an unreadable violation when a manifest or source file cannot be read", () => {
    const root = makeRoot();
    makePackage(root, "core", { name: "@fleet/core" });
    // A directory impersonating a manifest or a source file cannot be read.
    mkdirSync(join(root, "packages/core/nested", "package.json"), {
      recursive: true,
    });
    mkdirSync(join(root, "packages/core/broken.ts"));
    const violations = scanHostedBoundary(root);
    expect(violations).toHaveLength(2);
    expect(new Set(violations.map((violation) => violation.file))).toEqual(
      new Set(["packages/core/broken.ts", "packages/core/nested/package.json"]),
    );
    for (const violation of violations) {
      expect(violation.kind).toBe("unreadable");
      expect(violation.specifier).toBe("");
    }
  });

  it("passes a valid file with the same imports when it lives in the exempt apps/api", () => {
    const root = makeRoot();
    makePackage(root, "core", { name: "@fleet/core" });
    mkdirSync(join(root, "apps", "api"), { recursive: true });
    makeSource(
      root,
      "apps/api/ok.ts",
      "import a from '@fleet/billing';\nexport const x = 1;\n",
    );
    makeSource(
      root,
      "packages/core/broken.ts",
      "import a from '@fleet/billing';\n}}",
    );
    expect(scanHostedBoundary(root)).toEqual([
      { file: "packages/core/broken.ts", kind: "unreadable", specifier: "" },
    ]);
  });

  it("reports a malformed source file instead of passing it as a clean scan", () => {
    const root = makeRoot();
    makePackage(root, "core", { name: "@fleet/core" });
    makeSource(
      root,
      "packages/core/broken.ts",
      "const text = 'unterminated;\n",
    );
    makeSource(root, "packages/core/stray.ts", "}}");
    const violations = scanHostedBoundary(root);
    expect(new Set(violations.map((violation) => violation.file))).toEqual(
      new Set(["packages/core/broken.ts", "packages/core/stray.ts"]),
    );
    for (const violation of violations) {
      expect(violation.kind).toBe("unreadable");
    }
  });
});

describe("scanHostedBoundary import findings", () => {
  it("flags template-literal specifiers and import() with an options argument", () => {
    const root = makeRoot();
    makePackage(root, "core", { name: "@fleet/core" });
    makeSource(
      root,
      "packages/core/forms.ts",
      [
        "const a = await import(`@fleet/billing`);",
        "const b = require(`@fleet/cloud-x`);",
        "const c = await import('@fleet/tenancy', { with: { type: 'json' } });",
        "",
      ].join("\n"),
    );
    expect(scanHostedBoundary(root)).toEqual([
      {
        file: "packages/core/forms.ts",
        kind: "import",
        specifier: HOSTED_BILLING,
      },
      {
        file: "packages/core/forms.ts",
        kind: "import",
        specifier: "@fleet/cloud-x",
      },
      {
        file: "packages/core/forms.ts",
        kind: "import",
        specifier: HOSTED_TENANCY,
      },
    ]);
  });

  it("flags static imports, dynamic import(), require() and export-from of hosted packages", () => {
    const root = makeRoot();
    makePackage(root, "core", { name: "@fleet/core" });
    makeSource(
      root,
      "packages/core/uses.ts",
      [
        `import first from '${HOSTED_BILLING}';`,
        `const later = await import('@fleet/cloud-runtime');`,
        `const legacy = require('@fleet/cloud-x');`,
        `export * from '${HOSTED_TENANCY}/sub';`,
        `import same from '${HOSTED_BILLING}/nested';`,
        "",
      ].join("\n"),
    );
    // Findings follow source document order.
    expect(scanHostedBoundary(root)).toEqual([
      {
        file: "packages/core/uses.ts",
        kind: "import",
        specifier: HOSTED_BILLING,
      },
      {
        file: "packages/core/uses.ts",
        kind: "import",
        specifier: "@fleet/cloud-runtime",
      },
      {
        file: "packages/core/uses.ts",
        kind: "import",
        specifier: "@fleet/cloud-x",
      },
      {
        file: "packages/core/uses.ts",
        kind: "import",
        specifier: `${HOSTED_TENANCY}/sub`,
      },
      {
        file: "packages/core/uses.ts",
        kind: "import",
        specifier: `${HOSTED_BILLING}/nested`,
      },
    ]);
  });

  it("detects an escaped specifier through its cooked value", () => {
    const root = makeRoot();
    makePackage(root, "core", { name: "@fleet/core" });
    makeSource(
      root,
      "packages/core/escaped.ts",
      "import escaped from '\\x40fleet/billing';\n",
    );
    expect(scanHostedBoundary(root)).toEqual([
      {
        file: "packages/core/escaped.ts",
        kind: "import",
        specifier: HOSTED_BILLING,
      },
    ]);
  });

  it("an object nested in a template interpolation does not hide a later import", () => {
    const root = makeRoot();
    makePackage(root, "core", { name: "@fleet/core" });
    makeSource(
      root,
      "packages/core/interpolated.ts",
      [
        "const payload = `${ { name: '@fleet/cloud-x' } }`;",
        `import later from '${HOSTED_BILLING}';`,
        "",
      ].join("\n"),
    );
    expect(scanHostedBoundary(root)).toEqual([
      {
        file: "packages/core/interpolated.ts",
        kind: "import",
        specifier: HOSTED_BILLING,
      },
    ]);
  });

  it("ignores imports written inside comments", () => {
    const root = makeRoot();
    makePackage(root, "core", { name: "@fleet/core" });
    makeSource(
      root,
      "packages/core/commented.ts",
      [
        `// import hidden from '${HOSTED_TENANCY}';`,
        `/* import hiddenToo from '${HOSTED_BILLING}'; */`,
        "const text = 'plain';",
        "",
      ].join("\n"),
    );
    expect(scanHostedBoundary(root)).toEqual([]);
  });

  it("does not flag lookalike names, commented specifiers, or apps/api imports", () => {
    const root = makeRoot();
    makePackage(root, "core", { name: "@fleet/core" });
    makeSource(
      root,
      "packages/core/lookalikes.ts",
      [
        "import tenancyUtils from '@fleet/tenancy-utils';",
        "import cloudy from '@fleet/cloudy';",
        `// const hidden = require('${HOSTED_BILLING}');`,
        "import shared from '@fleet/shared';",
        "",
      ].join("\n"),
    );
    makeSource(
      root,
      "apps/api/hosted.ts",
      `import apiBilling from '${HOSTED_BILLING}';\n`,
    );
    expect(scanHostedBoundary(root)).toEqual([]);
  });

  it("exempts apps/api and skips build/dependency directories", () => {
    const root = makeRoot();
    makePackage(root, "core", { name: "@fleet/core" });
    for (const directory of [
      "node_modules/pkg",
      "dist",
      ".next",
      ".output",
      ".turbo",
    ]) {
      makeSource(
        root,
        `packages/core/${directory}/hosted.ts`,
        `import hidden from '${HOSTED_TENANCY}';\n`,
      );
    }
    expect(scanHostedBoundary(root)).toEqual([]);
  });

  it("does not follow symlinks inside the scanned tree", () => {
    const root = makeRoot();
    const outside = join(tmpdir(), `hosted-boundary-outside-${Date.now()}`);
    writeFileSync(outside, `import outside from '${HOSTED_TENANCY}';\n`);
    createdDirectories.push(outside);
    makePackage(root, "core", { name: "@fleet/core" });
    symlinkSync(outside, join(root, "packages/core/link.ts"));
    symlinkSync(outside, join(root, "packages/core/linkdir"));
    expect(scanHostedBoundary(root)).toEqual([]);
    expect(
      lstatSync(join(root, "packages/core/link.ts")).isSymbolicLink(),
    ).toBe(true);
  });

  it("does not follow a symlink at the packages directory", () => {
    const root = makeRoot();
    const outsidePackages = join(
      tmpdir(),
      `hosted-boundary-outside-pkgs-${Date.now()}`,
    );
    mkdirSync(outsidePackages);
    createdDirectories.push(outsidePackages);
    writeFileSync(
      join(outsidePackages, "package.json"),
      JSON.stringify({
        name: "@fleet/outsider",
        dependencies: { [HOSTED_TENANCY]: "1.0.0" },
      }),
    );
    rmSync(join(root, "packages"), { recursive: true });
    symlinkSync(outsidePackages, join(root, "packages"));
    // Following the symlink would read the out-of-tree manifest above and flag
    // its @fleet/tenancy dependency; refusing to follow keeps the scan clean.
    expect(scanHostedBoundary(root)).toEqual([]);
    expect(lstatSync(join(root, "packages")).isSymbolicLink()).toBe(true);
  });

  it("records an unreadable violation for a missing or non-directory packages path", () => {
    const missingPackagesRoot = join(
      tmpdir(),
      `hosted-boundary-no-pkgs-${Date.now()}`,
    );
    mkdirSync(join(missingPackagesRoot, "apps"), { recursive: true });
    createdDirectories.push(missingPackagesRoot);
    expect(scanHostedBoundary(missingPackagesRoot)).toEqual([
      { file: "packages", kind: "unreadable", specifier: "" },
    ]);

    const filePackagesRoot = makeRoot();
    rmSync(join(filePackagesRoot, "packages"), { recursive: true });
    writeFileSync(join(filePackagesRoot, "packages"), "not a directory\n");
    expect(scanHostedBoundary(filePackagesRoot)).toEqual([
      { file: "packages", kind: "unreadable", specifier: "" },
    ]);
  });
});

describe("scanHostedBoundary root refusal", () => {
  it("refuses null, undefined, wrong primitives, and a missing root with the literal <root> record", () => {
    const hostileRoots: unknown[] = [
      null,
      undefined,
      42,
      true,
      [],
      { length: 3 },
      "",
    ];
    for (const root of hostileRoots) {
      expect(scanHostedBoundary(root as string)).toEqual([
        { file: "<root>", kind: "unreadable", specifier: "" },
      ]);
    }
    expect(
      scanHostedBoundary(join(tmpdir(), "hosted-boundary-missing-root")),
    ).toEqual([{ file: "<root>", kind: "unreadable", specifier: "" }]);
  });

  it("refuses a getter-bearing object and a Proxy root by reporting the literal <root> record", () => {
    const getterRoot = {};
    Object.defineProperty(getterRoot, "toString", {
      get() {
        throw new Error("the scanner must never touch a hostile root");
      },
    });
    for (const root of [getterRoot, new Proxy({}, {}), new String("/tmp")]) {
      const violations = scanHostedBoundary(root as unknown as string);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toEqual({
        file: "<root>",
        kind: "unreadable",
        specifier: "",
      });
    }
  });

  it("reports a file that is not a directory as an unreadable <root> record", () => {
    const file = join(tmpdir(), `hosted-boundary-root-file-${Date.now()}`);
    writeFileSync(file, "not a directory\n");
    createdDirectories.push(file);
    const violations = scanHostedBoundary(file);
    expect(violations).toEqual([
      { file: "<root>", kind: "unreadable", specifier: "" },
    ]);
  });
});
