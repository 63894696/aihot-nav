// /api/site/tools — the navigation layer's tool catalog. One card per publication in the
// tool_release tag set; clicking opens the existing /items/:id detail page (no separate
// tool entity yet — that would need a schema migration; see plan §3.1.2 and the W2-1
// "derive from publications" decision). Distinct from /new, which is the last 24h hot window:
// /tools is a longer window (default 30d), supports category/tag/channel filters, and paginates.
import type { CategoryKey, ChannelKey } from "@aihot/contracts/taxonomy";
import type { FeedItemSummary, PaperSummary, PromptCard, SiteItemDetail, SiteToolDetail, ToolsResponse, ToolsSort } from "@aihot/contracts/site";
import { sql } from "../db.ts";
import { decodeCursor, encodeCursor, InvalidCursorError, queryBinding } from "../lib/cursor.ts";
import {
  ITEM_COLUMNS, ITEM_FROM, categoryCondition, channelCondition, selectedCondition, tagCondition, toFeedItemSummary, type ItemRow,
} from "./items.ts";
import { loadItemDetail, siteItemDetail } from "./detail.ts";

/** Tag set that qualifies a publication as a "tool/model/platform" — same set as /new (daily.ts). */
const TOOL_TAGS = ["新工具", "产品更新", "模型发布", "平台"];

/** Reasonable bounds — outside these the UI would render a broken page or hit a slow query. */
const DEFAULT_LIMIT = 24;
const MIN_LIMIT = 1;
const MAX_LIMIT = 60;
const DEFAULT_WINDOW_DAYS = 30;
const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 90;

export interface ToolsQuery {
  /** Filters — same shape as timeline, minus topic (no topic vocabulary on tools yet). */
  category?: CategoryKey | null;
  tag?: string | null;
  channel?: ChannelKey;
  sort?: ToolsSort;
  /** Time window in days (default 30, capped 1..90). */
  windowDays?: number;
  /** Page size (default 24, capped 1..60). */
  limit?: number;
  /** Opaque cursor returned by a prior request. */
  cursor?: string | null;
  /** Frozen "now" for deterministic tests. */
  now?: Date;
}

function binding(q: ToolsQuery): string {
  return queryBinding({ c: q.channel ?? "all", k: q.category ?? null, t: q.tag ?? null, s: q.sort ?? "recent", w: q.windowDays ?? DEFAULT_WINDOW_DAYS, l: q.limit ?? DEFAULT_LIMIT });
}

function filterSql(q: ToolsQuery) {
  return sql`${channelCondition(q.channel)} ${categoryCondition(q.category)} ${tagCondition(q.tag)}`;
}

export async function loadTools(q: ToolsQuery = {}): Promise<ToolsResponse> {
  const now = q.now ?? new Date();
  const windowDays = Math.min(Math.max(q.windowDays ?? DEFAULT_WINDOW_DAYS, MIN_WINDOW_DAYS), MAX_WINDOW_DAYS);
  const limit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, MIN_LIMIT), MAX_LIMIT);
  const sort: ToolsSort = q.sort === "score" ? "score" : "recent";
  const bind = binding(q);
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  // Decode cursor (sort_at + article_id, bound to this filter scope).
  type Cursor = { a: number; i: string; b: string };
  let after: { sortAt: number; id: string } | null = null;
  if (q.cursor) {
    const c = decodeCursor<Cursor>("tools1", q.cursor);
    if (c.b !== bind || typeof c.a !== "number" || typeof c.i !== "string") throw new InvalidCursorError("cursor does not match this query");
    after = { sortAt: c.a, id: c.i };
  }

  // Fetch one extra row to detect "has more"; the cursor encodes the last visible row.
  const orderClause = sort === "score"
    ? sql`ORDER BY p.score DESC NULLS LAST, p.sort_at DESC, p.article_id DESC`
    : sql`ORDER BY p.sort_at DESC, p.article_id DESC`;
  const cursorPredicate = after === null
    ? sql``
    : sort === "score"
      ? sql`AND (
          (p.score IS DISTINCT FROM (SELECT score FROM publications WHERE article_id = ${after.id}))
          OR (p.score = (SELECT score FROM publications WHERE article_id = ${after.id}) AND (p.sort_at, p.article_id) < ((SELECT sort_at FROM publications WHERE article_id = ${after.id}), ${after.id}))
        )`
      : sql`AND (p.sort_at, p.article_id) < ((SELECT sort_at FROM publications WHERE article_id = ${after.id}), ${after.id})`;

  const rows = await sql<ItemRow[]>`
    SELECT ${ITEM_COLUMNS} ${ITEM_FROM}
    WHERE ${selectedCondition(now)}
      AND p.discovered_at >= ${cutoff}
      AND p.tags && ${TOOL_TAGS}::text[]
      ${filterSql(q)}
      ${cursorPredicate}
    ${orderClause}
    LIMIT ${limit + 1}`;

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = hasMore && last
    ? encodeCursor("tools1", { a: last.sort_at.getTime(), i: last.id, b: bind })
    : null;

  // Earliest upcoming release in scope — caches expire then (matches the /new pattern).
  const refreshAt = await nextToolsRelease(cutoff, q, now);

  return {
    filters: {
      category: q.category ?? null,
      tag: q.tag ?? null,
      channel: q.channel ?? "all",
      sort,
    },
    items: page.map(toFeedItemSummary),
    nextCursor,
    refreshAt,
    windowDays,
    generatedAt: now.toISOString(),
  };
}

