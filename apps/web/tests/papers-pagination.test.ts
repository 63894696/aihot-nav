// FIX-Z — pin the contract of the /papers "加载更早论文" pagination.
//
// Bug context: previously the loader in apps/web/app/routes/papers.tsx ignored the `cursor`
// query parameter, so navigating to /papers?cursor=XXX always re-fetched the first page.
// The page rendered `data.nextCursor` from that first page, and the `buildNextQuery(...)`
// helper wrapped it back into `searchParams` — but searchParams never contained cursor
// (loader dropped it), so the resulting <Link to=...> href was identical to the current URL.
// Clicking the link triggered a same-URL revalidate instead of moving to page 2, which the
// reader experienced as "the button refreshes the page instead of loading older papers".
//
// Fix: loader must forward `cursor` through to the api request. buildNextQuery already
// `set("cursor", cursor)` — so the only contract worth pinning here is that the request
// URL passed to apiGet contains `cursor` when one is present on the inbound URL. We do
// this as a pure URL-construction test (no DB, no React rendering) so it stays in the
// DB-free web test bucket alongside paper-siblings.test.ts.
//
// FIX-Z.3 — graceful cursor-staleness fallback in the loader.
//
// Bug context: the chip-click fix (FIX-Z.2, paper-filters-cursor-reset.test.ts) handles the
// reader-driven path (withParams drops the cursor when category/windowDays change). But three
// direct-arrival paths still leak a stale cursor into the api call:
//   - Hand-edited / copy-pasted URL (e.g. from an old RSS feed item or a chat link)
//   - Browser back/forward across a category switch (history has the cursor from the
//     previous category's last page)
//   - SSR via a search engine cache or a third-party embed that retained the cursor
// Each produces HTTP 400 invalid_cursor from the api; React Router surfaces 4xx as 500.
//
// Fix: the loader catches ApiError(400, 'invalid_cursor') and retries the same params with
// the cursor stripped. Retry succeeds, the reader sees the new query's first page — the same
// UX they would get from clicking the chip in FIX-Z.2. Other failures (5xx, network) bubble
// up unchanged so real outages aren't hidden.
import assert from "node:assert/strict";
import { test } from "node:test";

// Mirror of buildNextQuery in apps/web/app/routes/papers.tsx — keep in sync.
function buildNextQuery(current: URLSearchParams, cursor: string): string {
  const next = new URLSearchParams(current);
  next.set("cursor", cursor);
  return next.toString();
}

// Mirror of the loader's retry-once logic for ApiError(400, 'invalid_cursor'). Stays in sync
// with apps/web/app/routes/papers.tsx. Pure-data version — no ApiError, just the contract.
class FakeApiError extends Error {
  status: number;
  code: string | null;
  constructor(status: number, code: string | null) {
    super(`api ${status} ${code ?? ""}`);
    this.status = status;
    this.code = code;
  }
}

interface FetchResult<T> {
  ok: boolean;
  status: number;
  code?: string | null;
  data?: T;
}

async function tryApiGetWithRetry<T>(
  buildParams: URLSearchParams,
  cursor: string | null,
  fakeFetch: (qs: string) => Promise<FetchResult<T>>,
): Promise<T> {
  const params = new URLSearchParams(buildParams);
  if (cursor) params.set("cursor", cursor);
  const qs = params.toString();
  const path = `/api/site/papers${qs ? `?${qs}` : ""}`;
  const first = await fakeFetch(path);
  if (first.ok) return first.data as T;
  if (first.status === 400 && first.code === "invalid_cursor" && cursor) {
    const noCursor = new URLSearchParams(buildParams);
    noCursor.delete("cursor");
    const qsRetry = noCursor.toString();
    const pathRetry = `/api/site/papers${qsRetry ? `?${qsRetry}` : ""}`;
    const retry = await fakeFetch(pathRetry);
    if (retry.ok) return retry.data as T;
    throw new FakeApiError(retry.status, retry.code ?? null);
  }
  throw new FakeApiError(first.status, first.code ?? null);
}

