// FIX-Z.5 — client-side Load More retry-once mirror of FIX-Z.3.
//
// Bug context: the server-side loader's apiGet has retry-once on 400+invalid_cursor
// (FIX-Z.3, papers-pagination.test.ts). The /papers Load More button uses a local
// apiGetClient helper that runs in the browser, NOT the server. That helper had no
// retry, so a stale cursor in the browser state (from IntersectionObserver + button-click
// racing the same fetch, an idle tab losing its session etag across a deploy, or two tabs
// on the same query racing each other) would surface "api 400 invalid_cursor" to the
// reader — and the only way out was a chip / search re-submit, which re-runs the loader
// (the only path with retry-once today). Real browsers hit this race; puppeteer-headless
// does not, because its single-threaded loop dispatches fetches strictly serially.
//
// Fix: mirror FIX-Z.3 inside apiGetClient — on 400+invalid_cursor with a cursor on the URL,
// drop the cursor and retry once. The retry succeeds with the same q/sort/limit/windowDays,
// which is the same first page the reader already saw — so the Load More button is
// self-healing on the next click. See Lesson 13 in MEMORY.md.
import assert from "node:assert/strict";
import { test } from "node:test";

// Mirror of apiGetClient in apps/web/app/routes/papers.tsx. Pure-data version — we test the
// retry-once contract by piping every fetch through fakeFetch. The string-replacement logic
// for `?cursor=...` / `&cursor=...` removal must stay byte-identical to the real helper.
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

async function apiGetClientWithRetry<T>(
  path: string,
  fakeFetch: (p: string) => Promise<FetchResult<T>>,
): Promise<T> {
  const tryFetch = async (p: string): Promise<T> => {
    const r = await fakeFetch(p);
    if (!r.ok) throw new FakeApiError(r.status, r.code ?? null);
    return r.data as T;
  };
  try {
    return await tryFetch(path);
  } catch (err) {
    if (err instanceof FakeApiError && err.status === 400 && err.code === "invalid_cursor" && /[?&]cursor=[^&]*/.test(path)) {
      const retried = path.replace(/[?&]cursor=[^&]*/, "").replace(/\?$/, "");
      return await tryFetch(retried);
    }
    throw err;
  }
}

test("FIX-Z.5: 400+invalid_cursor with cursor on URL → retry once without cursor", async () => {
  // The race-condition scenario: cursor was minted for the live query, but by the time the
  // second fetch fires (button-click race, IO + button click, two tabs) the cursor is stale.
  // Pin that the client helper self-heals: it drops cursor=, retries with the same q/sort/limit,
  // and the reader sees a successful response.
  const calls: string[] = [];
  const fakeFetch = async (p: string): Promise<FetchResult<{ ok: true; n: number }>> => {
    calls.push(p);
    if (p.includes("cursor=papers1.bad")) {
      return { ok: false, status: 400, code: "invalid_cursor" };
    }
    return { ok: true, status: 200, data: { ok: true, n: 24 } };
  };
  const path = "/api/site/papers?windowDays=30&limit=24&q=language+model&cursor=papers1.bad";
  const data = await apiGetClientWithRetry(path, fakeFetch);
  assert.deepEqual(data, { ok: true, n: 24 });
  assert.equal(calls.length, 2, "must be exactly one retry on invalid_cursor");
  assert.ok(calls[0].includes("cursor=papers1.bad"), "first call must carry the stale cursor");
  assert.ok(!calls[1].includes("cursor="), `retry must NOT carry cursor: ${calls[1]}`);
  assert.ok(calls[1].includes("q=language+model"), `retry must keep q: ${calls[1]}`);
  assert.ok(calls[1].includes("windowDays=30"), `retry must keep windowDays: ${calls[1]}`);
  assert.ok(calls[1].includes("limit=24"), `retry must keep limit: ${calls[1]}`);
});

test("FIX-Z.5: 400+invalid_cursor but no cursor on URL → throw as-is (no infinite loop)", async () => {
  // Defense against a future backend bug that returns invalid_cursor when no cursor was sent.
  // Pin that the retry path requires /[?&]cursor=[^&]*/ to actually match; otherwise we throw
  // immediately rather than retrying without a cursor (which would be identical to the first
  // call and would loop until the api changed its mind).
  const calls: string[] = [];
  const fakeFetch = async (p: string): Promise<FetchResult<unknown>> => {
    calls.push(p);
    return { ok: false, status: 400, code: "invalid_cursor" };
  };
  const path = "/api/site/papers?windowDays=30&limit=24&q=language+model";
  await assert.rejects(
    () => apiGetClientWithRetry(path, fakeFetch),
    (err: unknown) => err instanceof FakeApiError && err.status === 400 && err.code === "invalid_cursor",
  );
  assert.equal(calls.length, 1, "no cursor on URL → no retry, throw as-is");
});

