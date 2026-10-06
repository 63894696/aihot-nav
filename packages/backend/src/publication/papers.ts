// /api/site/papers — translation-officer feed (W4b plan §2.1, role = 翻译官).
// Data: papers table (independent from publications — papers have a long-lived lifecycle with
// no 7-day window, no 5-axis score, no selected gate). Cursor pagination on (published_at, id);
// category and tag filters mirror the /tools shape so the UI can reuse filter chip components.
import type { PaperDetail, PaperFilters, PaperStatus, PaperSummary, PapersQuery, PapersResponse } from "@aihot/contracts/site";
import { sql } from "../db.ts";
import { decodeCursor, encodeCursor, InvalidCursorError, queryBinding } from "../lib/cursor.ts";
import { loadPaperCommentaryHtml } from "./papers-commentary.ts";

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
  return queryBinding({ c: q.category ?? null, t: q.tag ?? null, w: q.windowDays ?? DEFAULT_WINDOW_DAYS, l: q.limit ?? DEFAULT_LIMIT });
}

export async function loadPapers(q: PapersQuery = {}): Promise<PapersResponse> {
  const now = q.now ?? new Date();
  const windowDays = Math.min(Math.max(q.windowDays ?? DEFAULT_WINDOW_DAYS, MIN_WINDOW_DAYS), MAX_WINDOW_DAYS);
  const limit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, MIN_LIMIT), MAX_LIMIT);
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

  const rows = await sql<PaperRow[]>`
    SELECT p.arxiv_id, p.title_en, p.title_zh, p.abstract_en, p.abstract_zh,
           p.authors, p.primary_category, p.published_at, p.abs_url, p.status
    FROM papers p
    WHERE p.published_at >= ${cutoff}
      ${categoryClause}
      ${tagClause}
      ${cursorClause}
    ORDER BY (CASE WHEN p.status = 'translated' THEN 0 ELSE 1 END),
             COALESCE(p.hf_upvotes, 0) DESC,
             p.published_at DESC,
             p.arxiv_id DESC
    LIMIT ${limit + 1}`;

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor("papers1", { a: last.published_at.getTime(), i: last.arxiv_id, b: bind }) : null;

  const refreshAt = await nextPapersFetch(cutoff, q, now);

  return {
    filters: { category: q.category ?? null, tag: q.tag ?? null },
    items: page.map(toPaperSummary),
    nextCursor,
    refreshAt,
    windowDays,
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