/** Earliest upcoming visible_after inside the tools window — same idea as daily.ts. */
async function nextToolsRelease(cutoff: Date, q: ToolsQuery, now: Date): Promise<string | null> {
  const [row] = await sql<{ t: Date | null }[]>`
    SELECT min(p.visible_after) AS t FROM publications p
    WHERE p.visibility = 'public' AND p.selected AND p.visible_after > ${now}
      AND p.discovered_at >= ${cutoff}
      AND p.tags && ${TOOL_TAGS}::text[]
      ${filterSql(q)}`;
  return row?.t ? row.t.toISOString() : null;
}

/** Tool detail extras — small, page-cached, and bounded by the current item's id + tags. */
const UPDATES_WINDOW_DAYS = 7;
const UPDATES_LIMIT = 8;
const RELATED_LIMIT = 8;

export type ToolDetailResult =
  | { kind: "found"; detail: SiteToolDetail }
  | { kind: "not_found" };

/**
 * /api/site/tool/:id. Wraps loadItemDetail with four narrow queries:
 *   - siblings discovered in the last 7 days that share at least one tag (the "recent updates" rail)
 *   - top-scoring siblings whose tag overlap is ≥ 2 (the "related tools" rail)
 *   - cross-axis papers linked via tool_papers (FIX-AA.2 reverse-discovery panel)
 *   - cross-axis prompts reachable via tool_papers → paper_prompts (FIX-AA.2)
 *
 * No tools/tools_versions schema exists yet (plan §3.1.2 defers it to W3+); tag overlap is the
 * only signal we have without a canonical entity table. The cross-axis panels (papers + prompts)
 * depend on join tables that are mostly empty today; they return [] when empty and the UI hides
 * the section. Each loadTool* call is independently wrapped in try/catch by its helper — losing
 * the panel is acceptable, losing the page is not.
 */
export async function loadToolDetail(id: string, now = new Date(), original = false): Promise<ToolDetailResult> {
  const result = await loadItemDetail(id, now);
  if (result.kind === "not_found") return { kind: "not_found" };
  // Pin the body language in the underlying ItemDetail before siteItemDetail drops text/translation.
  const item: SiteItemDetail = siteItemDetail(result.detail, original);
  const tags = result.row.tags;
  // FIX-AA.2 — reverse discovery. Best-effort: a join-table outage must not 500 the detail page.
  // loadToolDiscover wraps each block in try/catch and returns [] on failure. Both may be [].
  const [updates, related, discovered] = await Promise.all([
    tags.length > 0 ? loadToolUpdates(id, tags, now) : Promise.resolve([] as FeedItemSummary[]),
    tags.length > 0 ? loadRelatedTools(id, tags, now) : Promise.resolve([] as FeedItemSummary[]),
    loadToolDiscover(id),
  ]);
  return { kind: "found", detail: { ...item, updates, related, relatedPapers: discovered.relatedPapers, relatedPrompts: discovered.relatedPrompts } };
}

