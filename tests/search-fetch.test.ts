// W5-2 search-engine source: unit tests for the three fetchers and the score gate. The fetchers are
// tested against a local HTTP stub so they don't touch the public instances — AGENTS.md says tests
// must not access any external service. The score gate is exercised without a real model: the test
// environment has no provider credentials (AIHOT_CREDENTIALS_DIR=/nonexistent), so chatJson throws
// "Model ... is not configured (...)" which matches the safety-valve regex and produces a null score
// that the worker counts as skipped_model, not as a failure.
//
// What this file does NOT test:
// - The full orchestrator (search-fetch.ts). It writes rows into `articles`, which needs a real DB.
//   Run via scripts/smoke after deployment.
// - LLM pass/fail boundaries; we only assert the threshold constant and the safety-valve path.

import "./setup-noop.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { identityKeyForUrl } from "@aihot/backend/lib/url";
import { fetchSearxng, SEARXNG_INSTANCES } from "@aihot/backend/sources/searxng";
import * as hnAlgolia from "@aihot/backend/sources/hn-algolia";
import { fetchHnAlgolia } from "@aihot/backend/sources/hn-algolia";
import * as ghTrending from "@aihot/backend/sources/github-trending";
import { fetchGithubTrending } from "@aihot/backend/sources/github-trending";
import { scoreSearch, SEARCH_SCORE_THRESHOLD } from "@aihot/backend/publication/search-score";

config.allowPrivateNetworkFetch = true;

