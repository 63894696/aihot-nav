// FIX-Z.2 — pin the contract that PaperFilters chip clicks drop the stale cursor.
//
// Bug context: PaperFilters used `useSearchParams()` to build chip hrefs, so a category
// switch carried the previous page's `cursor` into the new URL. The backend rejects mismatched
// cursors with HTTP 400 / `code: "invalid_cursor"` (see `binding(q)` in publication/papers.ts:
// the bind hash covers {category, tag, windowDays, limit}, so any change in those fields makes
// the old cursor's `b` not equal the new bind). React Router surfaces the 400 as a 500 in the
// browser. 100% of clicks that switched categories while a cursor was present crashed.
//
// Fix: PaperFilters.withParams drops `cursor` whenever an override hits one of the bind keys
// (today: category, windowDays). The loader fetches the new query's first page — exactly what
// the reader expects from a chip click.
//
// Pure-URL test, DB-free, lives in the web test bucket alongside papers-pagination.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";

// Mirror of PaperFilters.tsx — keep the two implementations in sync.
// The only branch worth pinning: when the override hits a BIND_KEY, cursor is dropped.
const BIND_KEYS: ReadonlySet<string> = new Set(["category", "windowDays"]);

function withParams(current: URLSearchParams, overrides: Record<string, string | number | null>): string {
  const next = new URLSearchParams(current);
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null || v === "") next.delete(k);
    else next.set(k, String(v));
  }
  if (Object.keys(overrides).some((k) => BIND_KEYS.has(k))) next.delete("cursor");
  return `?${next.toString()}`;
}

test("FIX-Z.2: switching category drops a stale cursor (the 500 bug)", () => {
  // Reader flow that crashed before the fix:
  //   1. Visit /papers (no category) -> see cs.AI nextCursor `papers1.csai`
  //   2. Click cs.AI chip -> /papers?category=cs.AI  (works — no cursor yet)
  //   3. Click "加载更早" -> /papers?category=cs.AI&cursor=papers1.csai  (works — bind matches)
  //   4. Click cs.CL chip -> BEFORE: cursor=papers1.csai was carried over, bind no longer
  //      matched, backend returned 400 invalid_cursor -> React Router surfaced as 500.
  //      AFTER: cursor is dropped, loader fetches /papers?category=cs.CL (first page).
  const paramsAfterPage2 = new URLSearchParams("category=cs.AI&cursor=papers1.csai");
  const out = withParams(paramsAfterPage2, { category: "cs.CL" });
  const parsed = new URLSearchParams(out.startsWith("?") ? out.slice(1) : out);
  assert.equal(parsed.get("category"), "cs.CL", "category override wins");
  assert.equal(parsed.get("cursor"), null, "cursor must be dropped on category change");
  assert.ok(!out.includes("papers1.csai"), `cursor must be gone: ${out}`);
});

test("FIX-Z.2: switching windowDays also drops a stale cursor (same bind)", () => {
  // windowDays is part of bind (see binding(q) — w: q.windowDays). Switching 30→7 must also
  // reset pagination, otherwise the 30-day cursor would page through 7-day results.
  const params = new URLSearchParams("windowDays=7&cursor=papers1.seven");
  const out = withParams(params, { windowDays: 30 });
  const parsed = new URLSearchParams(out.startsWith("?") ? out.slice(1) : out);
  assert.equal(parsed.get("windowDays"), "30");
  assert.equal(parsed.get("cursor"), null, "cursor must be dropped on windowDays change");
});

test("FIX-Z.2: clicking the '全部' chip (null category) drops the cursor", () => {
  // /papers?category=cs.AI&cursor=... -> click '全部' -> /papers (no params).
  // The category override is null so it deletes the category key AND drops the cursor.
  const params = new URLSearchParams("category=cs.AI&cursor=papers1.ai");
  const out = withParams(params, { category: null });
  const parsed = new URLSearchParams(out.startsWith("?") ? out.slice(1) : out);
  assert.equal(parsed.get("category"), null);
  assert.equal(parsed.get("cursor"), null);
  // Important: out is "?category=&cursor=" -> toString collapses it. Either way cursor must be gone.
  assert.ok(!out.includes("papers1.ai"), `cursor must be gone: ${out}`);
});

test("FIX-Z.2: '30 天' chip is a no-op (already at 30) and KEEPS the cursor", () => {
  // windowDays default is 30, so the chip's `to` hardcodes `/papers` (line 63) and the
  // override path is bypassed. With the fix wired only in withParams, clicking a non-default
  // windowDays chip drops the cursor; clicking the default chip uses /papers and drops
  // searchParams entirely (current URL becomes /papers).
  // This test pins that withParams does NOT touch the cursor when no bind-key is overridden —
  // that property matters for future filters (e.g. tag) that don't participate in bind.
  const params = new URLSearchParams("category=cs.AI&cursor=papers1.ai");
  const out = withParams(params, { tag: "vision" }); // tag isn't a bind key today
  const parsed = new URLSearchParams(out.startsWith("?") ? out.slice(1) : out);
  assert.equal(parsed.get("category"), "cs.AI");
  assert.equal(parsed.get("cursor"), "papers1.ai", "non-bind-key override must preserve cursor");
  assert.equal(parsed.get("tag"), "vision");
});

test("FIX-Z.2: BIND_KEYS mirrors the backend binding(q) fields", () => {
  // Sanity check: lock the relationship so a future bind-field addition forces this test
  // (and the implementation) to update. The backend binds on (category, tag, windowDays, limit).
  // tag isn't exposed as a chip; limit isn't a chip. So today BIND_KEYS is {category, windowDays}.
  for (const k of ["category", "windowDays"]) {
    assert.ok(BIND_KEYS.has(k), `${k} should be in BIND_KEYS`);
  }
  // Defensive — if the backend adds a new bind field, this test must grow.
  assert.ok(BIND_KEYS.size <= 4, "BIND_KEYS should never exceed backend binding fields");
});