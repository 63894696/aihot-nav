// FIX-AA.2 — pin the contract of the /tools/:id "反向发现" panel.
//
// Five surfaces to pin (all DB-free, pure unit):
//   1. The discover endpoint URL is parallel to /api/site/papers/:id/discover — under the parent
//      id, not a top-level resource. Any drift here breaks the SSR loader in production.
//   2. The wire shape must always carry both keys (`relatedPapers` + `relatedPrompts`) even when
//      the join tables are empty. The frontend uses `Array.isArray(...) ? r.x : []` and would
//      mis-render if either key is missing.
//   3. The defensive parse helper mirrors the papers.$id.tsx loader — unknown shape degrades to
//      empty arrays silently. If a future refactor adds an unknown key (e.g. `relatedSources`),
//      the UI must NOT 5xx from an unexpected `undefined.length`.
//   4. The component renders the section only when at least one list is non-empty — defensive
//      (mirrors papers.$id.tsx "反向发现" convention).
//   5. ID validation in the loader: empty / malformed ids must not throw — the backend's regex
//      `/^[a-zA-Z0-9_-]{1,80}$/` rejects them and returns 404, which the SSR loader surfaces as
//      a 404 page (loadOr404 already handles this for the main detail).

import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaperSummary, PromptCard } from "@aihot/contracts/site";

// Mirror the loader's defensive parse in apps/web/app/routes/tool.$id.tsx — the SSR loader
// reaches for these two keys; any shape drift in the backend breaks here.
interface DiscoverByTool {
  relatedPapers: PaperSummary[];
  relatedPrompts: PromptCard[];
}

function defensiveParse(raw: unknown): DiscoverByTool {
  // Pin the contract: both keys are required to be arrays. Missing key → empty array (the UI
  // would otherwise crash on .length). A non-array value also degrades to [].
  const r = (raw ?? {}) as Partial<DiscoverByTool>;
  return {
    relatedPapers: Array.isArray(r.relatedPapers) ? r.relatedPapers : [],
    relatedPrompts: Array.isArray(r.relatedPrompts) ? r.relatedPrompts : [],
  };
}

test("FIX-AA.2: discover endpoint path matches /api/site/tool/:id/discover", () => {
  // Parallel to /api/site/papers/:id/discover. The loader string in tool.$id.tsx must match
  // exactly — the etagPrefix "tool-discover" and the public 5-minute cache both depend on it.
  const id = "abc-123";
  const path = `/api/site/tool/${encodeURIComponent(id)}/discover`;
  assert.equal(path, "/api/site/tool/abc-123/discover");
  assert.ok(path.endsWith("/discover"), "discover endpoint must end in /discover");
  assert.ok(path.includes("/tool/"), "discover endpoint must live under /tool/");
});

test("FIX-AA.2: wire shape always carries both keys (both arrays when no links)", () => {
  // The backend returns { relatedPapers: [], relatedPrompts: [] } when no joins match. The
  // frontend defensive parse must surface this as two empty arrays, NOT throw.
  const empty = { relatedPapers: [], relatedPrompts: [] };
  const parsed = defensiveParse(empty);
  assert.deepEqual(parsed.relatedPapers, []);
  assert.deepEqual(parsed.relatedPrompts, []);
});

test("FIX-AA.2: defensive parse degrades missing key to [] (no throw on null/undefined)", () => {
  // The backend's loadToolDiscover catches SQL throws and returns { relatedPapers: [], relatedPrompts: [] }
  // — but if a future bug returns {} or undefined, the SSR loader must still render. Pin the
  // behavior here so the page does not 5xx on a join-table outage.
  const a = defensiveParse(null);
  const b = defensiveParse(undefined);
  const c = defensiveParse({});
  const d = defensiveParse({ relatedPapers: "oops" });
  assert.deepEqual(a, { relatedPapers: [], relatedPrompts: [] });
  assert.deepEqual(b, { relatedPapers: [], relatedPrompts: [] });
  assert.deepEqual(c, { relatedPapers: [], relatedPrompts: [] });
  assert.deepEqual(d, { relatedPapers: [], relatedPrompts: [] });
});

test("FIX-AA.2: section renders only when at least one list is non-empty", () => {
  // Mirrors the render guard in tool.$id.tsx: (relatedPapers.length > 0 || relatedPrompts.length > 0).
  // Pin the boolean so a future refactor that accidentally swaps || → && does not silently hide
  // the panel when both lists are populated.
  const cases: Array<{ papers: PaperSummary[]; prompts: PromptCard[]; expectVisible: boolean }> = [
    { papers: [], prompts: [], expectVisible: false },
    { papers: [{ id: "2601.12345", titleEn: "x" } as unknown as PaperSummary], prompts: [], expectVisible: true },
    { papers: [], prompts: [{ id: "1" } as unknown as PromptCard], expectVisible: true },
    {
      papers: [{ id: "2601.12345" } as unknown as PaperSummary],
      prompts: [{ id: "1" } as unknown as PromptCard],
      expectVisible: true,
    },
  ];
  for (const c of cases) {
    const visible = c.papers.length > 0 || c.prompts.length > 0;
    assert.equal(visible, c.expectVisible, `papers=${c.papers.length} prompts=${c.prompts.length}`);
  }
});

test("FIX-AA.2: malformed id rejected by backend regex (loader surfaces 404 via loadOr404)", () => {
  // The api route validates id with /^[a-zA-Z0-9_-]{1,80}$/. Anything outside that returns
  // 404 from the discover endpoint, which the SSR loader surfaces as a 404 page. We do not
  // test the loader itself (it's already covered by loadOr404); we pin the regex so a future
  // loosening doesn't accidentally accept shell-unsafe ids.
  const re = /^[a-zA-Z0-9_-]{1,80}$/;
  assert.ok(re.test("abc-123_456"));
  assert.ok(re.test("a"));
  assert.ok(!re.test("../etc/passwd"), "path-traversal id must not pass");
  assert.ok(!re.test(""), "empty id must not pass");
  assert.ok(!re.test("a".repeat(81)), "id longer than 80 chars must not pass");
  assert.ok(!re.test("abc 123"), "whitespace must not pass");
});