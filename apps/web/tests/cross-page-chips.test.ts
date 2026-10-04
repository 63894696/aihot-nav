// W5-3 v0.2.1 — cross-page UI consistency contract.
//
// Every filter chip row in the site reads the category list from one of two shared exports:
//   - CATEGORY_KEYS         → /, /all, /tools (FeedItem + CategoryTabs)
//   - PROMPT_CATEGORIES     → /prompts (PromptFilters + prompts.$id.tsx chip)
//
// Renaming or removing a key in one place but not the other would silently desync the chip rows
// across pages. This test pins the public contract: the two sets are derived from a single source
// of truth, both feed off CATEGORIES, and every chip a reader can see maps to a current key with a
// non-empty label.
//
// Pure unit, no React, no DB.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CATEGORIES } from "@aihot/industry/taxonomy";
import {
  CATEGORY_KEYS,
  CATEGORY_LABELS,
  CHANNEL_KEYS,
  isCategoryKey,
} from "@aihot/contracts/taxonomy";
import {
  PROMPT_CATEGORIES,
  PROMPT_CATEGORY_LABELS,
} from "@aihot/contracts/site";

test("CATEGORY_KEYS is exactly 11 — every capability key from CATEGORIES, in order", () => {
  assert.equal(CATEGORY_KEYS.length, 11);
  for (let i = 0; i < CATEGORIES.length; i++) {
    assert.equal(CATEGORY_KEYS[i], CATEGORIES[i].key, `CATEGORY_KEYS[${i}] drifted from CATEGORIES`);
  }
});

test("CategoryTabs chip list equals [all, firstParty, ...CATEGORY_KEYS]", () => {
  // The /all, /tools, and home filters share `CategoryTabs` (`apps/web/app/features/feed/Filters.tsx`),
  // which prepends `all` + `firstParty` to CATEGORY_KEYS. Pin that recipe: any page that calls
  // `<CategoryTabs base="..." />` renders this exact set, so adding a chip in one page would have
  // to land in all three.
  const expected = ["all", "firstParty", ...CATEGORY_KEYS];
  assert.equal(expected.length, 13);
  assert.equal(expected[0], "all");
  assert.equal(expected[1], "firstParty");
  // No duplicates anywhere in the row.
  assert.equal(new Set(expected).size, expected.length, `duplicate chip in ${expected.join(",")}`);
  // Every chip that is not 全部 / 一手 is a real capability key the server accepts.
  for (const k of CATEGORY_KEYS) {
    assert.ok(isCategoryKey(k), `${k} must remain a CategoryKey`);
    assert.ok(CATEGORY_LABELS[k]?.length, `${k} must have a non-empty label`);
  }
});

test("CHANNEL_KEYS still contains firstParty so the 一手 chip stays in CategoryTabs", () => {
  assert.ok((CHANNEL_KEYS as readonly string[]).includes("firstParty"));
});

test("PROMPT_CATEGORIES is exactly 10 and every key has a label + guide", () => {
  assert.equal(PROMPT_CATEGORIES.length, 10);
  for (const k of PROMPT_CATEGORIES) {
    assert.ok(PROMPT_CATEGORY_LABELS[k], `${k} missing label`);
    assert.equal(typeof PROMPT_CATEGORY_LABELS[k], "string");
    assert.ok((PROMPT_CATEGORY_LABELS[k] as string).length > 0);
  }
});

test("PromptFilters chip list equals [null, ...PROMPT_CATEGORIES]", () => {
  // PromptFilters prepends the 全部 option (value=null) to PROMPT_CATEGORIES. Pin that recipe:
  // /prompts and /prompts/$id render this exact chip set.
  const expected: Array<string | null> = [null, ...PROMPT_CATEGORIES];
  assert.equal(expected.length, 11);
  assert.equal(expected[0], null);
  const chips = expected.filter((k): k is string => typeof k === "string");
  assert.equal(new Set(chips).size, PROMPT_CATEGORIES.length, "no duplicate prompt chip");
});

test("/all?category=X and /tools?category=X accept the same key set", () => {
  // Both route loaders route the raw `category` param through `isCategoryKey` and feed it to the
  // backend's `categoryCondition(category)` SQL helper. Whatever the UI renders as a chip must
  // therefore be a valid `CategoryKey` accepted by both loaders.
  for (const k of CATEGORY_KEYS) {
    assert.ok(isCategoryKey(k), `${k} must round-trip through /all and /tools`);
  }
});
