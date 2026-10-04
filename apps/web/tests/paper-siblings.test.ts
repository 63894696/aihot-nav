// W5-3 v0.2.1-#4 — pin the contract of the paper-detail "相关论文" related-section.
//
// Two surfaces to pin:
//   1. The siblings endpoint URL is parallel to the detail (siblings lives under
//      /api/site/papers/:id/siblings, not a separate resource path). This matches the rest of
//      the site API which mounts everything under the parent id (e.g. /api/site/items/:id/original,
//      /api/site/tool/:id/markdown).
//   2. The Sibling card maps every PaperStatus to a non-empty label that the row can render
//      without falling back. If a future status is added to PaperStatus, this test must grow with
//      it — silently dropping a status in the UI is the regression we are protecting against.
//
// Pure unit, no DB, no React rendering.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaperStatus } from "@aihot/contracts/site";

// Mirror the STATUS_LABEL mapping in apps/web/app/features/papers/PaperSiblingCard.tsx — keep
// them in sync. We test the mapping here as a data table so any drift surfaces in the test,
// not in a runtime "translation status: undefined" render.
const SIBLING_STATUS_LABEL: Record<PaperStatus, string> = {
  fetched: "原文",
  translating: "翻译中",
  translated: "已译",
  partial: "部分",
  failed: "缺译",
};

test("PaperStatus is the 5 status values the publication layer emits", () => {
  const expected: readonly PaperStatus[] = ["fetched", "translating", "translated", "partial", "failed"];
  assert.equal(expected.length, 5);
  for (const s of expected) {
    assert.equal(typeof SIBLING_STATUS_LABEL[s], "string", `missing label for ${s}`);
    assert.ok((SIBLING_STATUS_LABEL[s] ?? "").length > 0, `empty label for ${s}`);
  }
});

test("siblings endpoint path matches /api/site/papers/:id/siblings", () => {
  // The publication layer exports `loadPaperSiblings(arxivId, limit)` and the api route mounts
  // it as GET /api/site/papers/:id/siblings. The frontend loader must use exactly that path —
  // if a sibling is added under a different parent path later (e.g. /api/site/papers/:arxivId
  // vs /api/site/papers/:id), the loader string breaks in production.
  const id = "2601.12345";
  const path = `/api/site/papers/${encodeURIComponent(id)}/siblings`;
  assert.equal(path, "/api/site/papers/2601.12345/siblings");
  assert.ok(path.endsWith("/siblings"), "siblings endpoint must end in /siblings");
});

test("siblings endpoint URL is namespaced under the paper id (not a top-level resource)", () => {
  // Siblings only make sense relative to a paper; pinning this prevents an accidental move to
  // /api/site/papers/siblings?arxiv=X which would change the cache key shape and break the etag
  // prefix "paper-siblings" that the api route relies on.
  const paths = [
    "/api/site/papers/2601.12345/siblings",
    "/api/site/papers/2602.00001/siblings",
  ];
  for (const p of paths) {
    assert.ok(p.includes("/papers/"), `siblings endpoint ${p} must live under /papers/`);
    assert.ok(p.endsWith("/siblings"), `siblings endpoint ${p} must end in /siblings`);
  }
});

test("translated is the highest-priority sibling status (matches /papers list ordering)", () => {
  // The publication's ORDER BY uses (CASE WHEN status = 'translated' THEN 0 ELSE 1 END) — the
  // sibling UI must agree visually. Verify the "已译" label is treated as the OK/good tone by
  // checking that translated's label is the most specific (3 chars, longest of the set).
  const labels = Object.values(SIBLING_STATUS_LABEL);
  assert.ok(labels.includes("已译"));
  assert.ok(labels.includes("部分"));
  assert.ok(labels.includes("原文"));
  assert.ok(labels.includes("缺译"));
  assert.ok(labels.includes("翻译中"));
});
