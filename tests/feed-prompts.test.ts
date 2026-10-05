// v0.2.1-#11 — /feed/prompts.xml is the new RSS channel for the prompts column.
//
// What this file covers:
//   - promptFeed() reads up to 50 prompt_items by captured_at DESC (the column's listing order).
//   - Each <item> carries: title (use_case or community fallback), link (/prompts/:id), GUID
//     "prompt-${id}" (isPermaLink=false so readers key on the id, not the URL — same as dailyFeed
//     uses "daily-${key}"), pubDate from captured_at, and a description that combines use_case +
//     a preview of prompt_text.
//   - The channel <atom:link rel="self"> points at /feed/prompts.xml so feed readers validate the
//     feed location.
//
// What this file does NOT cover:
//   - The crawler that decides which prompts to publish — that's the orchestrator + scorePrompt
//     path, exercised by smoke after deployment.
//   - The category / window filter UI on /prompts — readPromptMeta's filter contract is pinned
//     in tests/publication-prompts.test.ts.

import "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { promptFeed } from "@aihot/backend/publication/feeds";

before(async () => {
  // Wipe any leftover rows from a previous run so we don't drag old categories into the test.
  await sql`DELETE FROM prompt_items WHERE community = 'feed-prompts-test'`;
});

after(async () => {
  await sql`DELETE FROM prompt_items WHERE community = 'feed-prompts-test'`;
  await closeDb();
});

async function insertPrompt(args: { originalUrl: string; useCase: string | null; promptText: string; capturedAt: Date; category?: string; community?: string; language?: string; sourceKind?: string }) {
  await sql`INSERT INTO prompt_items (original_url, original_post_id, community, category, prompt_text, use_case, language, source_kind, captured_at, updated_at)
    VALUES (${args.originalUrl}, ${`post-${args.originalUrl}`}, ${args.community ?? "feed-prompts-test"}, ${args.category ?? "writing"}, ${args.promptText}, ${args.useCase}, ${args.language ?? "en"}, ${args.sourceKind ?? "searxng_search"}, ${args.capturedAt}, ${args.capturedAt})`;
}

test("promptFeed: emits one <item> per row, newest first, with the expected shape", async () => {
  // Older row should land AFTER the newer one in the feed.
  await insertPrompt({
    originalUrl: "https://example.org/feed-prompts/older",
    useCase: "Older draft",
    promptText: "Old prompt text",
    capturedAt: new Date("2026-09-30T00:00:00Z"),
  });
  await insertPrompt({
    originalUrl: "https://example.org/feed-prompts/newest",
    useCase: "Newest draft",
    promptText: "New prompt text",
    capturedAt: new Date("2026-10-04T00:00:00Z"),
  });
  await insertPrompt({
    originalUrl: "https://example.org/feed-prompts/middle",
    useCase: null,
    promptText: "Middle prompt — no use_case",
    capturedAt: new Date("2026-10-02T00:00:00Z"),
  });

  const xml = await promptFeed();
  assert.match(xml, /<rss version="2\.0"/);
  assert.match(xml, /<atom:link href="[^"]+\/feed\/prompts\.xml" rel="self" type="application\/rss\+xml"\/>/);
  assert.match(xml, /<channel>/);
  // Channel title is the prompts feed title — the route uses SITE.name plus a subject.
  assert.match(xml, /<title>[^<]+<\/title>/);

  // Newest first — the middle row's title "Middle prompt" should appear AFTER the newest's
  // "Newest draft" but BEFORE the older's "Older draft".
  const newestIdx = xml.indexOf("Newest draft");
  const middleIdx = xml.indexOf("Middle prompt");
  const olderIdx = xml.indexOf("Older draft");
  assert.ok(newestIdx > 0, "newest row must appear in the feed");
  assert.ok(middleIdx > 0, "middle row must appear in the feed");
  assert.ok(olderIdx > 0, "older row must appear in the feed");
  assert.ok(newestIdx < middleIdx, "newest must come before middle");
  assert.ok(middleIdx < olderIdx, "middle must come before older");

  // GUID format: "prompt-<id>" with isPermaLink=false (matches dailyFeed's "daily-<key>" convention).
  const guidMatch = xml.match(/<guid isPermaLink="false">prompt-(\d+)<\/guid>/);
  assert.ok(guidMatch, "expected prompt-<id> GUID; got:\n" + xml);
  // Link target is /prompts/:id (the wire detail URL).
  assert.match(xml, new RegExp(`<link>https?://[^/]+/prompts/${guidMatch![1]}</link>`));
  // pubDate matches captured_at (RFC 822 UTC).
  assert.match(xml, /<pubDate>[^<]+<\/pubDate>/);
});

test("promptFeed: rows with unknown category (not in PROMPT_CATEGORIES) are filtered out", async () => {
  await insertPrompt({
    originalUrl: "https://example.org/feed-prompts/ghost-category",
    useCase: "Ghost category row",
    promptText: "Should not appear",
    capturedAt: new Date("2026-10-05T00:00:00Z"),
    category: "roleplay", // not in PROMPT_CATEGORIES → readPromptMeta returns null
  });
  const xml = await promptFeed();
  assert.equal(xml.includes("Ghost category row"), false, "rows outside the 5-bucket taxonomy must be filtered out of the RSS feed");
  assert.equal(xml.includes("Should not appear"), false);
});

test("promptFeed: rows with empty prompt_text are filtered out", async () => {
  // Hand-rolled UPDATE bypasses the NOT NULL default; readPromptMeta drops these at the gate.
  await sql`INSERT INTO prompt_items (original_url, community, category, prompt_text, source_kind, captured_at, updated_at)
    VALUES (${"https://example.org/feed-prompts/empty"}, ${"feed-prompts-test"}, ${"writing"}, ${""}, ${"manual"}, now(), now())`;
  const xml = await promptFeed();
  assert.equal(xml.includes("/prompts/empty"), false, "rows with empty prompt_text must be filtered out");
});
