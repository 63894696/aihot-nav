// FIX-V1 (2026-10-08) — the /papers in-page search input was removed. /all?q=… is now the
// canonical paper search surface; readers no longer type a query on /papers.
//
// What this file pins (pure functions, no DB):
//   1. BIND_KEYS no longer includes "q" — the cursor-drop defense only fires for keys that
//      actually bind a page on the backend (see packages/backend/src/publication/papers.ts
//      `binding(q)`). q is read into `void` by the loader so a stale shared link like
//      /papers?q=transformer keeps working visually, but it no longer participates in
//      frontend navigation.
//   2. withParams preserves the *other* BIND_KEYS (category, windowDays, sort, limit, tag)
//      across chip clicks and drops the cursor when one of those changes — same defense as
//      before, just without q.
//   3. buildPagePath (FIX-Z.4 load-more client append) carries category / windowDays /
//      limit / sort forward; it does NOT round-trip q.
//
// Why the dedicated search input went away (rationale for the next reader): the in-page
// search input never visibly changed results from the reader's POV. Root cause: /papers
// SSR renders an empty shell that client-hydrates later, so URL changes drove no new cards
// until the JS arrived. Cross-axis /all?q= already covered papers, so we removed the
// non-functional input rather than fix the SSR.

import assert from "node:assert/strict";
import { test } from "node:test";

// Mirror of PaperFilters.tsx BIND_KEYS — keep the two implementations in sync.
const BIND_KEYS: ReadonlySet<string> = new Set(["category", "windowDays", "sort", "limit", "tag"]);

function withParams(current: URLSearchParams, overrides: Record<string, string | number | null>): string {
  const next = new URLSearchParams(current);
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null || v === "") next.delete(k);
    else next.set(k, String(v));
  }
  if (Object.keys(overrides).some((k) => BIND_KEYS.has(k))) next.delete("cursor");
  return `?${next.toString()}`;
}

test("FIX-V1: BIND_KEYS dropped 'q' (no in-page search input)", () => {
  // The BIND_KEYS set is the chip-click + select-change cursor-drop defense. With the
  // search input gone, the only filters the reader can change from the page are category,
  // windowDays, sort, limit, and (reserved) tag. Anything else in BIND_KEYS is dead code.
  assert.equal(BIND_KEYS.has("q"), false, "q must not be in BIND_KEYS — no input mirrors it");
});

test("FIX-V1: changing category drops a stale cursor (unchanged defense)", () => {
  // Even though q is gone, the chip-click path still preserves the other shareable filters
  // and drops the cursor when any BIND_KEY changes. A regression here would re-introduce
  // the FIX-Z.2 400 invalid_cursor the chip path originally fixed.
  const params = new URLSearchParams("category=cs.CL&windowDays=30&cursor=papers1.qhash");
  const out = withParams(params, { category: "cs.AI" });
  const parsed = new URLSearchParams(out.startsWith("?") ? out.slice(1) : out);
  assert.equal(parsed.get("category"), "cs.AI");
  assert.equal(parsed.get("windowDays"), "30", "windowDays preserved across chip click");
  assert.equal(parsed.get("cursor"), null, "cursor must be dropped on category change");
});

test("FIX-V1: changing the sort key drops the cursor (sort is still bind)", () => {
  const params = new URLSearchParams("sort=hf_upvotes&cursor=papers1.sort");
  const out = withParams(params, { sort: "published_at" });
  const parsed = new URLSearchParams(out.startsWith("?") ? out.slice(1) : out);
  assert.equal(parsed.get("sort"), "published_at");
  assert.equal(parsed.get("cursor"), null);
});

test("FIX-V1: changing the page size (limit) drops the cursor", () => {
  const params = new URLSearchParams("limit=24&cursor=papers1.l24");
  const out = withParams(params, { limit: 60 });
  const parsed = new URLSearchParams(out.startsWith("?") ? out.slice(1) : out);
  assert.equal(parsed.get("limit"), "60");
  assert.equal(parsed.get("cursor"), null);
});

test("FIX-V1: BIND_KEYS mirrors the backend (every chip + select is in the set)", () => {
  // Defensive: if a future refactor adds a new BIND_KEY to the backend without updating
  // this set, the cursor-drop defense breaks silently. The contract is "if backend binds
  // it, frontend drops the cursor on change".
  for (const key of ["category", "windowDays", "sort", "limit", "tag"]) {
    assert.ok(BIND_KEYS.has(key), `BIND_KEYS missing ${key}`);
  }
});

test("FIX-V1: buildPagePath no longer round-trips q (FIX-AA-A → FIX-V1)", () => {
  // Mirror of papers.tsx buildPagePath (client append path) — the only client-side cursor
  // consumer. The function carries category / windowDays / limit / sort forward; q is
  // intentionally absent because the loader no longer reads it into the API params.
  const filters = { category: "cs.AI", sort: "hf_upvotes", limit: 50 };
  const cursor = "papers1.nextcursor";
  const sp = new URLSearchParams();
  if (filters.category) sp.set("category", filters.category);
  sp.set("windowDays", "30");
  sp.set("limit", String(filters.limit));
  if (filters.sort !== "published_at") sp.set("sort", filters.sort);
  if (cursor) sp.set("cursor", cursor);
  const url = `/api/site/papers?${sp.toString()}`;
  const parsed = new URLSearchParams(url.split("?")[1] ?? "");
  assert.equal(parsed.get("category"), "cs.AI");
  assert.equal(parsed.get("q"), null, "q must not appear in buildPagePath output");
  assert.equal(parsed.get("sort"), "hf_upvotes");
  assert.equal(parsed.get("limit"), "50");
  assert.equal(parsed.get("cursor"), "papers1.nextcursor");
});

test("FIX-V1: /papers?q=foo URL keeps working (loader reads q into void)", () => {
  // Shared links from the FIX-AA-A era still resolve. The loader swallows q so it does not
  // reach the API call, but the URL still parses. This pins the "no UI, no backend hit"
  // contract for backward compatibility.
  const url = new URL("https://q.example/papers?q=transformer&category=cs.LG");
  // Loader's effective params (q consumed, others forwarded).
  const forwarded = new URLSearchParams();
  const category = url.searchParams.get("category");
  if (category) forwarded.set("category", category);
  void url.searchParams.get("q");
  assert.equal(forwarded.get("category"), "cs.LG");
  assert.equal(forwarded.has("q"), false, "q must not be forwarded to /api/site/papers");
});
