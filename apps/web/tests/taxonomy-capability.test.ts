// W5-3 v0.2.1 — verify industry/taxonomy.ts has the 11 capability-axis categories (writing /
// coding / image / video / audio / agent / data / research / productivity / insight / other),
// the legacy 9 v0.2.0 event-type keys are GONE from CATEGORIES, and every legacy key is
// mapped to a current capability key by LEGACY_CATEGORY_REDIRECT. Pure unit, no DB.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CATEGORIES } from "@aihot/industry/taxonomy";
import {
  CATEGORY_LABELS,
  CATEGORY_KEYS,
  isCategoryKey,
  isLegacyCategoryKey,
  LEGACY_CATEGORY_REDIRECT,
  resolveCategoryKey,
  type CategoryKey,
} from "@aihot/contracts/taxonomy";

test("CATEGORIES has exactly 11 capability-axis keys", () => {
  assert.equal(CATEGORIES.length, 11, `expected 11 keys, got ${CATEGORIES.length}: ${CATEGORY_KEYS.join(",")}`);
});

test("every CATEGORIES key is a unique CategoryKey", () => {
  const seen = new Set<string>();
  for (const c of CATEGORIES) {
    assert.ok(!seen.has(c.key), `duplicate key ${c.key}`);
    seen.add(c.key);
    assert.equal(typeof c.label, "string");
    assert.ok(c.label.length > 0, `${c.key} has empty label`);
    assert.equal(typeof c.section, "string");
    assert.ok(typeof c.guide === "string" && c.guide.length > 0, `${c.key} missing guide`);
  }
});

test("legacy event-type keys are GONE from CATEGORIES", () => {
  const legacy = ["ai-models", "ai-products", "industry", "funding", "policy", "paper", "safety", "tip", "opinion"];
  for (const k of legacy) {
    assert.equal(isCategoryKey(k), false, `legacy key ${k} must NOT be a current CategoryKey`);
  }
});

test("new 11 capability-axis keys are all present", () => {
  const expected: readonly CategoryKey[] = [
    "writing", "coding", "image", "video", "audio",
    "agent", "data", "research", "productivity", "insight", "other",
  ];
  for (const k of expected) {
    assert.ok(isCategoryKey(k), `expected capability key missing: ${k}`);
  }
});

test("CATEGORY_LABELS covers every capability key", () => {
  for (const k of CATEGORY_KEYS) {
    assert.ok(CATEGORY_LABELS[k], `missing label for ${k}`);
  }
});

test("LEGACY_CATEGORY_REDIRECT still covers all 9 legacy keys", () => {
  const expected = ["ai-models", "ai-products", "industry", "funding", "policy", "paper", "safety", "tip", "opinion"];
  for (const k of expected) {
    assert.ok(LEGACY_CATEGORY_REDIRECT[k], `missing legacy mapping for ${k}`);
  }
});

test("LEGACY_CATEGORY_REDIRECT maps every legacy key to a current capability key", () => {
  for (const [legacy, mapped] of Object.entries(LEGACY_CATEGORY_REDIRECT)) {
    assert.ok(isCategoryKey(mapped), `${legacy} → ${mapped} but ${mapped} is not a current capability key`);
  }
});

test("isLegacyCategoryKey returns true only for the 9 legacy keys, never for new ones", () => {
  for (const k of ["ai-models", "opinion", "paper", "safety"]) {
    assert.ok(isLegacyCategoryKey(k), `${k} should be legacy`);
  }
  for (const k of CATEGORY_KEYS) {
    assert.equal(isLegacyCategoryKey(k), false, `current key ${k} must not be legacy`);
  }
  assert.equal(isLegacyCategoryKey(null), false);
  assert.equal(isLegacyCategoryKey(42), false);
  assert.equal(isLegacyCategoryKey(""), false);
});

test("resolveCategoryKey routes legacy keys to mapped capability keys", () => {
  assert.equal(resolveCategoryKey("ai-models"), "research");
  assert.equal(resolveCategoryKey("ai-products"), "other");
  assert.equal(resolveCategoryKey("industry"), "other");
  assert.equal(resolveCategoryKey("funding"), "other");
  assert.equal(resolveCategoryKey("policy"), "other");
  assert.equal(resolveCategoryKey("paper"), "research");
  assert.equal(resolveCategoryKey("safety"), "other");
  assert.equal(resolveCategoryKey("tip"), "writing");
  assert.equal(resolveCategoryKey("opinion"), "writing");
});

test("resolveCategoryKey passes through capability keys unchanged", () => {
  for (const k of CATEGORY_KEYS) {
    assert.equal(resolveCategoryKey(k), k, `${k} should pass through`);
  }
});

test("resolveCategoryKey returns null for unknown / non-string inputs", () => {
  assert.equal(resolveCategoryKey("not-a-key"), null);
  assert.equal(resolveCategoryKey(""), null);
  assert.equal(resolveCategoryKey(null), null);
  assert.equal(resolveCategoryKey(undefined), null);
  assert.equal(resolveCategoryKey(42), null);
  assert.equal(resolveCategoryKey({}), null);
});
