// W5-3 v0.2.1 — verify PromptCategory grew from 5 → 10 capability-axis buckets and that the
// PROMPT_CATEGORY_LABELS / PROMPT_CATEGORY_GUIDES records cover every key. Pure unit, no DB.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROMPT_CATEGORIES,
  PROMPT_CATEGORY_LABELS,
  PROMPT_CATEGORY_GUIDES,
  type PromptCategory,
} from "@aihot/contracts/site";

test("PROMPT_CATEGORIES has exactly 10 buckets", () => {
  assert.equal(PROMPT_CATEGORIES.length, 10);
});

test("every PROMPT_CATEGORIES entry is a unique PromptCategory", () => {
  const set = new Set<string>(PROMPT_CATEGORIES);
  assert.equal(set.size, PROMPT_CATEGORIES.length);
});

test("legacy keys 'painting' and 'design' are GONE", () => {
  const typed: readonly PromptCategory[] = PROMPT_CATEGORIES;
  assert.equal(typed.includes("painting" as PromptCategory), false, "painting must be removed");
  assert.equal(typed.includes("design" as PromptCategory), false, "design must be removed");
});

test("new capability-axis keys are present", () => {
  const expected = ["writing", "coding", "image", "video", "audio", "agent", "data", "research", "study", "other"] as const;
  for (const k of expected) {
    assert.ok((PROMPT_CATEGORIES as readonly string[]).includes(k), `${k} should be in PROMPT_CATEGORIES`);
  }
});

test("PROMPT_CATEGORY_LABELS covers every key and nothing else", () => {
  for (const k of PROMPT_CATEGORIES) {
    assert.ok(PROMPT_CATEGORY_LABELS[k], `missing label for ${k}`);
    assert.equal(typeof PROMPT_CATEGORY_LABELS[k], "string");
  }
  for (const k of Object.keys(PROMPT_CATEGORY_LABELS)) {
    assert.ok((PROMPT_CATEGORIES as readonly string[]).includes(k), `label key ${k} not in PROMPT_CATEGORIES`);
  }
});

test("PROMPT_CATEGORY_GUIDES covers every key and nothing else", () => {
  for (const k of PROMPT_CATEGORIES) {
    assert.ok(PROMPT_CATEGORY_GUIDES[k], `missing guide for ${k}`);
  }
  for (const k of Object.keys(PROMPT_CATEGORY_GUIDES)) {
    assert.ok((PROMPT_CATEGORIES as readonly string[]).includes(k), `guide key ${k} not in PROMPT_CATEGORIES`);
  }
});