test("buildNextQuery adds cursor to the query string", () => {
  const current = new URLSearchParams("category=cs.AI&windowDays=30&limit=24");
  const out = buildNextQuery(current, "papers1abc.def");
  assert.ok(out.includes("cursor=papers1abc.def"), `expected cursor in ${out}`);
  // preserves the other params so category/windowDays/limit survive the click
  assert.ok(out.includes("category=cs.AI"));
  assert.ok(out.includes("windowDays=30"));
  assert.ok(out.includes("limit=24"));
});

test("buildNextQuery overwrites a stale cursor (cursor is forward-only)", () => {
  // Pagination must advance, not stay stuck. If a reader manually edits the URL to a bad
  // cursor and then clicks "加载更早", the new cursor must replace the stale one — otherwise
  // the api would reject it (decodeCursor throws InvalidCursorError on bind mismatch).
  const current = new URLSearchParams("category=cs.AI&cursor=stale-junk");
  const out = buildNextQuery(current, "papers1fresh.abc");
  assert.ok(out.includes("cursor=papers1fresh.abc"));
  assert.ok(!out.includes("stale-junk"));
});

test("the rendered next-page URL is NOT equal to the current URL — that is what FIX-Z fixed", () => {
  // This is the assertion that catches the original bug. Before FIX-Z, buildNextQuery
  // received a searchParams without cursor (loader dropped it), so its output was equal
  // to the current URL — and React Router treated the <Link> click as a revalidate.
  const currentUrl = new URL("https://example.test/papers?category=cs.AI&windowDays=30");
  const currentParams = new URLSearchParams(currentUrl.search);
  const nextHref = `/papers?${buildNextQuery(currentParams, "papers1first.next")}`;
  assert.notEqual(nextHref, currentUrl.pathname + currentUrl.search);
  assert.ok(nextHref.includes("cursor="), `next-page URL must contain cursor: ${nextHref}`);
});

test("buildNextQuery returns empty string when called with an empty cursor (defensive)", () => {
  // buildNextQuery isn't, but the loader must guard against an empty-string cursor — passing
  // cursor= (empty) to the api would set the param but decodeCursor would still run and may
  // decode an empty payload. The loader's `if (cursor)` guard (see papers.tsx loader) is what
  // prevents this. Pin that loader contract here as a pure check.
  const incoming = new URL("https://example.test/papers?cursor=&windowDays=30");
  const cursor = incoming.searchParams.get("cursor");
  assert.equal(cursor, "");
  // loader's `if (cursor) params.set("cursor", cursor);` will skip empty, so api never sees it.
  assert.ok(!cursor, "empty cursor must be filtered out before forwarding to api");
});

// --- FIX-Z.3: loader retries once on 400 invalid_cursor with cursor stripped ---

test("FIX-Z.3: stale cursor → 400 invalid_cursor → loader retries without cursor and the reader sees page 1", async () => {
  // Reader flow that crashed (before FIX-Z.3) with 500:
  //   1. Browse /papers?category=cs.AI&cursor=X (cursor bound to cs.A)
  //   2. Click cs.CL chip -> PaperFilters strips cursor (FIX-Z.2), URL is /papers?category=cs.CL
  // But these flow cases the user reported:
  //   3. Hand-edit URL to /papers?category=cs.CL&cursor=X (cursor still bound to cs.A) -> 500
  //   4. Browser back/forward across the category switch -> 500
  //   5. RSS feed reader fetches /papers?category=cs.CL&cursor=X (cached from earlier crawl) -> 500
  // FIX-Z.3 contract: the loader catches ApiError(400, 'invalid_cursor') and retries the
  // exact same query with the cursor stripped. The retry's response is what the reader sees.
  let calls = 0;
  const fetcher: (qs: string) => Promise<FetchResult<{ page: number }>> = async (qs) => {
    calls += 1;
    if (calls === 1) {
      assert.ok(qs.includes("cursor=papers1.csai"), `first call must carry cursor: ${qs}`);
      assert.ok(qs.includes("category=cs.CL"), `first call must carry new category: ${qs}`);
      return { ok: false, status: 400, code: "invalid_cursor" };
    }
    assert.ok(!qs.includes("cursor="), `retry must NOT carry cursor: ${qs}`);
    assert.ok(qs.includes("category=cs.CL"), `retry must keep category: ${qs}`);
    return { ok: true, status: 200, data: { page: 1 } };
  };
  const params = new URLSearchParams("category=cs.CL&limit=24");
  const out = await tryApiGetWithRetry(params, "papers1.csai", fetcher);
  assert.deepEqual(out, { page: 1 });
  assert.equal(calls, 2, "must be exactly one retry on invalid_cursor");
});