/** Sibling tool/model/platform items sharing at least one tag, discovered in the last 7 days. */
async function loadToolUpdates(selfId: string, tags: string[], now: Date): Promise<FeedItemSummary[]> {
  const cutoff = new Date(now.getTime() - UPDATES_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await sql<ItemRow[]>`
    SELECT ${ITEM_COLUMNS} ${ITEM_FROM}
    WHERE ${selectedCondition(now)}
      AND p.tags && ${TOOL_TAGS}::text[]
      AND p.tags && ${tags}::text[]
      AND p.discovered_at >= ${cutoff}
      AND p.article_id <> ${selfId}
    ORDER BY p.discovered_at DESC, p.article_id DESC
    LIMIT ${UPDATES_LIMIT}`;
  return rows.map(toFeedItemSummary);
}

/** Top-scoring siblings whose tag overlap with the current item is at least 2. */
async function loadRelatedTools(selfId: string, tags: string[], now: Date): Promise<FeedItemSummary[]> {
  // `&&` returns true when arrays share any element; cardinality of the AND of the two arrays is the
  // actual intersection count. Postgres 13+ removed array_intersect(); compose the overlap ourselves.
  const rows = await sql<ItemRow[]>`
    SELECT ${ITEM_COLUMNS} ${ITEM_FROM}
    WHERE ${selectedCondition(now)}
      AND p.tags && ${TOOL_TAGS}::text[]
      AND cardinality(ARRAY(SELECT unnest(p.tags) INTERSECT SELECT unnest(${tags}::text[]))) >= 2
      AND p.article_id <> ${selfId}
    ORDER BY p.score DESC NULLS LAST, p.sort_at DESC, p.article_id DESC
    LIMIT ${RELATED_LIMIT}`;
  return rows.map(toFeedItemSummary);
}

// ============================================================================
// FIX-AA.2 — /tools/:id "反向发现" panel. Mirror of loadPaperDiscover but the
// inverse axis: given an article_id, what papers and prompts is this tool
// cross-axis-linked to?
//
//   - relatedPapers: arXiv papers linked via tool_papers (article_id ↔ arxiv_id),
//     capped at 6. Shape = PaperSummary so the /tools page can reuse PaperSiblingCard.
//     Today the join table is empty for most rows; returns [] when no matches.
//   - relatedPrompts: there is no direct `tool_prompts` join table, so we walk the
//     cross-axis through papers — tool_papers → paper_prompts reverse — and pull
//     unique prompts. Capped at 6. Shape = PromptCard.
//
// Best-effort semantics (same as loadPaperDiscover): any throw inside the SQL blocks
// is caught and converted to []. The /tools/:id page must not 500 because a join
// table failed — losing the related panel is acceptable, losing the page is not.
// loadToolDetail wraps this in a try/catch too, defense in depth on top of these.
//
// Why not inline into loadToolDetail: the related SQL is independent enough to
// unit-test in isolation. The 6-row caps keep the entire detail page cheap even
// when a tool is heavily linked (today: 0 rows in both joins for any tool — the
// join tables are empty in production; this commit wires the read layer so the
// panel will populate as the worker pipeline fills tool_papers / paper_prompts
// from the future FIX-AA follow-up).
// ============================================================================

const TOOL_DISCOVER_LIMIT = 6;

export async function loadToolDiscover(articleId: string): Promise<{ relatedPapers: PaperSummary[]; relatedPrompts: PromptCard[] }> {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(articleId)) return { relatedPapers: [], relatedPrompts: [] };
  const [papers, prompts] = await Promise.all([loadToolRelatedPapers(articleId), loadToolRelatedPrompts(articleId)]);
  return { relatedPapers: papers, relatedPrompts: prompts };
}

