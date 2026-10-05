// Sitemap from the same public metadata as pages: reports, topics and their pages,
// the latest 500 stories, leaderboard pages and indexable items. Cached ~5 minutes and rebuilt in the
// background after that (crawlers get the previous copy meanwhile); if the database fails, the last
// successful sitemap is served (never an empty one). Bounded.
import { FEATURES } from "@aihot/industry/features";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { cached } from "../lib/cache.ts";
import { escapeXml } from "../lib/text.ts";
import { siteUrl } from "./links.ts";
import { leaderboardUrls } from "../leaderboard/read.ts";
import { topicPageCounts } from "./topics.ts";

async function leaderboardDetailUrls(): Promise<string[]> {
  const fixed = new Set(["/leaderboard", "/leaderboard/sources", "/leaderboard/rules"]);
  return (await leaderboardUrls()).filter((u) => !fixed.has(u) && !u.startsWith("/leaderboard/category/"));
}

const MAX_URLS = 45_000;
const TTL_MS = 5 * 60 * 1000;
const CACHE_FILE = path.join(config.dataDir, "sitemap-last.xml");

let lastGood: string | null = null;

interface Entry {
  loc: string;
  lastmod?: Date | null;
  changefreq?: string;
  priority?: number;
}

/**
 * Pure: the fixed-entries block at the top of build(). Extracted so the /prompts entry shape can be
 * pinned by tests/sitemap-prompts.test.ts without booting a DB connection. The dynamic blocks
 * (reports, topics, stories, leaderboard detail, items) stay inside build().
 */
export function staticSitemapEntries(opts: { now: Date | null; latestDaily: Date | null; hasLeaderboard: boolean }): Entry[] {
  const { now, latestDaily, hasLeaderboard } = opts;
  const entries: Entry[] = [
    { loc: "/", lastmod: now, changefreq: "hourly", priority: 1 },
    { loc: "/all", lastmod: now, changefreq: "hourly", priority: 0.9 },
    { loc: "/daily", lastmod: latestDaily, changefreq: "daily", priority: 0.9 },
    { loc: "/hot", lastmod: now, changefreq: "hourly", priority: 0.9 },
    { loc: "/daily/archive", lastmod: latestDaily, changefreq: "daily", priority: 0.7 },
    { loc: "/weekly", changefreq: "weekly", priority: 0.7 },
    { loc: "/monthly", changefreq: "monthly", priority: 0.6 },
    { loc: "/topics", changefreq: "daily", priority: 0.7 },
    // The prompts column is a daily-cadence listing page with its own RSS channel — pin it the same
    // way /all and /hot are pinned (priority 0.8 sits between /hot at 0.9 and /topics at 0.7).
    { loc: "/prompts", lastmod: now, changefreq: "daily", priority: 0.8 },
    // Code-prompts is the agent/instruction/skill template library — its own dedicated listing +
    // RSS channel. Pinned at the same priority as /prompts.
    { loc: "/code-prompts", lastmod: now, changefreq: "daily", priority: 0.8 },
    { loc: "/agent", lastmod: now, changefreq: "weekly", priority: 0.7 },
    { loc: "/about", changefreq: "monthly", priority: 0.5 },
    { loc: "/terms", changefreq: "monthly", priority: 0.4 },
    { loc: "/privacy", changefreq: "monthly", priority: 0.4 },
    { loc: "/releases", lastmod: now, changefreq: "weekly", priority: 0.5 },
    { loc: "/changelog", lastmod: now, changefreq: "hourly", priority: 0.6 },
  ];
  if (hasLeaderboard) {
    entries.push(
      { loc: "/leaderboard", changefreq: "daily", priority: 0.8 },
      { loc: "/leaderboard/sources", changefreq: "weekly", priority: 0.5 },
      { loc: "/leaderboard/rules", changefreq: "monthly", priority: 0.4 },
    );
    for (const board of ["coding", "reasoning", "knowledge", "professional"]) entries.push({ loc: `/leaderboard/category/${board}`, changefreq: "daily", priority: 0.6 });
  }
  return entries;
}

