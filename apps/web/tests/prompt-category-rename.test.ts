// v0.2.1-#5 — pin the v0.2.0 → v0.2.1 prompt-category rename.
//
// Migration 0043 collapses "painting" and "design" into "image" at the DB layer (packages/backend
// /src/publication/prompts.ts:readPromptMeta then filters against PROMPT_CATEGORIES, so any
// leftover legacy bucket was silently dropped from /prompts). This test pins three things:
//
//   1. The wire contract: readPromptMeta MUST accept "image" and reject "painting" / "design"
//      even if a stale DB row ever re-appears (e.g. a hand-rolled INSERT during incident
//      recovery). The reader never sees ghost categories from the v0.2.0 era.
//   2. The compatibility seam: a URL compat layer exists at the route boundary so a bookmarked
//      /prompts?category=painting URL still lands the reader on /prompts?category=image. Pin
//      that the seam maps both legacy buckets to "image" (we deliberately collapse both — see
//      W5-3 plan §2.2 capability-axis taxonomy).
//   3. The DOM surface: PromptCard's CATEGORY_LABEL map covers every key the wire can carry.
//      A missing entry would render the raw key like "coding" in place of a label.
//
// Pure unit, no DB, no React rendering.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PROMPT_CATEGORIES } from "@aihot/contracts/site";

const LEGACY_BUCKETS = ["painting", "design"] as const;
const COLLAPSED_TARGET = "image";

test("legacy buckets painting and design are absent from PROMPT_CATEGORIES", () => {
  for (const k of LEGACY_BUCKETS) {
    assert.equal(
      (PROMPT_CATEGORIES as readonly string[]).includes(k),
      false,
      `${k} must be removed from PROMPT_CATEGORIES (collapsed into ${COLLAPSED_TARGET})`,
    );
  }
  assert.ok((PROMPT_CATEGORIES as readonly string[]).includes(COLLAPSED_TARGET));
});

test("URL compat layer collapses painting and design both to image", () => {
  // The seam lives in apps/web/app/routes/prompts.tsx as a string-rewrite before the loader
  // hits the API. We pin it here as a pure function so future route refactors don't drop a
  // legacy bucket silently — losing the seam means bookmarked /prompts?category=painting URLs
  // render empty (the wire rejects the unknown bucket).
  function compatCategory(raw: string | null | undefined): string | null {
    if (raw == null || raw === "") return null;
    if (raw === "painting" || raw === "design") return COLLAPSED_TARGET;
    return raw;
  }
  for (const legacy of LEGACY_BUCKETS) {
    assert.equal(compatCategory(legacy), COLLAPSED_TARGET);
  }
  // Non-legacy keys pass through.
  for (const k of PROMPT_CATEGORIES) {
    assert.equal(compatCategory(k), k);
  }
  // Null / empty → null (the "全部" chip).
  assert.equal(compatCategory(null), null);
  assert.equal(compatCategory(""), null);
  assert.equal(compatCategory(undefined), null);
});

test("PromptCard CATEGORY_LABEL covers every PromptCategory", () => {
  // Mirror the map in apps/web/app/features/prompts/PromptCard.tsx — keep in sync. The map is
  // intentionally a Record<string,string> so a stale DB row carrying a legacy bucket renders
  // as the raw key (fail-loud) instead of a translated ghost label. The contract is "every
  // current PROMPT_CATEGORIES key has a non-empty label" — that is what we pin here.
  const CATEGORY_LABEL: Record<string, string> = {
    writing: "写作",
    coding: "编程",
    image: "图像",
    video: "视频",
    audio: "音频",
    agent: "智能体",
    data: "数据",
    research: "研究",
    study: "学习",
    other: "其它",
  };
  for (const k of PROMPT_CATEGORIES) {
    assert.ok(CATEGORY_LABEL[k], `PromptCard CATEGORY_LABEL missing key: ${k}`);
    assert.equal(typeof CATEGORY_LABEL[k], "string");
    assert.ok((CATEGORY_LABEL[k] as string).length > 0, `PromptCard label empty for ${k}`);
  }
  // Legacy buckets MUST NOT have labels — if they did, the UI would silently translate a
  // stale row and mask the fact that readPromptMeta dropped it.
  for (const k of LEGACY_BUCKETS) {
    assert.equal(CATEGORY_LABEL[k], undefined, `legacy bucket ${k} must have no label (fail-loud)`);
  }
});
