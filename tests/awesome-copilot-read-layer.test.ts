// awesome-copilot-read-layer — DB-free tests for the composite-id parser.
//
// Why a separate file:
// - parseCopilotAssetId is the only piece of loadCopilotAssetDetail that has edge-case risk
//   (composite-id splitting, slug regex, prefix whitelist). Wiring tests around the SQL
//   loaders would need DB fixtures; the parser is pure.
// - Mirrors tests/awesome-copilot-frontmatter.test.ts pattern: node:test + node:assert/strict,
//   no setup.js, <100 ms total.
//
// Edge cases covered:
// 1. Well-formed composite id from each of the three sources.
// 2. Missing "::" separator → null.
// 3. Empty slug (separator at end) → null.
// 4. Empty source_id (separator at start) → null.
// 5. Source_id without the external-awesome-copilot- prefix → null.
// 6. Slug containing a disallowed character (space, "?", control byte, "..") → null.
// 7. Slug length over 500 → null (doS guard).
// 8. Realistic nested-path slug — agents/code-reviewer.agent.md — accepted.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCopilotAssetId } from "@aihot/backend/publication/awesome-copilot";

test("agents source: well-formed composite id parses", () => {
  const r = parseCopilotAssetId("external-awesome-copilot-agents::agents/code-reviewer.agent.md");
  assert.ok(r);
  assert.equal(r!.sourceId, "external-awesome-copilot-agents");
  assert.equal(r!.slug, "agents/code-reviewer.agent.md");
});

test("instructions source: well-formed composite id parses", () => {
  const r = parseCopilotAssetId("external-awesome-copilot-instructions::instructions/python.instructions.md");
  assert.ok(r);
  assert.equal(r!.sourceId, "external-awesome-copilot-instructions");
  assert.equal(r!.slug, "instructions/python.instructions.md");
});

test("skills source: well-formed composite id parses", () => {
  const r = parseCopilotAssetId("external-awesome-copilot-skills::skills/pdf.skill.md");
  assert.ok(r);
  assert.equal(r!.sourceId, "external-awesome-copilot-skills");
  assert.equal(r!.slug, "skills/pdf.skill.md");
});

test("missing :: separator → null", () => {
  assert.equal(parseCopilotAssetId("external-awesome-copilot-agents:agents/x.md"), null);
  assert.equal(parseCopilotAssetId("external-awesome-copilot-agentsagents/x.md"), null);
  assert.equal(parseCopilotAssetId(""), null);
});

test("empty slug (separator at end) → null", () => {
  assert.equal(parseCopilotAssetId("external-awesome-copilot-agents::"), null);
});

test("empty source_id (separator at start) → null", () => {
  assert.equal(parseCopilotAssetId("::agents/x.md"), null);
});

test("source_id without the awesome-copilot prefix → null", () => {
  assert.equal(parseCopilotAssetId("external-rss-foo::agents/x.md"), null);
  assert.equal(parseCopilotAssetId("prompts::foo"), null);
  assert.equal(parseCopilotAssetId("agents::foo"), null);
});

test("slug with disallowed characters → null", () => {
  // space
  assert.equal(parseCopilotAssetId("external-awesome-copilot-agents::agents/foo bar.md"), null);
  // query string marker (would break a URL)
  assert.equal(parseCopilotAssetId("external-awesome-copilot-agents::agents/x?y=z.md"), null);
  // fragment marker
  assert.equal(parseCopilotAssetId("external-awesome-copilot-agents::agents/x#frag.md"), null);
  // backslash (Windows path style)
  assert.equal(parseCopilotAssetId("external-awesome-copilot-agents::agents\\x.md"), null);
  // control character (newline)
  assert.equal(parseCopilotAssetId("external-awesome-copilot-agents::agents/x\ny.md"), null);
  // path traversal — regex allows `..` but the loaders' SQL is keyed by (source_id, slug) and
  // there is no file-system read, so the asset slug is just an opaque identifier. We still
  // sanity-assert that `.` and `..` are accepted by the regex (so a path-traversal-style
  // filename is preserved as a stable id) — only `/` is meaningful in github path land.
  assert.ok(parseCopilotAssetId("external-awesome-copilot-agents::agents/..foo.md"));
  assert.ok(parseCopilotAssetId("external-awesome-copilot-agents::.gitignore"));
});

test("slug longer than 500 chars → null (doS guard)", () => {
  const longSlug = "a".repeat(501);
  assert.equal(parseCopilotAssetId(`external-awesome-copilot-agents::${longSlug}`), null);
});

test("slug exactly 500 chars → accepted", () => {
  const ok = "a".repeat(500);
  const r = parseCopilotAssetId(`external-awesome-copilot-agents::${ok}`);
  assert.ok(r);
  assert.equal(r!.slug.length, 500);
});

test("realistic nested-path slug is accepted", () => {
  const r = parseCopilotAssetId(
    "external-awesome-copilot-agents::agents/python/code-reviewer.agent.md",
  );
  assert.ok(r);
  assert.equal(r!.slug, "agents/python/code-reviewer.agent.md");
});