async function build(): Promise<string> {
  const entries: Entry[] = [];
  const [latestItem] = await sql<{ t: Date | null }[]>`SELECT max(timeline_at) AS t FROM publications WHERE visibility = 'public' AND selected`;
  const [latestDaily] = await sql<{ key: string | null; t: Date | null }[]>`SELECT max(key) AS key, max(generated_at) AS t FROM reports WHERE kind = 'daily'`;
  const now = latestItem?.t ?? new Date();
  entries.push(...staticSitemapEntries({ now, latestDaily: latestDaily?.t, hasLeaderboard: FEATURES.leaderboard }));
  if (FEATURES.leaderboard) {
    entries.push(
      { loc: "/leaderboard", changefreq: "daily", priority: 0.8 },
      { loc: "/leaderboard/sources", changefreq: "weekly", priority: 0.5 },
      { loc: "/leaderboard/rules", changefreq: "monthly", priority: 0.4 },
    );
    for (const board of ["coding", "reasoning", "knowledge", "professional"]) entries.push({ loc: `/leaderboard/category/${board}`, changefreq: "daily", priority: 0.6 });
  }
  const reports = await sql<{ kind: string; key: string; generated_at: Date }[]>`SELECT kind, key, generated_at FROM reports ORDER BY kind, key DESC`;
  for (const r of reports) entries.push({ loc: `/${r.kind}/${r.key}`, lastmod: r.generated_at, changefreq: r.kind === "daily" ? "never" : "monthly", priority: r.kind === "daily" ? 0.6 : 0.6 });
  for (const t of await topicPageCounts()) {
    if (!t.indexable) continue;
    entries.push({ loc: `/topics/${t.slug}`, lastmod: t.latest, changefreq: "daily", priority: 0.6 });
    for (let p = 2; p <= t.pages; p++) entries.push({ loc: `/topics/${t.slug}/page/${p}`, lastmod: t.latest, changefreq: "weekly", priority: 0.3 });
  }
  // Stories with reports of their own; pages that only gather reports grouped elsewhere (imported story
  // levels, regrouped history) are reachable but not listed.
  const stories = await sql<{ public_id: string; latest_at: Date | null }[]>`
    SELECT public_id::text, latest_at FROM stories WHERE merged_into IS NULL AND EXISTS (
      SELECT 1 FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
      WHERE f.story_id = stories.id AND fa.role IN ('primary', 'report') AND p.visibility = 'public' AND p.eligible)
    ORDER BY latest_at DESC NULLS LAST LIMIT 500`;
  for (const s of stories) entries.push({ loc: `/story/${s.public_id}`, lastmod: s.latest_at, changefreq: "daily", priority: 0.5 });
  // Model pages exist only for models on a public top-30 board; source pages for every registered source.
  if (FEATURES.leaderboard) for (const loc of await leaderboardDetailUrls()) entries.push({ loc, changefreq: "weekly", priority: 0.4 });
  const items = await sql<{ id: string; t: Date }[]>`
    SELECT article_id AS id, updated_at AS t FROM publications WHERE visibility = 'public' AND indexable ORDER BY timeline_at DESC LIMIT ${MAX_URLS - entries.length}`;
  for (const it of items) entries.push({ loc: `/items/${it.id}`, lastmod: it.t, changefreq: "monthly", priority: 0.5 });
  // Per-prompt detail pages (mirrors the items block above): readers reach each prompt's URL via
  // the RSS feed or the listing page, but crawlers find them through this block. Capped by the
  // remaining budget so we never overflow MAX_URLS.
  const promptRows = await sql<{ id: number; t: Date }[]>`
    SELECT id, updated_at AS t FROM prompt_items
      WHERE prompt_text IS NOT NULL AND length(prompt_text) > 0
        AND category = ANY(ARRAY['writing','coding','image','video','audio','agent','research']::text[])
      ORDER BY captured_at DESC, id DESC LIMIT ${Math.max(0, MAX_URLS - entries.length)}`;
  for (const p of promptRows) entries.push({ loc: `/prompts/${p.id}`, lastmod: p.t, changefreq: "weekly", priority: 0.4 });

  // Per-code-prompt detail pages (mirrors the prompts block above). The composite id
  // `{source_id}::{slug}` is URL-encoded into the path component — slash inside slug stays as
  // is because the slug is already a github-style path. Capped by the remaining budget.
  const copilotRows = await sql<{ source_id: string; slug: string; t: Date }[]>`
    SELECT source_id, slug, fetched_at AS t FROM copilot_assets
      WHERE status IN ('fetched', 'indexed')
        AND length(coalesce(body_md, '')) > 0
      ORDER BY fetched_at DESC, id DESC LIMIT ${Math.max(0, MAX_URLS - entries.length)}`;
  for (const r of copilotRows) {
    const compositeId = `${r.source_id}::${r.slug}`;
    entries.push({ loc: `/code-prompts/${encodeURIComponent(compositeId)}`, lastmod: r.t, changefreq: "weekly", priority: 0.4 });
  }

  const body = entries
    .slice(0, MAX_URLS)
    .map((e) => {
      const parts = [`<loc>${escapeXml(siteUrl(e.loc))}</loc>`];
      if (e.lastmod) parts.push(`<lastmod>${e.lastmod.toISOString()}</lastmod>`);
      if (e.changefreq) parts.push(`<changefreq>${e.changefreq}</changefreq>`);
      if (e.priority !== undefined) parts.push(`<priority>${e.priority}</priority>`);
      return `<url>\n${parts.join("\n")}\n</url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

const sitemap = cached(refreshSitemap, { freshMs: TTL_MS, maxStaleMs: 60 * 60_000 });

export function sitemapXml(): Promise<string> {
  return sitemap.get();
}

async function refreshSitemap(): Promise<string> {
  try {
    const xml = await build();
    lastGood = xml;
    await mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await writeFile(CACHE_FILE, xml).catch(() => {});
    return xml;
  } catch (error) {
    if (lastGood) return lastGood;
    const last = await readFile(CACHE_FILE, "utf8").catch(() => null);
    if (last) return last;
    throw error;
  }
}
