// W5-3 v0.2.1 — verify the LEGACY_CATEGORY_REDIRECT map and resolveCategoryKey() correctly route
// the 9 v0.2.0 event-type keys to their v0.2.1 capability-axis counterparts. Pure unit, no DB.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isLegacyCategoryKey,
  LEGACY_CATEGORY_REDIRECT,
  resolveCategoryKey,
} from "@aihot/contracts/taxonomy";
import { legacyCategoryRedirect } from "../app/lib/categoryCompat.ts";

test("LEGACY_CATEGORY_REDIRECT covers all 9 v0.2.0 event-type keys", () => {
  const expected = ["ai-models", "ai-products", "industry", "funding", "policy", "paper", "safety", "tip", "opinion"];
  for (const k of expected) {
    assert.ok(LEGACY_CATEGORY_REDIRECT[k], `missing legacy mapping for ${k}`);
  }
});

test("isLegacyCategoryKey returns true only for the 9 legacy keys", () => {
  assert.ok(isLegacyCategoryKey("ai-models"));
  assert.ok(isLegacyCategoryKey("opinion"));
  // "research" and "writing" are NOW current capability keys (v0.2.1), not legacy.
  assert.ok(!isLegacyCategoryKey("not-a-legacy-key"));
  assert.ok(!isLegacyCategoryKey(null));
  assert.ok(!isLegacyCategoryKey(undefined));
  assert.ok(!isLegacyCategoryKey(42));
  assert.ok(!isLegacyCategoryKey(""));
});

test("resolveCategoryKey maps every legacy key to a non-null current key", () => {
  for (const [legacy, mapped] of Object.entries(LEGACY_CATEGORY_REDIRECT)) {
    assert.equal(resolveCategoryKey(legacy), mapped, `${legacy} → ${mapped}`);
  }
});

test("resolveCategoryKey passes through unknown-but-non-empty as null", () => {
  assert.equal(resolveCategoryKey("not-a-key"), null);
  assert.equal(resolveCategoryKey(""), null);
  assert.equal(resolveCategoryKey(null), null);
  assert.equal(resolveCategoryKey(undefined), null);
});

test("resolveCategoryKey passes through non-string inputs as null", () => {
  assert.equal(resolveCategoryKey(42), null);
  assert.equal(resolveCategoryKey({}), null);
  assert.equal(resolveCategoryKey([]), null);
});

test("legacyCategoryRedirect returns URL only for legacy keys", () => {
  assert.equal(legacyCategoryRedirect(null, "/all"), null);
  assert.equal(legacyCategoryRedirect("", "/all"), null);
  assert.equal(legacyCategoryRedirect("ai-models", "/all"), "/all?category=research");
  assert.equal(legacyCategoryRedirect("opinion", "/tools"), "/tools?category=writing");
});

test("legacyCategoryRedirect passes through current capability keys as null (no redirect needed)", () => {
  // "research" and "writing" are current keys (v0.2.1) → no redirect.
  assert.equal(legacyCategoryRedirect("research", "/all"), null);
  assert.equal(legacyCategoryRedirect("writing", "/tools"), null);
  assert.equal(legacyCategoryRedirect("coding", "/tools"), null);
  assert.equal(legacyCategoryRedirect("other", "/all"), null);
});
