// v0.2.1-#11 — llms.txt exposes the prompts surface to LLM agents, not just the article column.
// Pure function on the public availability flags; no DB needed.
//
// What we pin:
// - The prompts RSS line ("提示词合集 RSS") lives next to the existing RSS list — agents reading the
//   feed list find the prompts feed without guessing.
// - The /prompts page line lives under "## 网站主要页面" alongside the other column roots
//   (/all, /hot, /daily).
// - All four capability axes (tools/papers/prompts not in scope here; tools+prompts at least) get a
//   route: we're shipping prompts now, so it's discoverable from llms.txt; tools/papers remain a
//   follow-up.

import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { llmsTxt } from "@aihot/backend/publication/llms";

const baseOpts = { hasDailies: true, hasWeekly: true, hasMonthly: true, hasLeaderboard: true };

test("llmsTxt: prompts RSS line appears in the Agent section", () => {
  const out = llmsTxt(baseOpts);
  assert.match(out, /- \[提示词合集 RSS\]\([^)]+\/feed\/prompts\.xml\):/);
});

test("llmsTxt: /prompts page line appears under 网站主要页面", () => {
  const out = llmsTxt(baseOpts);
  assert.match(out, /- \[提示词合集\]\([^)]+\/prompts\):/);
});

test("llmsTxt: prompts lines stay present when reports are missing (no dailies/weekly/monthly)", () => {
  const out = llmsTxt({ hasDailies: false, hasWeekly: false, hasMonthly: false, hasLeaderboard: false });
  assert.match(out, /\/feed\/prompts\.xml/);
  assert.match(out, /\/prompts\)/);
});

test("llmsTxt: prompts RSS appears in the RSS block (before the daily/category lines)", () => {
  const out = llmsTxt(baseOpts);
  const promptsIdx = out.indexOf("/feed/prompts.xml");
  const categoryIdx = out.indexOf("/feed/category/");
  assert.ok(promptsIdx > 0, "prompts RSS must be present");
  assert.ok(categoryIdx > 0, "category RSS must be present");
  assert.ok(promptsIdx < categoryIdx, "prompts RSS should be listed alongside the other top-level feeds, before per-category feeds");
});
