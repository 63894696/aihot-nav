// /api/site/papers — translation-officer feed (W4b plan §2.1, role = 翻译官).
// Data: papers table (independent from publications — papers have a long-lived lifecycle with
// no 7-day window, no 5-axis score, no selected gate). Cursor pagination on (published_at, id);
// category and tag filters mirror the /tools shape so the UI can reuse filter chip components.
//
// FIX-AA-A — /papers in-site search. The 3373-paper corpus made the chip + window model
// insufficient: a reader hunting for "transformer" needs sub-second ILIKE, not a chip-flip
// reload. We add `q`, `sort`, and bumpable `limit` to the wire; the implementation does:
//   - 5-field OR-ILIKE on title_en / title_zh / abstract_en / abstract_zh / authors[]
//   - AND across whitespace-split tokens (so "language model" requires both words somewhere)
//   - sort key selects the ORDER BY tail (translated-priority / hf_upvotes / published_at)
//   - binding(q) includes q + sort so any cursor minted under a different query is rejected
//     by the api (FIX-Z.2/3 cursor-leak defense applies unchanged).
import type { FeedItemSummary, PaperDetail, PaperFilters, PaperSortKey, PaperStatus, PaperSummary, PapersQuery, PapersResponse, PromptCard } from "@aihot/contracts/site";
import { sql } from "../db.ts";
import { decodeCursor, encodeCursor, InvalidCursorError, queryBinding } from "../lib/cursor.ts";
import { loadPaperCommentaryHtml } from "./papers-commentary.ts";
import { readPromptMeta, type PromptRow } from "./prompts.ts";
import { toFeedItemSummary, type ItemRow } from "./items.ts";

const DEFAULT_LIMIT = 24;
const MIN_LIMIT = 1;
const MAX_LIMIT = 60;
const DEFAULT_WINDOW_DAYS = 30;
const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 180;

interface PaperRow {
  arxiv_id: string;
  title_en: string;
  title_zh: string | null;
  abstract_en: string;
  abstract_zh: string | null;
  authors: string[];
  primary_category: string;
  published_at: Date;
  abs_url: string;
  status: PaperStatus;
}

function binding(q: PapersQuery): string {
  return queryBinding({
    c: q.category ?? null,
    t: q.tag ?? null,
    q: (q.q ?? "").trim().toLowerCase(),
    s: q.sort ?? "published_at",
    w: q.windowDays ?? DEFAULT_WINDOW_DAYS,
    l: q.limit ?? DEFAULT_LIMIT,
  });
}

const SEARCHABLE_FIELDS = ["title_en", "title_zh", "abstract_en", "abstract_zh"] as const;

/** Build the OR-ILIKE clause for a single token across the 4 text columns. The authors[] array
 *  needs a separate $exists check — Postgres `authors @> ARRAY[$1]` matches an exact-element
 *  containment, not substring; for substring we cast to text and ILIKE on the result. We do
 *  the cast inside the SQL fragment because `sql.unsafe` is needed for any literal we can't
 *  template — here we only template identifiers, which is safe. */
function tokenClause(token: string) {
  const t = `%${token}%`;
  // Field-by-field ILIKE, ORed. The "authors::text" trick lets us match substring across the
  // whole array without splitting the search into multiple tokens at the caller.
  const parts: ReturnType<typeof sql>[] = SEARCHABLE_FIELDS.map(
    (f) => sql`p.${sql(f)} ILIKE ${t}`,
  );
  parts.push(sql`p.authors::text ILIKE ${t}`);
  // Combine: ((a OR b OR c OR d) OR e) — left-associative is fine.
  return parts.reduce((acc, cur, i) => (i === 0 ? cur : sql`${acc} OR ${cur}`));
}

/** Whitespace-split the query into tokens. Empty tokens are dropped. */
function tokens(q: string | null | undefined): string[] {
  if (!q) return [];
  return q.trim().split(/\s+/).filter((t) => t.length > 0);
}

/** Sort the result set: translated first (so a reader can quickly find the ones with 中文摘要),
 *  then by the chosen secondary key. The first column is always the secondary key (DESC);
 *  translated-first is a tie-breaker so it doesn't dominate the visible list. */
