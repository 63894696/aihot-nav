// v0.2.1-#11 — /code-prompts is a sitemap root so crawlers find the agent/instruction/skill
// template library without first crawling /. The DB-bound per-asset block (the bulk of the new
// URLs) is exercised by the smoke check, not here; this file pins the cheap-but-load-bearing
// fixed entry shape so a future edit doesn't drop it silently.
//
// Why a pure helper instead of exercising build() end-to-end:
// - build() does 5 SQL queries; the only line that matters for the new /code-prompts entry is the
//   static fixed list. Extracting `staticSitemapEntries(...)` lets us pin the entry shape (loc,
//   lastmod, changefreq, priority) without a DB — same pattern as tests/sitemap-prompts.test.ts.

import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { staticSitemapEntries } from "@aihot/backend/publication/sitemap";

const NOW = new Date("2026-10-06T00:00:00Z");
const LATEST_DAILY = new Date("2026-10-05T00:00:00Z");

test("staticSitemapEntries: /code-prompts appears with daily cadence and priority 0.8", () => {
  const entries = staticSitemapEntries({ now: NOW, latestDaily: LATEST_DAILY, hasLeaderboard: false });
  const cp = entries.find((e) => e.loc === "/code-prompts");
  assert.ok(cp, "expected a /code-prompts static entry");
  assert.equal(cp.changefreq, "daily");
  assert.equal(cp.priority, 0.8);
  assert.ok(cp.lastmod instanceof Date, "lastmod should be a Date");
  assert.equal((cp.lastmod as Date).toISOString(), NOW.toISOString());
});

test("staticSitemapEntries: /code-prompts sits next to /prompts (both pinned at priority 0.8)", () => {
  const entries = staticSitemapEntries({ now: NOW, latestDaily: LATEST_DAILY, hasLeaderboard: false });
  const cp = entries.find((e) => e.loc === "/code-prompts");
  const prompts = entries.find((e) => e.loc === "/prompts");
  assert.ok(cp && prompts, "both /code-prompts and /prompts must exist in the static list");
  assert.equal(cp.priority, prompts.priority, "/code-prompts shares the same priority band as /prompts");
});

test("staticSitemapEntries: keeps the existing /prompts entry so we don't regress coverage", () => {
  const entries = staticSitemapEntries({ now: NOW, latestDaily: LATEST_DAILY, hasLeaderboard: false });
  assert.ok(entries.some((e) => e.loc === "/prompts"), "expected /prompts to still be in static entries");
});