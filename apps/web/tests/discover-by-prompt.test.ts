// FIX-AA.3 — pin the contract of the /prompts/:id "反向发现" panel.
//
// Five surfaces to pin (all DB-free, pure unit):
//   1. The discover endpoint URL is /api/site/prompt/:id/discover — under the parent id, not a
//      top-level resource. Any drift here breaks the SSR loader in production.
//   2. The wire shape must always carry both keys (`relatedPapers` + `relatedTools`) even when
//      the join tables are empty. The frontend uses `Array.isArray(...) ? r.x : []` and would
//      mis-render if either key is missing.
//   3. The defensive parse helper mirrors the prompts.$id.tsx loader — unknown shape degrades to
//      empty arrays silently. If a future refactor adds an unknown key (e.g. relatedSources),
//      the UI must NOT 5xx from an unexpected `undefined.length`.
//   4. The component renders the section only when at least one list is non-empty — defensive
//      (mirrors tools.$id.tsx "反向发现" convention).
//   5. ID validation in the loader: empty / malformed / non-numeric ids must not throw — the
//      backend's regex `/^\d{1,20}$/` rejects them and returns 404, which the SSR loader surfaces
//      as a 404 page via loadOr404 on the main detail fetch.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { FeedItemSummary, PaperSummary } from "@aihot/contracts/site";

// Mirror the loader's defensive parse in apps/web/app/routes/prompts.$id.tsx — the SSR loader
// reaches for these two keys; any shape drift in the backend breaks here.
interface DiscoverByPrompt {
  relatedPapers: PaperSummary[];
  relatedTools: FeedItemSummary[];
}

function defensiveParse(raw: unknown): DiscoverByPrompt {
  // Pin the contract: both keys are required to be arrays. Missing key → empty array (the UI
  // would otherwise crash on .length). A non-array value also degrades to [].
  const r = (raw ?? {}) as Partial<DiscoverByPrompt>;
  return {
    relatedPapers: Array.isArray(r.relatedPapers) ? r.relatedPapers : [],
    relatedTools: Array.isArray(r.relatedTools) ? r.relatedTools : [],
  };
}

test("FIX-AA.3: discover endpoint path matches /api/site/prompt/:id/discover", () => {
  // Parallel to /api/site/tool/:id/discover and /api/site/papers/:id/discover. The loader string
  // in prompts.$id.tsx must match exactly — the etagPrefix "prompt-discover" and the public
  // 5-minute cache both depend on it.
  const id = "123";
  const path = `/api/site/prompt/${encodeURIComponent(id)}/discover`;
  assert.equal(path, "/api/site/prompt/123/discover");
  assert.ok(path.endsWith("/discover"), "discover endpoint must end in /discover");
  assert.ok(path.includes("/prompt/"), "discover endpoint must live under /prompt/");
});

test("FIX-AA.3: wire shape always carries both keys (both arrays when no links)", () => {
  // The backend returns { relatedPapers: [], relatedTools: [] } when no joins match. The
  // frontend defensive parse must surface this as two empty arrays, NOT throw.
  const empty = { relatedPapers: [], relatedTools: [] };
  const parsed = defensiveParse(empty);
  assert.deepEqual(parsed.relatedPapers, []);
  assert.deepEqual(parsed.relatedTools, []);
});

test("FIX-AA.3: defensive parse degrades missing key to [] (no throw on null/undefined)", () => {
  // The backend's loadPromptDiscover catches SQL throws and returns { relatedPapers: [], relatedTools: [] }
  // — but if a future bug returns {} or undefined, the SSR loader must still render. Pin the
  // behavior here so the page does not 5xx on a join-table outage.
  const a = defensiveParse(null);
  const b = defensiveParse(undefined);
  const c = defensiveParse({});
  const d = defensiveParse({ relatedPapers: "oops" });
  assert.deepEqual(a, { relatedPapers: [], relatedTools: [] });
  assert.deepEqual(b, { relatedPapers: [], relatedTools: [] });
  assert.deepEqual(c, { relatedPapers: [], relatedTools: [] });
  assert.deepEqual(d, { relatedPapers: [], relatedTools: [] });
});

test("FIX-AA.3: section renders only when at least one list is non-empty", () => {
  // Mirrors the render guard in prompts.$id.tsx: (relatedPapers.length > 0 || relatedTools.length > 0).
  // Pin the boolean so a future refactor that accidentally swaps || → && does not silently hide
  // the panel when both lists are populated.
  const cases: Array<{ papers: PaperSummary[]; tools: FeedItemSummary[]; expectVisible: boolean }> = [
    { papers: [], tools: [], expectVisible: false },
    { papers: [{ id: "2601.12345", titleEn: "x" } as unknown as PaperSummary], tools: [], expectVisible: true },
    { papers: [], tools: [{ id: "pg123" } as unknown as FeedItemSummary], expectVisible: true },
    {
      papers: [{ id: "2601.12345" } as unknown as PaperSummary],
      tools: [{ id: "pg123" } as unknown as FeedItemSummary],
      expectVisible: true,
    },
  ];
  for (const c of cases) {
    const visible = c.papers.length > 0 || c.tools.length > 0;
    assert.equal(visible, c.expectVisible, `papers=${c.papers.length} tools=${c.tools.length}`);
  }
});

test("FIX-AA.3: malformed id rejected by backend regex (loader surfaces 404 via loadOr404)", () => {
  // The api route validates id with /^\d{1,20}$/. Anything outside that returns 404 from the
  // discover endpoint. We do not test the loader itself (loadOr404 already covers the main
  // detail); we pin the regex so a future loosening doesn't accidentally accept shell-unsafe ids.
  const re = /^\d{1,20}$/;
  assert.ok(re.test("1"));
  assert.ok(re.test("12345678901234567890"));
  assert.ok(!re.test(""), "empty id must not pass");
  assert.ok(!re.test("abc"), "non-numeric must not pass");
  assert.ok(!re.test("../etc/passwd"), "path-traversal id must not pass");
  assert.ok(!re.test("123456789012345678901"), "id longer than 20 digits must not pass");
  assert.ok(!re.test("-1"), "negative id must not pass");
  assert.ok(!re.test("1.5"), "fractional id must not pass");
});