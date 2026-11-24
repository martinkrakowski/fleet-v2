import { describe, expect, it } from "vitest";
import { md } from "./markdown";

// Byte-identical baseline expectations, captured against the unedited
// implementation on origin/main for representative valid inputs.
describe("baseline (byte-identical to origin/main)", () => {
  it("renders paragraphs, joining consecutive lines with a space", () => {
    expect(md("hello world\nsecond line")).toBe(
      "<p>hello world second line</p>",
    );
  });

  it("renders headings at levels 1, 2 and 3", () => {
    expect(md("# Title")).toBe("<h1>Title</h1>");
    expect(md("## Sub")).toBe("<h2>Sub</h2>");
    expect(md("### Deep")).toBe("<h3>Deep</h3>");
  });

  it("renders unordered and ordered lists", () => {
    expect(md("- one\n- two\n* three")).toBe(
      "<ul><li>one</li><li>two</li><li>three</li></ul>",
    );
    expect(md("1. one\n2. two")).toBe("<ol><li>one</li><li>two</li></ol>");
  });

  it("renders bold and inline code", () => {
    expect(md("a **bold** b")).toBe("<p>a <b>bold</b> b</p>");
    expect(md("use `x = 1` here")).toBe("<p>use <code>x = 1</code> here</p>");
  });

  it("renders a fenced code block with escaped content", () => {
    expect(md("```\n<script>\n```")).toBe(
      "<pre><code>&lt;script&gt;</code></pre>",
    );
  });

  it("renders a normal table with header, separator and body rows", () => {
    expect(md("| a | b |\n|---|---|\n| 1 | 2 |")).toBe(
      "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
    );
  });

  it("renders a header-only table with an empty tbody", () => {
    expect(md("| a | b |")).toBe(
      "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody></tbody></table>",
    );
  });

  it("renders a lone | as an empty header row table", () => {
    expect(md("|")).toBe(
      "<table><thead><tr></tr></thead><tbody></tbody></table>",
    );
  });

  it("keeps trailing \\r from \\r\\n endings inside text without producing markup", () => {
    expect(md("line one\r\nline two\r\n")).toBe(
      "<p>line one\r line two\r</p>",
    );
  });

  it("renders mixed blocks in document order", () => {
    expect(md("p1\n## head\n- item\n| a | b |\n\np2")).toBe(
      "<p>p1</p><h2>head</h2><ul><li>item</li></ul><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody></tbody></table><p>p2</p>",
    );
  });
});

describe("separator-only tables (blocker)", () => {
  it("renders nothing and does not throw for separator-only table blocks", () => {
    expect(() => md("|---")).not.toThrow();
    expect(md("|---")).toBe("");
    expect(md("|---|\n|---|")).toBe("");
    expect(md("|--- | ---")).toBe("");
  });
});

describe("escaping contract", () => {
  const hostile = `<script>alert(1)</script> " ' &`;

  it("escapes hostile characters in paragraphs", () => {
    const out = md(hostile);
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).toContain("&quot;");
    expect(out).toContain("&#39;");
    expect(out).toContain("&amp;");
  });

  it("escapes hostile characters in h1, h2 and h3 headings", () => {
    for (const [prefix, tag] of [
      ["#", "h1"],
      ["##", "h2"],
      ["###", "h3"],
    ] as const) {
      const out = md(`${prefix} ${hostile}`);
      expect(out).not.toContain("<script");
      expect(out).toBe(
        `<${tag}>&lt;script&gt;alert(1)&lt;/script&gt; &quot; &#39; &amp;</${tag}>`,
      );
    }
  });

  it("escapes hostile characters in unordered and ordered list items", () => {
    expect(md(`- ${hostile}`)).toBe(
      "<ul><li>&lt;script&gt;alert(1)&lt;/script&gt; &quot; &#39; &amp;</li></ul>",
    );
    expect(md(`1. ${hostile}`)).toBe(
      "<ol><li>&lt;script&gt;alert(1)&lt;/script&gt; &quot; &#39; &amp;</li></ol>",
    );
  });

  it("escapes hostile characters in table header and body cells", () => {
    expect(md(`| ${hostile} |\n|---|\n| ${hostile} |`)).toBe(
      "<table><thead><tr><th>&lt;script&gt;alert(1)&lt;/script&gt; &quot; &#39; &amp;</th></tr></thead><tbody><tr><td>&lt;script&gt;alert(1)&lt;/script&gt; &quot; &#39; &amp;</td></tr></tbody></table>",
    );
  });

  it("escapes hostile characters in inline code", () => {
    expect(md("`<script>alert(1)</script>`")).toBe(
      "<p><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></p>",
    );
  });

  it("escapes hostile characters in fenced code blocks", () => {
    const out = md("```\n<script>alert(1)</script>\n```");
    expect(out).not.toContain("<script");
    expect(out).toBe(
      "<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>",
    );
  });

  it("never emits an on...= attribute built from input", () => {
    const out = md(`<img src=x onerror=alert(1)>`);
    // The whole input must survive as escaped text content, not markup:
    // no element tag is opened, so no attribute — on...= or otherwise — exists.
    expect(out).toBe("<p>&lt;img src=x onerror=alert(1)&gt;</p>");
    expect(out).not.toMatch(/<[a-zA-Z][^>]*\son\w+\s*=/);
  });

  it("produces only <b> from bold and <code> from inline code markup", () => {
    expect(md("**x** and `y`")).toBe("<p><b>x</b> and <code>y</code></p>");
  });

  it("double-escapes author-typed HTML entities instead of decoding them", () => {
    expect(md("&lt;")).toBe("<p>&amp;lt;</p>");
  });
});

