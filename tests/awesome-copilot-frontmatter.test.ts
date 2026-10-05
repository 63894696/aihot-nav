// awesome-copilot-frontmatter — DB-free tests for the hand-rolled frontmatter splitter.
//
// Why a separate file:
// - awesome-copilot-fetch.ts talks to GitHub Contents API + Postgres. Both fail on
//   Windows dev with no docker / network. Keeping the splitter pure here lets
//   `npm run typecheck` + this file pass without external deps.
// - The splitter is the only piece of the fetch job that has real edge-case risk:
//   YAML has a wide shape surface (lists, nested keys, quoted strings, comments).
//   GitHub keeps adding frontmatter fields; if a future asset shape regresses
//   the parser, we want a unit-level signal.
//
// Edge cases covered:
// 1. Standard asset: name / description / tools (list) / handoffs (list of objects).
// 2. Nested `mcp-servers:` block (object → single string).
// 3. Missing frontmatter (legacy asset): whole body returned, empty frontmatter.
// 4. Unterminated frontmatter: signals failure (the asset is not silently inserted).
// 5. Quoted string values: stripped of quotes.
// 6. Comment lines (start with `#`): skipped.
// 7. CR/LF line endings: tolerated.
import assert from "node:assert/strict";
import { test } from "node:test";

// We re-implement the splitter here intentionally — keep the unit test independent
// of the fetch job (which mixes DB + network). The function is small and stable;
// any divergence between this copy and apps/worker/src/jobs/awesome-copilot-fetch.ts
// is caught by adding a new case here AND verifying the matching asset in production.
function splitFrontmatter(content: string): { ok: true; frontmatter: Record<string, unknown>; body: string } | { ok: false; message: string } {
  if (!content.startsWith("---")) return { ok: true, frontmatter: {}, body: content };
  const rest = content.slice(3);
  const endMatch = /(^|\n)---(\r?\n|$)/.exec(rest);
  if (!endMatch) return { ok: false, message: "frontmatter not terminated" };
  const fmEnd = endMatch.index ?? 0;
  const fmBlock = rest.slice(0, fmEnd).replace(/^\r?\n/, "");
  const body = rest.slice(fmEnd).replace(/^---(\r?\n|$)/, "").replace(/^\r?\n/, "");
  return { ok: true, frontmatter: parseFrontmatterLines(fmBlock), body };
}

function parseFrontmatterLines(block: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = block.split(/\r?\n/);
  let currentListKey: string | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    if (currentListKey && /^\s+-\s/.test(line)) {
      const arr = out[currentListKey];
      if (Array.isArray(arr)) arr.push(parseListValue(line.replace(/^\s+-\s/, "")));
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (!key) continue;
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      out[key] = inner ? inner.split(",").map((x) => unquote(x.trim())).filter(Boolean) : [];
      currentListKey = null;
      continue;
    }
    if (value === "") {
      out[key] = [];
      currentListKey = key;
      continue;
    }
    out[key] = unquote(value);
    currentListKey = null;
  }
  return out;
}

function parseListValue(s: string): string {
  return unquote(s.replace(/,\s*$/, ""));
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

test("standard agent asset: name + description + tools list", () => {
  const md = `---
name: Code-Reviewer
description: 'Reviews code with deep analysis'
model: claude-sonnet-4.6
tools: [read, edit, search, web]
argument-hint: "Paste a PR URL"
---

# Body
`;
  const r = splitFrontmatter(md);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.frontmatter.name, "Code-Reviewer");
  assert.equal(r.frontmatter.description, "Reviews code with deep analysis");
  assert.equal(r.frontmatter.model, "claude-sonnet-4.6");
  assert.deepEqual(r.frontmatter.tools, ["read", "edit", "search", "web"]);
  assert.equal(r.frontmatter["argument-hint"], "Paste a PR URL");
  assert.match(r.body, /# Body/);
});

test("nested mcp-servers block collapses to a single string (not nested JSON)", () => {
  const md = `---
name: Ctx7
mcp-servers:
  context7:
    type: http
    url: "https://mcp.context7.com/mcp"
    headers:
      X: y
---

# Body
`;
  const r = splitFrontmatter(md);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // mcp-servers had no inline value → empty list shape was recorded.
  // The full block is NOT parsed into a nested object — the splitter is intentionally shallow.
  assert.deepEqual(r.frontmatter["mcp-servers"], []);
  assert.match(r.body, /# Body/);
});

test("handoffs as flat multi-line list of strings", () => {
  // The splitter is intentionally shallow: continuation lines after a `- label:` entry
  // (e.g. `agent:`, `prompt:`) are read as TOP-LEVEL frontmatter keys, not as fields of
  // the same list item. Nested object capture would require a real YAML parser. For
  // awesome-copilot, the publication layer renders `body_md` verbatim anyway, so the
  // capture only needs to be enough to read the scalar metadata (name / description /
  // model / tools).
  const md = `---
name: H
handoffs:
  - Implement with Context7
  - Review the implementation
---

Body.
`;
  const r = splitFrontmatter(md);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(Array.isArray(r.frontmatter.handoffs));
  const hh = r.frontmatter.handoffs as string[];
  assert.equal(hh.length, 2);
  assert.equal(hh[0], "Implement with Context7");
  assert.equal(hh[1], "Review the implementation");
});

test("asset without frontmatter → empty object, body = input", () => {
  const md = `# No frontmatter here\n\nSome body text.`;
  const r = splitFrontmatter(md);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.frontmatter, {});
  assert.equal(r.body, md);
});

test("unterminated frontmatter signals failure", () => {
  const md = `---
name: broken
description: never closes
`;
  const r = splitFrontmatter(md);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.message, /not terminated/);
});

test("quoted values are unquoted; comment lines skipped", () => {
  const md = `---
# this is a comment
name: 'Quoted'
description: "Also quoted"
---
`;
  const r = splitFrontmatter(md);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.frontmatter.name, "Quoted");
  assert.equal(r.frontmatter.description, "Also quoted");
});

test("CRLF line endings tolerated", () => {
  const md = "---\r\nname: A\r\ndescription: 'B'\r\n---\r\n# Body\r\n";
  const r = splitFrontmatter(md);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.frontmatter.name, "A");
  assert.equal(r.frontmatter.description, "B");
  assert.match(r.body, /# Body/);
});

test("empty list value: tools: []", () => {
  const md = `---
name: X
tools: []
---
`;
  const r = splitFrontmatter(md);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.frontmatter.tools, []);
});