// v0.2.1-#11 — llms.txt exposes the code-prompts surface to LLM agents, not just the article column.
// Pure function on the public availability flags; no DB needed.
//
// What we pin:
// - The code-prompts RSS line ("代码提示词合集 RSS") lives next to the prompts RSS — agents reading
//   the feed list find the code-prompts feed without guessing.
// - The /code-prompts page line lives under "## 网站主要页面" alongside /prompts.
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { llmsTxt } from "@aihot/backend/publication/llms";

const baseOpts = { hasDailies: true, hasWeekly: true, hasMonthly: true, hasLeaderboard: true };

test("llmsTxt: code-prompts RSS line appears in the Agent section", () => {
  const out = llmsTxt(baseOpts);
  assert.match(out, /- \[代码提示词合集 RSS\]\([^)]+\/feed\/code-prompts\.xml\):/);
});

test("llmsTxt: /code-prompts page line appears under 网站主要页面", () => {
  const out = llmsTxt(baseOpts);
  assert.match(out, /- \[代码提示词合集\]\([^)]+\/code-prompts\):/);
});

test("llmsTxt: code-prompts lines stay present when reports are missing (no dailies/weekly/monthly)", () => {
  const out = llmsTxt({ hasDailies: false, hasWeekly: false, hasMonthly: false, hasLeaderboard: false });
  assert.match(out, /\/feed\/code-prompts\.xml/);
  assert.match(out, /\/code-prompts\)/);
});

test("llmsTxt: code-prompts RSS appears next to prompts RSS (before per-category feeds)", () => {
  const out = llmsTxt(baseOpts);
  const codePromptsIdx = out.indexOf("/feed/code-prompts.xml");
  const categoryIdx = out.indexOf("/feed/category/");
  assert.ok(codePromptsIdx > 0, "code-prompts RSS must be present");
  assert.ok(categoryIdx > 0, "category RSS must be present");
  assert.ok(codePromptsIdx < categoryIdx, "code-prompts RSS should be listed alongside the other top-level feeds, before per-category feeds");
});