describe("structure", () => {
  it("consumes the rest of the text into one pre/code block for an unterminated fence", () => {
    expect(md("```\nline one\nline two")).toBe(
      "<pre><code>line one\nline two</code></pre>",
    );
  });

  it("stops a paragraph at a heading, list, table and fence", () => {
    expect(md("keep\ngoing\n# stop")).toBe("<p>keep going</p><h1>stop</h1>");
    expect(md("keep\ngoing\n- stop")).toBe("<p>keep going</p><ul><li>stop</li></ul>");
    expect(md("keep\ngoing\n| stop |")).toBe(
      "<p>keep going</p><table><thead><tr><th>stop</th></tr></thead><tbody></tbody></table>",
    );
    expect(md("keep\ngoing\n```stop")).toBe("<p>keep going</p><pre><code></code></pre>");
  });

  it("renders prototype-polluting key names as literal text without prototype lookup", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      expect(md(key)).toBe(`<p>${key}</p>`);
      expect(md(`| ${key} |\n|---|\n| ${key} |`)).toContain(`<td>${key}</td>`);
    }
  });
});

describe("non-heading lines starting with #", () => {
  it("renders '#tag', '#', and '#### x' as paragraph text and always returns", () => {
    expect(md("#tag")).toBe("<p>#tag</p>");
    expect(md("#")).toBe("<p>#</p>");
    expect(md("#### x")).toBe("<p>#### x</p>");
  });

  it("renders a non-heading # line in a multi-line paragraph and still returns", () => {
    // A line starting with # that is not a heading starts a new paragraph
    // rather than joining the previous one; the contract is that md() returns.
    expect(md("a\n#tag\nb")).toBe("<p>a</p><p>#tag b</p>");
  });
});

describe("cost bound", () => {
  it("renders a 10,000-line input well inside the default timeout", () => {
    const lines: string[] = [];
    for (let n = 0; n < 10_000; n++) {
      lines.push(`line ${n} with **bold** and \`code\``);
      lines.push(`| h${n} | b |`);
      lines.push(`|---|---|`);
      lines.push(`| a | ${n} |`);
      lines.push(`- item ${n}`);
      lines.push("```");
      lines.push(`fence ${n}`);
      lines.push("```");
      lines.push(`# head ${n}`);
    }
    const out = md(lines.join("\n"));
    expect(out).toContain("<p>line 0");
    expect(out).toContain("<h1>head 9999</h1>");
  });
});

describe("refusals and hostile inputs", () => {
  it("returns empty string for null or undefined without throwing", () => {
    // The parameter is typed `string`; callers from untrusted briefs may pass
    // anything, so exercise the runtime guard through casts.
    expect(md(null as unknown as string)).toBe("");
    expect(md(undefined as unknown as string)).toBe("");
  });

  it("returns empty string for non-string primitives without throwing", () => {
    expect(md(123 as unknown as string)).toBe("");
    expect(md(true as unknown as string)).toBe("");
    expect(md(Symbol("s") as unknown as string)).toBe("");
    expect(md(1n as unknown as string)).toBe("");
  });

  it("returns empty string for objects, array-likes, Proxies, and throwing getters without invoking getters", () => {
    const probe = (): string => {
      let touched = false;
      const hostile = Object.defineProperty({}, "toString", {
        get(): string {
          touched = true;
          throw new Error("boom");
        },
      });
      expect(() => md(hostile as unknown as string)).not.toThrow();
      const proxy = new Proxy(
        {},
        {
          get(): string {
            touched = true;
            throw new Error("trap");
          },
        },
      );
      expect(() => md(proxy as unknown as string)).not.toThrow();
      expect(md({ length: 3, 0: "a" } as unknown as string)).toBe("");
      expect(touched).toBe(false);
      return "clean";
    };
    expect(probe()).toBe("clean");
  });

  it("returns empty string for oversized input exceeding max length", () => {
    expect(md("a".repeat(2_000_001))).toBe("");
    expect(md("a".repeat(2_000_000))).not.toBe("");
  });
});