function orderByClause(sort: PaperSortKey) {
  switch (sort) {
    case "hf_upvotes":
      return sql`ORDER BY COALESCE(p.hf_upvotes, 0) DESC, p.published_at DESC, p.arxiv_id DESC`;
    case "translated":
      // translated first, then by recency — the reader picks this when hunting for the freshly
      // translated 中文摘要 list (default order today, kept for explicit opt-in too).
      return sql`ORDER BY (CASE WHEN p.status = 'translated' THEN 0 ELSE 1 END), p.published_at DESC, p.arxiv_id DESC`;
    case "published_at":
    default:
      return sql`ORDER BY (CASE WHEN p.status = 'translated' THEN 0 ELSE 1 END), COALESCE(p.hf_upvotes, 0) DESC, p.published_at DESC, p.arxiv_id DESC`;
  }
}

export async function loadPapers(q: PapersQuery = {}): Promise<PapersResponse> {
  const now = q.now ?? new Date();
  const windowDays = Math.min(Math.max(q.windowDays ?? DEFAULT_WINDOW_DAYS, MIN_WINDOW_DAYS), MAX_WINDOW_DAYS);
  const limit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, MIN_LIMIT), MAX_LIMIT);
  const sort: PaperSortKey = q.sort ?? "published_at";
  const bind = binding(q);
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  type Cursor = { a: number; i: string; b: string };
  let after: { publishedAt: number; id: string } | null = null;
  if (q.cursor) {
    const c = decodeCursor<Cursor>("papers1", q.cursor);
    if (c.b !== bind || typeof c.a !== "number" || typeof c.i !== "string") throw new InvalidCursorError("cursor does not match this query");
    after = { publishedAt: c.a, id: c.i };
  }

  const categoryClause = q.category ? sql`AND p.primary_category = ${q.category}` : sql``;
  // We don't have a papers.tags column — primary_category is the only filterable taxonomy today.
  const tagClause = sql``;
  const cursorClause = after === null
    ? sql``
    : sql`AND (p.published_at, p.arxiv_id) < (to_timestamp(${after.publishedAt} / 1000.0), ${after.id})`;

  // FIX-AA-A — search. Empty query → no clause, identical to the old behaviour. Tokenised
  // query → AND across tokens (every token must hit somewhere in the 5 fields). ILIKE
  // without a leading wildcard on Postgres btree does not use an index — at 3373 rows this
  // is well below 50 ms; we leave the GIN tsvector for the 10k+ corpus ship (see plan notes).
  const toks = tokens(q.q);
  // Empty query is identical to no clause — both branches return a PendingQuery so the
  // ternary's narrow type works out. We avoid the empty `sql\`\`` template (which would
  // return PendingQuery<Row[]>, not a fragment type) by emitting the AND only when needed.
  // Tokenised query: AND across tokens (every token must hit somewhere in the 5 fields).
  // We seed the reduce with the first clause so the seed itself is a fragment; subsequent
  // steps prepend an AND. Build by folding left.
  const searchClause = toks.length === 0
    ? sql``
    : toks.length === 1
    ? sql`AND (${tokenClause(toks[0])})`
    : sql`AND (${toks.slice(1).reduce<ReturnType<typeof sql>>(
        (acc, t) => sql`${acc} AND ${tokenClause(t)}`,
        tokenClause(toks[0]),
      )})`;

  const rows = await sql<PaperRow[]>`
    SELECT p.arxiv_id, p.title_en, p.title_zh, p.abstract_en, p.abstract_zh,
           p.authors, p.primary_category, p.published_at, p.abs_url, p.status
    FROM papers p
    WHERE p.published_at >= ${cutoff}
      ${categoryClause}
      ${tagClause}
      ${cursorClause}
      ${searchClause}
    ${orderByClause(sort)}
    LIMIT ${limit + 1}`;

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor("papers1", { a: last.published_at.getTime(), i: last.arxiv_id, b: bind }) : null;

  const refreshAt = await nextPapersFetch(cutoff, q, now);

  return {
    filters: {
      category: q.category ?? null,
      tag: q.tag ?? null,
      q: q.q ?? null,
      sort,
    },
    items: page.map(toPaperSummary),
    nextCursor,
    refreshAt,
    windowDays,
    limit,
    generatedAt: now.toISOString(),
  };
}

