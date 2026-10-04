// v0.2.1-#11 — /prompts is now a sitemap root so crawlers find the column without first crawling /.
// The DB-bound per-prompt block (the bulk of the new URLs) is exercised by the smoke check, not here;
// this file pins the cheap-but-load-bearing fixed entry shape so a future edit doesn't drop it
// silently.
//
// Why a pure helper instead of exercising build() end-to-end:
// - build() does 5 SQL queries; the only line that matters for the new /prompts entry is the static
//   fixed list. Extracting `staticSitemapEntries(now, latestItem, latestDaily)` lets us pin the
//   entry shape (loc, lastmod, changefreq, priority) without a DB.

import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { staticSitemapEntries } from "@aihot/backend/publication/sitemap";

const NOW = new Date("2026-10-04T00:00:00Z");
const LATEST_DAILY = new Date("2026-10-03T00:00:00Z");

test("staticSitemapEntries: /prompts appears with daily cadence and priority 0.8", () => {
  const entries = staticSitemapEntries({ now: NOW, latestDaily: LATEST_DAILY, hasLeaderboard: false });
  const prompts = entries.find((e) => e.loc === "/prompts");
  assert.ok(prompts, "expected a /prompts static entry");
  assert.equal(prompts.changefreq, "daily");
  assert.equal(prompts.priority, 0.8);
  assert.ok(prompts.lastmod instanceof Date, "lastmod should be a Date");
  assert.equal((prompts.lastmod as Date).toISOString(), NOW.toISOString());
});

test("staticSitemapEntries: keeps the existing /all and /daily entries so we don't regress coverage", () => {
  const entries = staticSitemapEntries({ now: NOW, latestDaily: LATEST_DAILY, hasLeaderboard: false });
  for (const required of ["/", "/all", "/daily", "/hot"]) {
    assert.ok(entries.some((e) => e.loc === required), `expected ${required} in static entries`);
  }
});

test("staticSitemapEntries: leaderboard entries are present only when hasLeaderboard is true", () => {
  const without = staticSitemapEntries({ now: NOW, latestDaily: LATEST_DAILY, hasLeaderboard: false });
  assert.ok(!without.some((e) => e.loc === "/leaderboard"));
  const withLb = staticSitemapEntries({ now: NOW, latestDaily: LATEST_DAILY, hasLeaderboard: true });
  assert.ok(withLb.some((e) => e.loc === "/leaderboard"));
});
