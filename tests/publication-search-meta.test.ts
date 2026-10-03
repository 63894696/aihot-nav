// W5-2-F2: readSearchMeta is the publication-layer gate that decides whether a card/detail page
// shows the search-engine attribution. Pure function on the row shape — no DB needed.
//
// Why this matters: a non-search source carrying the same column shape must never light up the
// badge, and a search row with a corrupted `articles.raw` must drop the badge rather than throw
// at render time.

import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readSearchMeta, SEARCH_API_SOURCE_ID } from "@aihot/backend/publication/items";

test("readSearchMeta: returns null for any non-search source", () => {
  assert.equal(readSearchMeta({ source_id: "rss-it-home", article_raw: { provider: "searxng", queryId: "q1", queryText: "x" } }), null);
  assert.equal(readSearchMeta({ source_id: "x-shard-1", article_raw: { provider: "searxng", queryId: "q1", queryText: "x" } }), null);
  assert.equal(readSearchMeta({ source_id: "", article_raw: null }), null);
});

test("readSearchMeta: returns null when article_raw is missing or not an object", () => {
  assert.equal(readSearchMeta({ source_id: SEARCH_API_SOURCE_ID, article_raw: null }), null);
  // Arrays count as objects in JS but aren't a valid raw envelope.
  assert.equal(readSearchMeta({ source_id: SEARCH_API_SOURCE_ID, article_raw: [] as unknown as Record<string, any> }), null);
  // Primitives and strings can't carry the contract.
  assert.equal(readSearchMeta({ source_id: SEARCH_API_SOURCE_ID, article_raw: 42 as unknown as Record<string, any> }), null);
  assert.equal(readSearchMeta({ source_id: SEARCH_API_SOURCE_ID, article_raw: "raw" as unknown as Record<string, any> }), null);
});

test("readSearchMeta: returns null when provider is unknown (forward-compat: stay silent)", () => {
  assert.equal(readSearchMeta({
    source_id: SEARCH_API_SOURCE_ID,
    article_raw: { provider: "brave_search", queryId: "q1", queryText: "x" },
  }), null);
  assert.equal(readSearchMeta({
    source_id: SEARCH_API_SOURCE_ID,
    article_raw: { provider: null, queryId: "q1", queryText: "x" },
  }), null);
});

test("readSearchMeta: returns null when queryId or queryText is missing/non-string", () => {
  assert.equal(readSearchMeta({
    source_id: SEARCH_API_SOURCE_ID,
    article_raw: { provider: "searxng", queryId: 1, queryText: "x" },
  }), null);
  assert.equal(readSearchMeta({
    source_id: SEARCH_API_SOURCE_ID,
    article_raw: { provider: "searxng", queryId: "q1", queryText: null },
  }), null);
  assert.equal(readSearchMeta({
    source_id: SEARCH_API_SOURCE_ID,
    article_raw: { provider: "searxng", queryText: "x" }, // no queryId
  }), null);
});

test("readSearchMeta: returns the slice for each known provider", () => {
  const cases = [
    { provider: "searxng", queryId: "q-searx-1", queryText: "agent framework" },
    { provider: "hn_algolia", queryId: "q-hn-2", queryText: "claude 5" },
    { provider: "github_trending", queryId: "q-gh-3", queryText: "trending" },
  ] as const;
  for (const meta of cases) {
    assert.deepEqual(readSearchMeta({ source_id: SEARCH_API_SOURCE_ID, article_raw: { ...meta } }), meta);
  }
});

test("readSearchMeta: ignores extra fields in article_raw (provider is the gate)", () => {
  // The W5-2 contract writes {provider, queryId, queryText, queryLang, queryCategory, refId, stars, ...};
  // the function should pass through extras without complaint — they never enter the return shape.
  assert.deepEqual(readSearchMeta({
    source_id: SEARCH_API_SOURCE_ID,
    article_raw: { provider: "searxng", queryId: "q1", queryText: "x", queryLang: "zh", refId: "abc", stars: 999 },
  }), { provider: "searxng", queryId: "q1", queryText: "x" });
});
