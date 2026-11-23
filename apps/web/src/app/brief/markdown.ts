/**
 * A small read-only Markdown reader for the frozen brief, ported from the
 * draft page. Everything is escaped before markup is applied; nothing inside
 * the rendered brief is a control.
 *
 * Cost bound: md() splits the input once and advances `i` monotonically
 * across blocks, so each line is visited at most once per branch; the whole
 * scan is bounded upfront by MAX_MD_LENGTH, giving O(n) over the input.
 */

const MAX_MD_LENGTH = 2_000_000;

const AMP = String.fromCharCode(38);
const HASH = String.fromCharCode(35);
// Null-prototype map so character escaping never touches Object.prototype
// (a text literal like "constructor" cannot resolve through the chain).
const ENTITIES: Record<string, string> = Object.assign(Object.create(null), {
  [AMP]: AMP + "amp;",
  "<": AMP + "lt;",
  ">": AMP + "gt;",
  '"': AMP + "quot;",
  "'": AMP + HASH + "39;"
});

const esc = (s: string): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ENTITIES[c]);

const inline = (t: string): string =>
  esc(t)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");

export function md(src: string): string {
  if (typeof src !== "string" || src.length > MAX_MD_LENGTH) return "";
  const lines = src.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const b: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) b.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(b.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,3})\s+(.*)/.exec(l);
    if (h) {
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }
    if (/^\|/.test(l)) {
      let rows: string[] = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      rows = rows.filter((r) => !/^\|\s*-+/.test(r));
      if (rows.length === 0) continue; // separator-only table: render nothing
      const cells = (r: string) => r.split("|").slice(1, -1).map((c) => c.trim());
      out.push(
        `<table><thead><tr>${cells(rows[0]).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows
          .slice(1)
          .map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`
      );
      continue;
    }
    if (/^[-*]\s/.test(l)) {
      const b: string[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i])) b.push(lines[i++].slice(2));
      out.push(`<ul>${b.map((x) => `<li>${inline(x)}</li>`).join("")}</ul>`);
      continue;
    }
    if (/^\d+\.\s/.test(l)) {
      const b: string[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) b.push(lines[i++].replace(/^\d+\.\s/, ""));
      out.push(`<ol>${b.map((x) => `<li>${inline(x)}</li>`).join("")}</ol>`);
      continue;
    }
    if (l.trim() === "") {
      i++;
      continue;
    }
    // Paragraph: always consume the first line (a line like "#tag", "#" or
    // "#### x" matches no block branch but must advance i or md() would loop
    // forever), then keep consuming lines that belong to the paragraph.
    const p: string[] = [lines[i++]];
    while (i < lines.length && lines[i].trim() !== "" && !/^(#|```|\||[-*]\s|\d+\.\s)/.test(lines[i])) p.push(lines[i++]);
    out.push(`<p>${inline(p.join(" "))}</p>`);
  }
  return out.join("");
}