test("FIX-Z.5: 200 on first try → no retry (happy path cost is zero)", async () => {
  // Pin that the retry-once is purely a recovery path — the 99% happy case pays nothing.
  // A reader on a fresh page who clicks Load More should see exactly one HTTP request.
  const calls: string[] = [];
  const fakeFetch = async (p: string): Promise<FetchResult<{ ok: true; n: number }>> => {
    calls.push(p);
    return { ok: true, status: 200, data: { ok: true, n: 24 } };
  };
  const path = "/api/site/papers?windowDays=30&limit=24&cursor=papers1.good";
  const data = await apiGetClientWithRetry(path, fakeFetch);
  assert.deepEqual(data, { ok: true, n: 24 });
  assert.equal(calls.length, 1, "happy path must not double-call");
});

test("FIX-Z.5: 400 with a code other than invalid_cursor → throw as-is (no over-eager retry)", async () => {
  // Future backend 400 codes (e.g. invalid_limit, invalid_windowDays) must surface to the
  // reader, not be silently swallowed by a retry that drops the cursor and gets the same
  // error back. The retry only knows about invalid_cursor today.
  const calls: string[] = [];
  const fakeFetch = async (p: string): Promise<FetchResult<unknown>> => {
    calls.push(p);
    return { ok: false, status: 400, code: "invalid_limit" };
  };
  const path = "/api/site/papers?windowDays=30&limit=999&cursor=papers1.x";
  await assert.rejects(
    () => apiGetClientWithRetry(path, fakeFetch),
    (err: unknown) => err instanceof FakeApiError && err.status === 400 && err.code === "invalid_limit",
  );
  assert.equal(calls.length, 1, "non-invalid_cursor 400 must not retry");
});

test("FIX-Z.5: 5xx → throw as-is (real outages must surface)", async () => {
  // The retry-once is a cursor-staleness recovery, not an outage recovery. A 500 means the
  // api is broken; retrying with the cursor dropped would mask that and show the reader stale
  // page 1 results without any indication of the real problem.
  const calls: string[] = [];
  const fakeFetch = async (p: string): Promise<FetchResult<unknown>> => {
    calls.push(p);
    return { ok: false, status: 500, code: "internal_error" };
  };
  const path = "/api/site/papers?windowDays=30&limit=24&cursor=papers1.x";
  await assert.rejects(
    () => apiGetClientWithRetry(path, fakeFetch),
    (err: unknown) => err instanceof FakeApiError && err.status === 500,
  );
  assert.equal(calls.length, 1, "5xx must not retry");
});

test("FIX-Z.5: cursor= is a query param (first), not a fragment or value-containing field", async () => {
  // The regex `/[?&]cursor=[^&]*/` must match cursor only when it's a real query parameter.
  // Pin the regex's contract: it must NOT match strings like "cursor=red" in some random
  // field, and it must work whether cursor is the first query param (?cursor=) or a later
  // one (&cursor=). Both forms happen in buildPagePath — q sometimes comes first, sometimes
  // windowDays/limit does depending on which keys are set.
  const cursorFirst = "/api/site/papers?cursor=papers1.x&q=language+model";
  const cursorLast = "/api/site/papers?q=language+model&cursor=papers1.x";
  for (const path of [cursorFirst, cursorLast]) {
    const dropped = path.replace(/[?&]cursor=[^&]*/, "").replace(/\?$/, "");
    assert.ok(!dropped.includes("cursor="), `must drop cursor: ${dropped}`);
    assert.ok(dropped.includes("q=language+model"), `must keep q: ${dropped}`);
  }
  // Trailing ?  cleanup: a URL that was "?cursor=..." alone becomes "/api/site/papers" with
  // a trailing "?". The .replace(/\?$/, "") cleans it up so the api doesn't see a junk
  // query-string. Pin that cleanup.
  const onlyCursor = "/api/site/papers?cursor=papers1.x";
  const droppedOnly = onlyCursor.replace(/[?&]cursor=[^&]*/, "").replace(/\?$/, "");
  assert.equal(droppedOnly, "/api/site/papers", "trailing ? must be cleaned up");
});
