/**
 * `shellQuote` wraps an operator-chosen value in single quotes so a printed
 * command stays one command naming one file, whatever the value contains.
 */

import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { shellQuote } from "../plan.js";

describe("shellQuote", () => {
  it("wraps a plain value in single quotes", () => {
    expect(shellQuote("abc")).toBe("'abc'");
  });

  it("quotes the empty value as two single quotes", () => {
    expect(shellQuote("")).toBe("''");
  });

  it("escapes one single quote using the close-quote trick", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("escapes each of two single quotes", () => {
    expect(shellQuote("''")).toBe(`''\\'''\\'''`);
  });

  it("round trips each value through a real shell as one word", () => {
    const values = [
      "plain",
      "with space",
      "semi;colon",
      "amp&and",
      "dollar $HOME",
      "back`tick`",
      "it's",
      "''",
      "new\nline",
      "glob*?",
    ];
    for (const value of values) {
      const printed = execFileSync("sh", ["-c", `printf %s ${shellQuote(value)}`], {
        encoding: "utf8",
      });
      expect(printed).toBe(value);
    }
  });
});
