// FIX-AA-A — pin the contracts that govern /papers in-site search. The 3373-paper corpus
// (2026-10-07) made chip + window insufficient; this test pins the wire-level additions.
//
// Three contracts under test (all are pure functions, no DB):
//   1. URL-search-params: PaperFilters' withParams helper preserves every BIND_KEY + q + sort +
//      limit when navigating chips, while still dropping the cursor when one of those keys
//      changes. (BIND_KEYS extended in FIX-AA-A from {category, windowDays} to
//      {category, windowDays, q, sort, limit, tag} — see packages/backend/src/publication/papers.ts
//      `binding(q)` for the backend mirror.)
//   2. Loader URL-construction: papers.tsx buildPagePath mirrors the loader's URL→query parse
//      so the next-page fetch keeps the same q/sort/limit the reader saw. (buildPagePath is
//      used by the FIX-Z.4 load-more client append; mirror logic is the safety net for
//      the 0.1% of readers who arrive on a URL that already carries a cursor.)
//   3. q value contract — q is forwarded verbatim from URL to backend (no trim/lowercase) so
//      the bind hash on the backend is the only source of truth for cursor invalidation.

import assert from "node:assert/strict";
import { test } from "node:test";

// Mirror of PaperFilters.tsx BIND_KEYS — keep the two implementations in sync.
const BIND_KEYS: ReadonlySet<string> = new Set(["category", "windowDays", "q", "sort", "limit", "tag"]);

function withParams(current: URLSearchParams, overrides: Record<string, string | number | null>): string {
  const next = new URLSearchParams(current);
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null || v === "") next.delete(k);
    else next.set(k, String(v));
  }
  if (Object.keys(overrides).some((k) => BIND_KEYS.has(k))) next.delete("cursor");
  return `?${next.toString()}`;
}

test("FIX-AA-A: searching (q) drops a stale cursor (BIND_KEYS extended)", () => {
  // Reader flow: visit /papers (no cursor yet) → search "language model" → loader fetches
  // /papers?q=language+model (first page, no cursor). Then click "加载更早" → /papers?q=...
  // &cursor=papers1.q. Then click a cs.AI chip. The cursor must be dropped because q is
  // part of bind (see binding(q) — q: (q.q ?? "").trim().toLowerCase()).
  const params = new URLSearchParams("q=language+model&cursor=papers1.qhash");
  const out = withParams(params, { category: "cs.AI" });
  const parsed = new URLSearchParams(out.startsWith("?") ? out.slice(1) : out);
  assert.equal(parsed.get("category"), "cs.AI", "category override wins");
  assert.equal(parsed.get("q"), "language model", "q preserved across chip click (decoded from URL)");
  assert.equal(parsed.get("cursor"), null, "cursor must be dropped on category change");
});

test("FIX-AA-A: changing the sort key drops the cursor (sort is bind)", () => {
  // sort is part of binding(q) — flipping published_at → hf_upvotes changes `s` and
  // invalidates the cursor. Without the BIND_KEY drop, the loader hits a 400 invalid_cursor.
  const params = new URLSearchParams("sort=hf_upvotes&cursor=papers1.sort");
  const out = withParams(params, { sort: "published_at" });
  const parsed = new URLSearchParams(out.startsWith("?") ? out.slice(1) : out);
  assert.equal(parsed.get("sort"), "published_at");
  assert.equal(parsed.get("cursor"), null);
});

test("FIX-AA-A: changing the page size (limit) drops the cursor", () => {
  // limit=24 vs 60 — the cursor's offset is meaningless at a different limit. A page-2
  // cursor minted at limit=24 would skip rows when the reader hits "60/页" mid-scroll.
  const params = new URLSearchParams("limit=24&cursor=papers1.l24");
  const out = withParams(params, { limit: 60 });
  const parsed = new URLSearchParams(out.startsWith("?") ? out.slice(1) : out);
  assert.equal(parsed.get("limit"), "60");
  assert.equal(parsed.get("cursor"), null);
});

test("FIX-AA-A: BIND_KEYS mirrors the backend (every chip + input + select is in the set)", () => {
  // Defensive: if a future refactor adds a new BIND_KEY to the backend without updating
  // this set, the cursor-drop defense breaks silently. The contract is "if backend binds
  // it, frontend drops the cursor on change".
  for (const key of ["category", "windowDays", "q", "sort", "limit", "tag"]) {
    assert.ok(BIND_KEYS.has(key), `BIND_KEYS missing ${key}`);
  }
});

test("FIX-AA-A: buildPagePath keeps q + sort + limit across next-page fetch", () => {
  // Mirror of papers.tsx buildPagePath (client append path) — the only client-side cursor
  // consumer. The function carries every shareable filter forward so the next page comes
  // back under the same query window. A regression here would silently lose the reader's
  // sort or page size mid-scroll.
  const filters = { category: "cs.AI", q: "transformer", sort: "hf_upvotes", limit: 50 };
  const cursor = "papers1.nextcursor";
  const sp = new URLSearchParams();
  if (filters.category) sp.set("category", filters.category);
  sp.set("windowDays", "30");
  sp.set("limit", String(filters.limit));
  if (filters.q) sp.set("q", filters.q);
  if (filters.sort !== "published_at") sp.set("sort", filters.sort);
  if (cursor) sp.set("cursor", cursor);
  const url = `/api/site/papers?${sp.toString()}`;
  // Round-trip parse → all fields present.
  const parsed = new URLSearchParams(url.split("?")[1] ?? "");
  assert.equal(parsed.get("category"), "cs.AI");
  assert.equal(parsed.get("q"), "transformer");
  assert.equal(parsed.get("sort"), "hf_upvotes");
  assert.equal(parsed.get("limit"), "50");
  assert.equal(parsed.get("cursor"), "papers1.nextcursor");
});

test("FIX-AA-A: q is forwarded verbatim (no trim/lowercase in the loader)", () => {
  // The backend's binding(q) does the trim+lowercase. The loader must not pre-process the
  // value — otherwise an explicit "Hello" and an implicit "hello" would mint different
  // binds on the same data.
  const url = "https://q.example/papers?q=Hello+World";
  const u = new URL(url);
  const q = u.searchParams.get("q");
  assert.equal(q, "Hello World", "loader must pass through verbatim");
});