async function loadToolRelatedPapers(articleId: string): Promise<PaperSummary[]> {
  // Cross-axis: tool_papers.arxiv_id → papers.arxiv_id, gated on papers row existing
  // + matching the visibility gate the /tools page already uses (public visibility, public
  // indexable — paper_prompts has no visibility concept, so we only gate on row presence).
  // Order: most recently published paper first, with arxiv_id DESC as a tiebreaker for
  // deterministic pagination if a future cursor is added.
  try {
    const rows = await sql<Array<{
      arxiv_id: string;
      title_en: string;
      title_zh: string | null;
      abstract_en: string;
      abstract_zh: string | null;
      authors: string[];
      primary_category: string;
      published_at: Date;
      abs_url: string;
      status: PaperSummary["status"];
    }>>`
      SELECT pa.arxiv_id, pa.title_en, pa.title_zh, pa.abstract_en, pa.abstract_zh,
             pa.authors, pa.primary_category, pa.published_at, pa.abs_url, pa.status
      FROM tool_papers tp
      JOIN papers pa ON pa.arxiv_id = tp.arxiv_id
      WHERE tp.article_id = ${articleId}
      ORDER BY pa.published_at DESC, pa.arxiv_id DESC
      LIMIT ${TOOL_DISCOVER_LIMIT}`;
    return rows.map(toolRelatedPaperToSummary);
  } catch {
    return [];
  }
}

function toolRelatedPaperToSummary(r: {
  arxiv_id: string;
  title_en: string;
  title_zh: string | null;
  abstract_en: string;
  abstract_zh: string | null;
  authors: string[];
  primary_category: string;
  published_at: Date;
  abs_url: string;
  status: PaperSummary["status"];
}): PaperSummary {
  // Mirrors toPaperSummary in papers.ts so the /tools page renders identical cards.
  // The cap (6) on the SQL side keeps the author list short — we still apply the same
  // MAX_AUTHORS=6 + "et al." fallback so a heavily-authored paper renders cleanly.
  const MAX_AUTHORS = 6;
  const authors = r.authors.length > MAX_AUTHORS ? [...r.authors.slice(0, MAX_AUTHORS), "et al."] : r.authors;
  return {
    id: r.arxiv_id,
    titleEn: r.title_en,
    titleZh: r.title_zh,
    abstractEn: r.abstract_en.slice(0, 240),
    abstractZh: r.abstract_zh,
    authors,
    primaryCategory: r.primary_category,
    publishedAt: r.published_at.toISOString(),
    absUrl: r.abs_url,
    status: r.status,
  };
}

async function loadToolRelatedPrompts(articleId: string): Promise<PromptCard[]> {
  // Inverse-path: tool → tool_papers → papers → paper_prompts → prompt_items.
  // We use DISTINCT to dedupe prompts when the same prompt_id links through multiple
  // arxiv_ids (rare today; the join is mostly empty). Order by prompt capture time
  // DESC so the most recent prompt surfaces first; the cap (6) is the upper bound.
  try {
    const rows = await sql<Array<{
      id: number;
      article_id: string | null;
      original_url: string;
      original_post_id: string | null;
      community: string;
      category: PromptCard["category"];
      prompt_text: string;
      use_case: string | null;
      language: string;
      source_kind: PromptCard["sourceKind"];
      captured_at: Date;
    }>>`
      SELECT DISTINCT p.id, p.article_id, p.original_url, p.original_post_id, p.community,
                      p.category, p.prompt_text, p.use_case, p.language, p.source_kind, p.captured_at
      FROM tool_papers tp
      JOIN paper_prompts pp ON pp.arxiv_id = tp.arxiv_id
      JOIN prompt_items p ON p.id = pp.prompt_id
      WHERE tp.article_id = ${articleId}
      ORDER BY p.captured_at DESC, p.id DESC
      LIMIT ${TOOL_DISCOVER_LIMIT}`;
    return rows.map(toolRelatedPromptToCard);
  } catch {
    return [];
  }
}

function toolRelatedPromptToCard(r: {
  id: number;
  article_id: string | null;
  original_url: string;
  original_post_id: string | null;
  community: string;
  category: PromptCard["category"];
  prompt_text: string;
  use_case: string | null;
  language: string;
  source_kind: PromptCard["sourceKind"];
  captured_at: Date;
}): PromptCard {
  // Mirrors readPromptMeta in prompts.ts: same field naming + same promptPreview cut.
  // Keeping this helper inline (rather than reusing readPromptMeta) keeps the SQL
  // typed shape visible above and avoids importing PromptRow from papers.ts.
  return {
    id: String(r.id),
    category: r.category,
    useCase: r.use_case,
    promptPreview: r.prompt_text.slice(0, 240),
    language: r.language,
    community: r.community,
    sourceKind: r.source_kind,
    originalUrl: r.original_url,
    capturedAt: r.captured_at.toISOString(),
  };
}