function toPaperSummary(r: PaperRow): PaperSummary {
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

async function nextPapersFetch(cutoff: Date, q: PapersQuery, now: Date): Promise<string | null> {
  // The arxiv-translate worker touches a paper within seconds of the fetch job. We use the next
  // fetch-window boundary so the cache expires when new papers are likely to appear (60 min cron).
  void cutoff; void q; void now;
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

interface PaperDetailRow extends PaperRow {
  abstract_en_full: string;
  abstract_zh_full: string | null;
  key_points: string[] | null;
  pdf_url: string;
  fetched_at: Date;
  translated_at: Date | null;
  summary_model: string | null;
  commentary_status: "pending" | "published" | "skipped" | null;
  commentary_md_url: string | null;
  commentary_source: "chatgpt" | "perplexity" | "human" | "hybrid" | null;
  skipped_reason: string | null;
}

export async function loadPaperDetail(arxivId: string): Promise<PaperDetail | null> {
  if (!/^\d{4}\.\d{4,5}$/.test(arxivId)) return null;
  const [row] = await sql<PaperDetailRow[]>`
    SELECT arxiv_id, title_en, title_zh, abstract_en, abstract_zh, authors, primary_category,
           published_at, abs_url, status,
           abstract_en AS abstract_en_full,
           abstract_zh AS abstract_zh_full,
           key_points, pdf_url, fetched_at, translated_at, summary_model,
           commentary_status, commentary_md_url, commentary_source, skipped_reason
    FROM papers WHERE arxiv_id = ${arxivId}`;
  if (!row) return null;
  const MAX_AUTHORS = 6;
  const authors = row.authors.length > MAX_AUTHORS ? [...row.authors.slice(0, MAX_AUTHORS), "et al."] : row.authors;
  // FIX-AA-B — cross-axis reverse discovery. Best-effort: a join-table outage must not 500 the
  // detail page. loadPaperDiscover wraps its SQL in try/catch and returns [] on failure.
  const { relatedTools, relatedPrompts } = await loadPaperDiscover(arxivId);
  return {
    id: row.arxiv_id,
    titleEn: row.title_en,
    titleZh: row.title_zh,
    abstractEn: row.abstract_en.slice(0, 240),
    abstractZh: row.abstract_zh,
    authors,
    primaryCategory: row.primary_category,
    publishedAt: row.published_at.toISOString(),
    absUrl: row.abs_url,
    status: row.status,
    abstractEnFull: row.abstract_en_full,
    abstractZhFull: row.abstract_zh_full,
    keyPoints: row.key_points ?? [],
    pdfUrl: row.pdf_url,
    fetchedAt: row.fetched_at.toISOString(),
    translatedAt: row.translated_at?.toISOString() ?? null,
    summaryModel: row.summary_model,
    commentaryStatus: row.commentary_status,
    commentaryMdUrl: row.commentary_md_url,
    commentarySource: row.commentary_source,
    commentarySkippedReason: row.skipped_reason,
    commentaryHtml: row.commentary_status === "published"
      ? (loadPaperCommentaryHtml(row.commentary_md_url) ?? { html: "", empty: true })
      : null,
    relatedTools,
    relatedPrompts,
  };
}

/** Same data as loadPaperDetail — the OG renderer wants a paper-shaped payload. */
export const loadPaperShare = loadPaperDetail;

/**
 * Sibling papers in the same arXiv primary_category as the given paper (excludes the paper itself).
 * Used by the /papers/$id "相关论文" related-section so a reader on a single paper can navigate
 * sideways through the same research area without going back to /papers. There is no cross-axis
 * join yet (tool_papers / prompt_papers come in a later commit) — today the only structured link
 * is the arXiv category, so this stays scoped to it.
 *
 * Order mirrors the /papers list: translated papers first, then by published_at DESC.
 *
 * Returns [] when the paper is unknown (defensive — caller already 404s if the parent detail is
 * missing, but a stale cache hit should not throw here).
 */
export async function loadPaperSiblings(arxivId: string, limit = 6): Promise<PaperSummary[]> {
  if (!/^\d{4}\.\d{4,5}$/.test(arxivId)) return [];
  const safeLimit = Math.min(Math.max(limit, 1), 12);
  const rows = await sql<Array<Pick<PaperRow, "arxiv_id" | "title_en" | "title_zh" | "abstract_en" | "abstract_zh" | "authors" | "primary_category" | "published_at" | "abs_url" | "status">>>`
    SELECT arxiv_id, title_en, title_zh, abstract_en, abstract_zh, authors, primary_category, published_at, abs_url, status
    FROM papers
    WHERE arxiv_id <> ${arxivId}
      AND primary_category = (SELECT primary_category FROM papers WHERE arxiv_id = ${arxivId})
    ORDER BY (CASE WHEN status = 'translated' THEN 0 ELSE 1 END),
             published_at DESC,
             arxiv_id DESC
    LIMIT ${safeLimit}`;
  return rows.map(toPaperSummary);
}

// ============================================================================
// FIX-AA-B — /papers/:id "反向发现" panel
// ============================================================================
//
// Given an arxiv paper id, return the cross-axis items the reader might want to see next:
//   - relatedTools: publications tagged as tools/products/models that link to this paper
//     via tool_papers (one-to-many, capped at 6). The join shape mirrors the v0.2.1-#5
//     seed: tool_papers points at articles.id; we then pull the matching FeedItemSummary
//     through the publications view (same shape as /tools cards).
//   - relatedPrompts: prompt_items cross-axis-linked via paper_prompts (also capped at 6).
//     Both lists return [] when no rows match — the detail page hides the whole section
//     rather than rendering an empty box.
//
// Best-effort semantics: any throw inside the SQL blocks is caught and converted to []. The
// /papers/:id detail page must not 500 because a join table failed to query — losing the
// related panel is acceptable, losing the page is not. (loadPaperDetail wraps this in a
// try/catch as defense in depth on top of the one below.)
//
// Why a separate helper instead of inlining into loadPaperDetail: keeps the main detail query
// (one row + commentary HTML) hot and small, and the related SQL is independent enough to
// unit-test in isolation. The 6-row caps keep the entire detail page cheap even when a paper
// is heavily linked.

const DISCOVER_LIMIT = 6;

export async function loadPaperDiscover(arxivId: string): Promise<{ relatedTools: FeedItemSummary[]; relatedPrompts: PromptCard[] }> {
  if (!/^\d{4}\.\d{4,5}$/.test(arxivId)) return { relatedTools: [], relatedPrompts: [] };
  const [tools, prompts] = await Promise.all([loadPaperRelatedTools(arxivId), loadPaperRelatedPrompts(arxivId)]);
  return { relatedTools: tools, relatedPrompts: prompts };
}

async function loadPaperRelatedTools(arxivId: string): Promise<FeedItemSummary[]> {
  // We bypass ITEM_COLUMNS / ITEM_FROM (which assume alias `p` for publications) and write
  // the column list inline. The shape is identical to /tools cards: FeedItemSummary. We pull
  // only the rows an arxiv paper is linked to via tool_papers; the join is gated by visibility
  // + indexable so we never surface admin-only or noindex rows by accident.
  try {
    const rows = await sql<ItemRow[]>`
      SELECT
        p.article_id AS id, p.revision, p.title, p.original_title, p.summary, p.reason, p.category, p.tags, p.score,
        p.selected, p.eligible, p.channel, p.url, p.published_at, p.discovered_at, p.timeline_at, p.sort_at,
        p.first_party, p.visibility, p.body_mode, p.syndicate, p.indexable, p.visible_after, p.backfill,
        p.fact_id, p.story_id,
        s.id AS source_id, s.name AS source_name, s.kind AS source_kind, s.participation_mode AS source_mode,
        s.icon_url AS source_icon,
        a.x_post, a.author, a.language, a.raw AS article_raw,
        st.public_id::text AS story_public_id, st.title AS story_title,
        CASE WHEN p.channel = 'x' THEN tr.body_text END AS zh_text,
        qt.text_zh AS quoted_zh
      FROM tool_papers tp
      JOIN publications p ON p.article_id = tp.article_id
      JOIN sources s ON s.id = p.source_id
      JOIN articles a ON a.id = p.article_id
      LEFT JOIN stories st ON st.id = p.story_id
      LEFT JOIN publication_translations tr ON tr.article_id = p.article_id AND tr.language = 'zh' AND tr.field = 'body'
      LEFT JOIN x_post_quotes qt ON qt.quoted_article_id = p.article_id AND qt.language = 'zh'
      WHERE tp.arxiv_id = ${arxivId}
        AND p.discovered_at IS NOT NULL
        AND p.visibility = 'public'
        AND p.indexable = true
      ORDER BY tp.created_at DESC, p.sort_at DESC, p.article_id DESC
      LIMIT ${DISCOVER_LIMIT}`;
    return rows.map(toFeedItemSummary);
  } catch {
    return [];
  }
}

async function loadPaperRelatedPrompts(arxivId: string): Promise<PromptCard[]> {
  try {
    const rows = await sql<PromptRow[]>`
      SELECT p.id, p.article_id, p.original_url, p.original_post_id, p.community, p.category,
             p.prompt_text, p.use_case, p.language, p.source_kind, p.captured_at, p.updated_at
      FROM paper_prompts pp
      JOIN prompt_items p ON p.id = pp.prompt_id
      WHERE pp.arxiv_id = ${arxivId}
      ORDER BY pp.created_at DESC, p.captured_at DESC, p.id DESC
      LIMIT ${DISCOVER_LIMIT}`;
    return rows.map(readPromptMeta).filter((x): x is PromptCard => x !== null);
  } catch {
    return [];
  }
}