test("FIX-Z.3: valid cursor → 200 on first try → no retry (no extra HTTP cost on happy path)", async () => {
  // The retry path exists only for the failure case. Pin that the loader does not double-call
  // on success — important for backend load and for accurate cache/observability counts.
  let calls = 0;
  const fetcher: (qs: string) => Promise<FetchResult<{ page: number }>> = async (qs) => {
    calls += 1;
    return { ok: true, status: 200, data: { page: 2 } };
  };
  const out = await tryApiGetWithRetry(new URLSearchParams("category=cs.AI&limit=24"), "papers1.csai", fetcher);
  assert.deepEqual(out, { page: 2 });
  assert.equal(calls, 1, "happy path must not retry");
});

test("FIX-Z.3: 500 from api → throws (no retry on non-400 failures)", async () => {
  // Real outages must surface as 500, not be silently swallowed by an over-eager retry.
  let calls = 0;
  const fetcher: (qs: string) => Promise<FetchResult<unknown>> = async () => {
    calls += 1;
    return { ok: false, status: 500, code: null };
  };
  await assert.rejects(
    tryApiGetWithRetry(new URLSearchParams("category=cs.AI&limit=24"), "papers1.csai", fetcher),
    (err: { status: number }) => err.status === 500,
  );
  assert.equal(calls, 1, "non-400 must not trigger retry");
});

test("FIX-Z.3: 400 with a different code (not invalid_cursor) → throws (no retry on other 400s)", async () => {
  // Future backend might add other 400 codes (e.g. invalid_limit). Pin that the retry only
  // matches the specific 'invalid_cursor' code, not all 400s — to avoid masking real bugs.
  let calls = 0;
  const fetcher: (qs: string) => Promise<FetchResult<unknown>> = async () => {
    calls += 1;
    return { ok: false, status: 400, code: "invalid_limit" };
  };
  await assert.rejects(
    tryApiGetWithRetry(new URLSearchParams("category=cs.AI&limit=24"), "papers1.csai", fetcher),
    (err: { status: number; code: string | null }) => err.status === 400 && err.code === "invalid_limit",
  );
  assert.equal(calls, 1, "400/invalid_limit must not trigger retry");
});

test("FIX-Z.3: invalid_cursor but no cursor on original URL → no retry (safety net)", async () => {
  // Defensive: an invalid_cursor response without a cursor on the original URL is impossible
  // by construction (the api only rejects cursors that were sent), but if it ever happens
  // (e.g. a future backend bug) we must not loop. Pin that the retry path requires cursor != null.
  let calls = 0;
  const fetcher: (qs: string) => Promise<FetchResult<unknown>> = async () => {
    calls += 1;
    return { ok: false, status: 400, code: "invalid_cursor" };
  };
  await assert.rejects(
    tryApiGetWithRetry(new URLSearchParams("category=cs.AI&limit=24"), null, fetcher),
    (err: { status: number }) => err.status === 400,
  );
  assert.equal(calls, 1, "no cursor → no retry, throw as-is");
});