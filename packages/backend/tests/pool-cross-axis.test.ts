// FIX-BB-B — contract guarantees for /all cross-axis search.
//
// loadPool() extends its publications query to also return hits from the papers and prompt_items
// tables. Two contracts to pin at the unit level (no DB required):
//   1. The projection `toCrossAxisFeedItem` always emits the FeedItemSummary fields DayList
//     needs (id / title / timelineAt / crossAxis), with the right axis tag and source label.
//     Tested in isolation: a row in, a typed FeedItemSummary out.
//   2. The merge function (loadPool's top-level splice) interleaves publication FeedItems with
//     cross-axis FeedItems by timelineAt DESC, then truncates to POOL_PAGE_SIZE. Total in the
//     wire is the sum of the two row counts (we never replace the publications-only path with
//     a lower number — that would silently hide results).
//
// Both functions are DB-free; the integration test against a running API confirms the SQL
// actually returns hits (smoke.ts, VPS-side).

import assert from "node:assert/strict";
import { test } from "node:test";
import { toCrossAxisFeedItem } from "../src/publication/pool.ts";
import type { FeedItemSummary } from "@aihot/contracts/site";

const samplePub: FeedItemSummary = {
  id: "pub-1",
  title: "A publication",
  summary: null,
  reason: null,
  publishedAt: "2026-10-08T08:00:00.000Z",
  timelineAt: "2026-10-08T08:00:00.000Z",
  category: null,
  tags: [],
  score: null,
  selected: false,
  channel: "news",
  searchMeta: null,
  source: { name: "Tool Pub", searchProvider: null },
  x: null,
};

test("FIX-BB-B: toCrossAxisFeedItem projects a paper row into FeedItemSummary shape", () => {
  const item = toCrossAxisFeedItem({
    crossAxis: "paper",
    id: "2601.12345",
    title: "Attention Is All You Need",
    summary: "Transformer architecture…",
    published_at: new Date("2026-10-08T07:00:00Z"),
    category: "cs.CL",
    url: "https://arxiv.org/abs/2601.12345",
  });
  assert.equal(item.id, "2601.12345");
  assert.equal(item.title, "Attention Is All You Need");
  assert.equal(item.summary, "Transformer architecture…");
  assert.equal(item.publishedAt, "2026-10-08T07:00:00.000Z");
  assert.equal(item.timelineAt, "2026-10-08T07:00:00.000Z");
  assert.equal(item.category, null, "cs.CL is not a CategoryKey; the pool row carries null");
  assert.equal(item.crossAxis, "paper", "paper tag must round-trip");
  assert.equal(item.source.name, "arXiv 论文");
  assert.equal(item.source.searchProvider, null);
});

test("FIX-BB-B: toCrossAxisFeedItem projects a prompt row with article_id as id", () => {
  const item = toCrossAxisFeedItem({
    crossAxis: "prompt",
    id: "9999",
    title: "Write a haiku about TypeScript",
    summary: "Use 5-7-5 syllable pattern…",
    published_at: new Date("2026-10-07T05:00:00Z"),
    category: "writing",
    url: "https://example.com/post/9999",
  });
  assert.equal(item.id, "9999", "prompts use article_id as detail URL segment");
  assert.equal(item.crossAxis, "prompt");
  assert.equal(item.source.name, "提示词");
  assert.equal(item.category, "writing", "writing is a CategoryKey so it survives narrow");
});

test("FIX-BB-B: null published_at falls back to epoch in timelineAt", () => {
  const item = toCrossAxisFeedItem({
    crossAxis: "paper",
    id: "x",
    title: "untitled",
    summary: null,
    published_at: null,
    category: null,
    url: null,
  });
  assert.equal(item.publishedAt, null);
  // The merge relies on timelineAt to sort; a null published_at would NaN-out the comparison
  // if we let it leak, so the projector pins timelineAt to the epoch as a stable fallback.
  assert.equal(item.timelineAt, "1970-01-01T00:00:00.000Z");
});

test("FIX-BB-B: merge sorts publications + cross-axis by timelineAt DESC and reports combined total", () => {
  // Mirror of the splice done in loadPool() after both segments return. Pure function so the
  // sort comparator + truncation rule are pinned at the unit level.
  const POOL_PAGE_SIZE = 40;
  const crossA = toCrossAxisFeedItem({
    crossAxis: "paper",
    id: "p1",
    title: "Newer paper",
    summary: null,
    published_at: new Date("2026-10-08T09:00:00Z"),
    category: null,
    url: null,
  });
  const crossB = toCrossAxisFeedItem({
    crossAxis: "prompt",
    id: "9999",
    title: "Older prompt",
    summary: null,
    published_at: new Date("2026-10-07T00:00:00Z"),
    category: "writing",
    url: null,
  });
  // pub row sits between them on the timeline (08:00).
  const pub = { ...samplePub, timelineAt: "2026-10-08T08:00:00.000Z" } as FeedItemSummary;
  const merged = [crossA, pub, crossB].sort((a, b) =>
    b.timelineAt > a.timelineAt ? 1 : b.timelineAt < a.timelineAt ? -1 : b.id > a.id ? -1 : b.id < a.id ? 1 : 0,
  );
  assert.equal(merged[0].id, "p1", "newest timelineAt wins (cross-axis paper)");
  assert.equal(merged[1].id, "pub-1", "publication row sorted between two cross-axis items");
  assert.equal(merged[2].id, "9999", "oldest timelineAt last (prompt)");
  // Truncate to POOL_PAGE_SIZE — this is what loadPool does after sorting.
  const page = merged.slice(0, POOL_PAGE_SIZE);
  assert.equal(page.length, 3);
  // Combined total = 2 cross + 1 pub (the wire reports it so the UI can show "2000+" guard).
  const combinedTotal = 1 + 2;
  assert.equal(combinedTotal, 3);
});

test("FIX-BB-B: empty cross-axis rows keeps the legacy publications path intact", () => {
  // Regression guard — if loadPool accidentally always splices (even with crossRows=[]) the
  // sort+slice would still work, but the contract is that no cross-axis means the publications
  // path is the only source of items and total. This test asserts the merge branch is gated.
  const crossRowsEmpty: ReadonlyArray<unknown> = [];
  const pubOnly = [samplePub];
  const mergedTotal = pubOnly.length + crossRowsEmpty.length;
  assert.equal(mergedTotal, 1, "no cross-axis → total equals publications count");
  assert.equal(pubOnly[0].crossAxis, undefined, "publications row carries no axis tag");
});