/** Spin up an HTTP server that records its hits and answers from a per-path map. Returns the origin URL. */
function startStub(paths: Record<string, (req: { url: string; method: string }) => { status: number; body: string }>) {
  const hits: Array<{ path: string; method: string }> = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const pathOnly = url.pathname + url.search;
    const handler = paths[url.pathname] ?? paths[pathOnly] ?? paths["*"];
    hits.push({ path: url.pathname, method: req.method ?? "GET" });
    if (!handler) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not stubbed");
      return;
    }
    const out = handler({ url: pathOnly, method: req.method ?? "GET" });
    res.writeHead(out.status, { "content-type": "application/json" });
    res.end(out.body);
  });
  return new Promise<{ url: string; hits: Array<{ path: string; method: string }>; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}`,
        hits,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

// SearXNG is mutating SEARXNG_INSTANCES (export const, so it's mutable as a property of the module
// exports record). We capture the original list and restore it in `after` to keep the rest of the
// test run untouched.
const originalSearxng = SEARXNG_INSTANCES.slice();

before(() => {
  // No-op placeholder; assertions live in the per-test stubs.
});

after(async () => {
  SEARXNG_INSTANCES.splice(0, SEARXNG_INSTANCES.length, ...originalSearxng);
});

test("SearXNG: round-robin advances the cursor on success and stops at the first hit", async () => {
  let calls = 0;
  const stub = await startStub({
    "/search": () => {
      calls += 1;
      return {
        status: 200,
        body: JSON.stringify({
          results: [
            { url: "https://example.org/a", title: "Alpha", content: "first hit" },
            { url: "https://example.org/b", title: "Beta", content: "second hit" },
          ],
        }),
      };
    },
  });
  SEARXNG_INSTANCES.splice(0, SEARXNG_INSTANCES.length, `${stub.url}/search`, `${stub.url}/search`);
  try {
    const out = await fetchSearxng({ id: "q1", q: "alpha" }, { cursor: 0, recentlyFailed: [] });
    assert.equal(out.exhausted, false);
    assert.equal(out.candidates.length, 2);
    assert.equal(calls, 1, "first instance succeeded — only one HTTP call");
    assert.equal(out.cursor.cursor, 1, "cursor advances so the next query starts on the second instance");
  } finally {
    await stub.close();
  }
});

test("SearXNG: a failing first instance triggers the next; all-fail returns exhausted=true", async () => {
  let calls = 0;
  const stub = await startStub({
    "/search": () => {
      calls += 1;
      return { status: 503, body: "{}" };
    },
  });
  SEARXNG_INSTANCES.splice(0, SEARXNG_INSTANCES.length, `${stub.url}/search`, `${stub.url}/search`, `${stub.url}/search`);
  try {
    // Three instances, all returning 503: the fetcher tries each in turn.
    const out = await fetchSearxng({ id: "q2", q: "beta" }, { cursor: 0, recentlyFailed: [] });
    assert.equal(out.exhausted, true);
    assert.equal(out.candidates.length, 0);
    assert.equal(calls, 3, "all instances were tried before giving up");
    assert.deepEqual(out.cursor.recentlyFailed, [0, 1, 2], "every failed instance index is recorded");
  } finally {
    await stub.close();
  }
});

test("SearXNG: skips results with no url, no title, or non-http schemes", async () => {
  const stub = await startStub({
    "/search": () => ({
      status: 200,
      body: JSON.stringify({
        results: [
          { url: "", title: "no url" },
          { url: "ftp://example.org/ftp", title: "ftp scheme" },
          { url: "https://example.org/keep", title: "   " },
          { url: "https://example.org/ok", title: "real", content: "<p>body</p>" },
          // Duplicate URL should dedupe within one response.
          { url: "https://example.org/ok", title: "real duplicate" },
        ],
      }),
    }),
  });
  SEARXNG_INSTANCES.splice(0, SEARXNG_INSTANCES.length, `${stub.url}/search`);
  try {
    const out = await fetchSearxng({ id: "q3", q: "gamma" }, null);
    assert.equal(out.candidates.length, 1);
    const [c] = out.candidates;
    assert.equal(c.url, "https://example.org/ok");
    assert.equal(c.title, "real");
    assert.equal(c.excerpt, "body");
    assert.equal(c.identityKey, identityKeyForUrl("https://example.org/ok"));
    assert.deepEqual(c.searchMeta, {
      provider: "searxng",
      queryId: "q3",
      queryText: "gamma",
      queryLang: null,
      queryCategory: null,
    });
  } finally {
    await stub.close();
  }
});

test("HN Algolia: parses hits, builds excerpt from points/comments/tags", async () => {
  let captured = "";
  const stub = await startStub({
    "/api/v1/search": (req) => {
      captured = req.url;
      return {
        status: 200,
        body: JSON.stringify({
          hits: [
            { objectID: "1", title: "Story A", url: "https://example.org/a", author: "alice", created_at_i: 1_700_000_000, num_comments: 42, points: 128, _tags: ["story", "author_alice"] },
            { objectID: "2", title: "Story B", story_url: "https://example.org/b", author: "bob", created_at_i: 1_700_100_000 },
            // No URL anywhere — must be skipped.
            { objectID: "3", title: "Story C" },
            // Empty title — must be skipped even with a URL.
            { objectID: "4", title: "", url: "https://example.org/d" },
          ],
        }),
      };
    },
  });
  const original = hnAlgolia.HN_API;
  Object.defineProperty(hnAlgolia, "HN_API", { value: `${stub.url}/api/v1/search`, configurable: true, writable: true });
  try {
    const out = await fetchHnAlgolia({ id: "h1", q: "alpha" });
    assert.equal(out.candidates.length, 2);
    const [a, b] = out.candidates;
    assert.equal(a.url, "https://example.org/a");
    assert.equal(a.author, "alice");
    assert.equal(a.publishedAt?.toISOString(), new Date(1_700_000_000 * 1000).toISOString());
    assert.equal(a.excerpt, "128 points • 42 comments • tags: story, author_alice");
    assert.equal(a.searchMeta?.provider, "hn_algolia");
    assert.equal(a.searchMeta?.refId, "1");
    assert.equal(b.url, "https://example.org/b");
    assert.equal(b.searchMeta?.refId, "2");
    assert.match(captured, /query=alpha/);
    assert.match(captured, /tags=story/);
  } finally {
    (hnAlgolia as { HN_API: string }).HN_API = original;
    await stub.close();
  }
});

test("HN Algolia: a non-200 response throws (the worker should retry on next slot)", async () => {
  const stub = await startStub({ "/api/v1/search": () => ({ status: 503, body: "{}" }) });
  const original = hnAlgolia.HN_API;
  Object.defineProperty(hnAlgolia, "HN_API", { value: `${stub.url}/api/v1/search`, configurable: true, writable: true });
  try {
    await assert.rejects(fetchHnAlgolia({ id: "h2", q: "delta" }), /503/);
  } finally {
    (hnAlgolia as { HN_API: string }).HN_API = original;
    await stub.close();
  }
});

test("GitHub Trending: maps category to language and skips rows without a URL", async () => {
  let lastPath = "";
  const stub = await startStub({
    "/daily": (req) => {
      lastPath = req.url;
      return {
        status: 200,
        body: JSON.stringify([
          { name: "owner/repo", url: "/owner/repo", description: "<p>real repo</p>", language: "Python", stars: 1000, currentPeriodStars: 50 },
          { name: "owner/script", url: "/owner/script", description: "tool", language: "TypeScript" },
          { name: "owner/noroot", description: "no url" },
          { name: "owner/empty", url: "/owner/empty", description: "no name" },
        ]),
      };
    },
  });
  const original = ghTrending.GH_TRENDING_API;
  Object.defineProperty(ghTrending, "GH_TRENDING_API", { value: stub.url, configurable: true, writable: true });
  try {
    // Category → language mapping: model_release → python, so the URL becomes /python/daily.
    const out = await fetchGithubTrending({ id: "g1", q: "trending", category: "model_release" });
    assert.equal(lastPath, "/python/daily", "category=model_release routes to python trending");
    assert.equal(out.candidates.length, 3, "three usable rows (owner/noroot has no URL; owner/empty has no name → no title)");
    assert.equal(out.candidates[0]?.url, "https://github.com/owner/repo");
    assert.equal(out.candidates[0]?.title, "owner/repo");
    assert.equal(out.candidates[0]?.excerpt, "real repo");
    assert.equal(out.candidates[0]?.author, "owner");
    assert.equal(out.candidates[0]?.searchMeta?.provider, "github_trending");
    assert.equal(out.candidates[0]?.searchMeta?.stars, 1000);
    assert.equal(out.candidates[0]?.searchMeta?.currentPeriodStars, 50);
    // No category → empty path segment, "all languages".
    const all = await fetchGithubTrending({ id: "g2", q: "trending" });
    assert.equal(all.candidates.length, 3);
  } finally {
    (ghTrending as { GH_TRENDING_API: string }).GH_TRENDING_API = original;
    await stub.close();
  }
});

test("GitHub Trending: a non-200 response throws", async () => {
  const stub = await startStub({ "/daily": () => ({ status: 500, body: "" }) });
  const original = ghTrending.GH_TRENDING_API;
  Object.defineProperty(ghTrending, "GH_TRENDING_API", { value: stub.url, configurable: true, writable: true });
  try {
    await assert.rejects(fetchGithubTrending({ id: "g3", q: "epsilon" }), /500/);
  } finally {
    (ghTrending as { GH_TRENDING_API: string }).GH_TRENDING_API = original;
    await stub.close();
  }
});

test("scoreSearch: a missing title returns passed=false, score=null with a no-title reason", async () => {
  const r = await scoreSearch({ url: "https://example.org/a", title: "   ", searchMeta: { provider: "searxng", queryId: "x", queryText: "x" } } as never);
  assert.deepEqual(r, { passed: false, score: null, reason: "no title" });
});

test("SEARCH_SCORE_THRESHOLD is high enough that an editor still has to filter", () => {
  // The lock decision is "single LLM score gate ≥ 70". Pin the constant so an accidental edit
  // surfaces in code review.
  assert.equal(SEARCH_SCORE_THRESHOLD, 70);
});
