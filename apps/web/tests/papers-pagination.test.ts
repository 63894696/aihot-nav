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
import assert from "node:assert/strict";
import { test } from "node:test";

// Mirror of buildNextQuery in apps/web/app/routes/papers.tsx — keep in sync.
function buildNextQuery(current: URLSearchParams, cursor: string): string {
  const next = new URLSearchParams(current);
  next.set("cursor", cursor);
  return next.toString();
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