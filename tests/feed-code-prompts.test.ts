// v0.2.1-#11 — /feed/code-prompts.xml is the new RSS channel for the /code-prompts template library.
//
// What this file covers:
//   - codePromptFeed() reads up to 50 copilot_assets by fetched_at DESC (the column's listing order).
//   - Each <item> carries: title (filename), link (/code-prompts/{composite-id}), GUID
//     "codeprompt-{composite-id}" (isPermaLink=false so readers key on the id, not the URL — same
//     as dailyFeed uses "daily-${key}" and promptFeed uses "prompt-${id}"), pubDate from
//     fetched_at, and a description that combines kind chip + repo slug + body preview.
//   - The channel <atom:link rel="self"> points at /feed/code-prompts.xml so feed readers validate
//     the feed location.
//   - Rows with empty body_md or status not in (fetched, indexed) are filtered out (the wire
//     contract published on /api/site/awesome-copilot has the same gate).

import "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { codePromptFeed } from "@aihot/backend/publication/feeds";

before(async () => {
  // Wipe any leftover rows from a previous run so we don't drag old composite-ids into the test.
  await sql`DELETE FROM copilot_assets WHERE source_id = 'external-awesome-copilot-feed-test'`;
});

after(async () => {
  await sql`DELETE FROM copilot_assets WHERE source_id = 'external-awesome-copilot-feed-test'`;
  await closeDb();
});

async function insertAsset(args: { sourceId: string; slug: string; assetKind: string; filename: string; bodyMd: string; repoSlug?: string; rawUrl: string; status?: string; fetchedAt: Date }) {
  await sql`INSERT INTO copilot_assets (source_id, asset_kind, slug, filename, frontmatter, body_md, raw_url, repo_slug, default_branch, status, fetched_at, updated_at)
    VALUES (${args.sourceId}, ${args.assetKind}, ${args.slug}, ${args.filename}, ${"{}"}::jsonb, ${args.bodyMd}, ${args.rawUrl}, ${args.repoSlug ?? "github/awesome-copilot"}, ${"main"}, ${args.status ?? "fetched"}, ${args.fetchedAt}, ${args.fetchedAt})`;
}

test("codePromptFeed: emits one <item> per row, newest first, with the expected shape", async () => {
  // Older row should land AFTER the newer one in the feed.
  await insertAsset({
    sourceId: "external-awesome-copilot-feed-test",
    slug: "agents/older.md",
    assetKind: "agent",
    filename: "older.md",
    bodyMd: "# Older agent body",
    rawUrl: "https://raw.githubusercontent.com/github/awesome-copilot/main/agents/older.md",
    fetchedAt: new Date("2026-10-01T00:00:00Z"),
  });
  await insertAsset({
    sourceId: "external-awesome-copilot-feed-test",
    slug: "agents/newest.md",
    assetKind: "agent",
    filename: "newest.md",
    bodyMd: "# Newest agent body",
    rawUrl: "https://raw.githubusercontent.com/github/awesome-copilot/main/agents/newest.md",
    fetchedAt: new Date("2026-10-06T00:00:00Z"),
  });
  await insertAsset({
    sourceId: "external-awesome-copilot-feed-test",
    slug: "instructions/middle.md",
    assetKind: "instruction",
    filename: "middle.md",
    bodyMd: "# Middle instruction body",
    rawUrl: "https://raw.githubusercontent.com/github/awesome-copilot/main/instructions/middle.md",
    fetchedAt: new Date("2026-10-03T00:00:00Z"),
  });

  const xml = await codePromptFeed();
  assert.match(xml, /<rss version="2\.0"/);
  assert.match(xml, /<atom:link href="[^"]+\/feed\/code-prompts\.xml" rel="self" type="application\/rss\+xml"\/>/);
  assert.match(xml, /<channel>/);
  assert.match(xml, /<title>[^<]+<\/title>/);

  // Newest first — middle should appear AFTER newest but BEFORE older.
  const newestIdx = xml.indexOf("newest.md");
  const middleIdx = xml.indexOf("middle.md");
  const olderIdx = xml.indexOf("older.md");
  assert.ok(newestIdx > 0, "newest row must appear in the feed");
  assert.ok(middleIdx > 0, "middle row must appear in the feed");
  assert.ok(olderIdx > 0, "older row must appear in the feed");
  assert.ok(newestIdx < middleIdx, "newest must come before middle");
  assert.ok(middleIdx < olderIdx, "middle must come before older");

  // GUID format: "codeprompt-{composite-id}" with isPermaLink=false.
  assert.match(xml, /<guid isPermaLink="false">codeprompt-[^<]+<\/guid>/);
  // Link target is /code-prompts/{composite-id} (URL-encoded :: as %3A%3A by encodeURIComponent).
  assert.match(xml, /<link>https?:\/\/[^/]+\/code-prompts\/external-awesome-copilot-feed-test%3A%3A[^<]+<\/link>/);
  // pubDate from fetched_at.
  assert.match(xml, /<pubDate>[^<]+<\/pubDate>/);
  // Kind chip + repo slug + raw URL appear inside <description>.
  assert.match(xml, /类型<\/strong>：Agent/);
  assert.match(xml, /原始文件/);
});

test("codePromptFeed: rows with status='failed' are filtered out", async () => {
  await insertAsset({
    sourceId: "external-awesome-copilot-feed-test",
    slug: "agents/failed.md",
    assetKind: "agent",
    filename: "failed.md",
    bodyMd: "Should not appear",
    rawUrl: "https://raw.githubusercontent.com/github/awesome-copilot/main/agents/failed.md",
    status: "failed",
    fetchedAt: new Date("2026-10-07T00:00:00Z"),
  });
  const xml = await codePromptFeed();
  assert.equal(xml.includes("failed.md"), false, "failed-status rows must be filtered out of the RSS feed");
  assert.equal(xml.includes("Should not appear"), false);
});

test("codePromptFeed: rows with empty body_md are filtered out", async () => {
  await insertAsset({
    sourceId: "external-awesome-copilot-feed-test",
    slug: "agents/empty.md",
    assetKind: "agent",
    filename: "empty.md",
    bodyMd: "",
    rawUrl: "https://raw.githubusercontent.com/github/awesome-copilot/main/agents/empty.md",
    fetchedAt: new Date("2026-10-08T00:00:00Z"),
  });
  const xml = await codePromptFeed();
  assert.equal(xml.includes("empty.md"), false, "rows with empty body_md must be filtered out");
});