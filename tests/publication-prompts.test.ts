// W5-3-F3: readPromptMeta is the publication-layer gate that decides whether a row is safe to
// surface on the prompt column. Pure function on the row shape — no DB needed.
//
// Why this matters:
// - A row whose category falls outside the 5-bucket taxonomy must drop out of the wire silently
//   rather than throw at render time.
// - A row with empty prompt_text must drop out: half-imported rows where the editorial promptVersion
//   returned null get filtered here, not at query time.
// - Unknown source_kind values get normalised to "external" rather than leaking through.

import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readPromptMeta } from "@aihot/backend/publication/prompts";

const baseRow = {
  id: 1,
  article_id: null,
  original_url: "https://example.com/post/1",
  original_post_id: "abc",
  community: "example",
  category: "writing",
  prompt_text: "Write a poem about...",
  use_case: null,
  language: "en",
  source_kind: "searxng_search",
  captured_at: new Date("2026-10-01T00:00:00Z"),
  updated_at: new Date("2026-10-01T00:00:00Z"),
};

test("readPromptMeta: a healthy row returns a full card", () => {
  const card = readPromptMeta(baseRow);
  assert.ok(card);
  assert.equal(card!.id, "1");
  assert.equal(card!.category, "writing");
  assert.equal(card!.promptPreview, "Write a poem about...");
  assert.equal(card!.sourceKind, "searxng_search");
  assert.equal(card!.language, "en");
  assert.equal(card!.community, "example");
  assert.equal(card!.capturedAt, "2026-10-01T00:00:00.000Z");
});

test("readPromptMeta: category outside the 5-bucket taxonomy returns null", () => {
  assert.equal(readPromptMeta({ ...baseRow, category: "roleplay" }), null);
  assert.equal(readPromptMeta({ ...baseRow, category: "" }), null);
});

test("readPromptMeta: empty prompt_text returns null", () => {
  assert.equal(readPromptMeta({ ...baseRow, prompt_text: "" }), null);
});

test("readPromptMeta: long prompt_text is truncated with ellipsis at 240 chars", () => {
  const long = "a".repeat(300);
  const card = readPromptMeta({ ...baseRow, prompt_text: long });
  assert.ok(card);
  assert.equal(card!.promptPreview.length, 241); // 240 + ellipsis
  assert.match(card!.promptPreview, /…$/);
});

test("readPromptMeta: use_case trimmed; whitespace-only becomes null", () => {
  const card1 = readPromptMeta({ ...baseRow, use_case: "  " });
  assert.ok(card1);
  assert.equal(card1!.useCase, null);
  const card2 = readPromptMeta({ ...baseRow, use_case: "  Draft an email opener  " });
  assert.ok(card2);
  assert.equal(card2!.useCase, "Draft an email opener");
});

test("readPromptMeta: unknown source_kind normalises to 'external'", () => {
  assert.equal(readPromptMeta({ ...baseRow, source_kind: "reddit_api" })!.sourceKind, "external");
  assert.equal(readPromptMeta({ ...baseRow, source_kind: "" })!.sourceKind, "external");
});

test("readPromptMeta: known source_kind values pass through verbatim", () => {
  for (const kind of ["manual", "searxng_search", "rss", "external"] as const) {
    const card = readPromptMeta({ ...baseRow, source_kind: kind });
    assert.ok(card);
    assert.equal(card!.sourceKind, kind);
  }
});

test("readPromptMeta: id is stringified so JSON serialisation is safe across JS engines", () => {
  const card = readPromptMeta({ ...baseRow, id: 9999999999 });
  assert.ok(card);
  assert.equal(card!.id, "9999999999");
  assert.equal(typeof card!.id, "string");
});
