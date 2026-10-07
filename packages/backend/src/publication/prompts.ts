// /api/site/prompts — W5-3 prompt column public read layer.
//
// Why this file:
// - The prompt column shows visitors a list of reusable prompts scraped from public posts. We
//   deliberately keep this read layer independent of `articles`: a prompt is its own object (its
//   own URL, its own use case), not an article with a flag.
// - The cursor key is (captured_at, id) so pagination stays stable as new prompts arrive; window
//   is symmetric with /papers and /topics so the UI can reuse filter chip components.
//
// Invariants:
// - Only rows with a real prompt_text + category + community are returned. Half-imported rows
//   (where the editorial promptVersion produced null) are kept in the table for auditing but
//   stay out of this read layer.
// - `readPromptMeta` is the only place we ever construct a PromptCard from a row — API callers
//   go through `loadPrompts` / `loadPromptDetail`, which use it internally. This is the gate that
//   keeps sensitive fields (article_id, internal ids) out of the wire.
//
// Comments:
// - 2026-10-05: source_comments fetcher removed (zero production callers, zero rows produced).
//   loadPromptDetail now returns `comments: []` + `commentFetchStatus: 'ok'` so the wire shape
//   stays stable. The detail page UX path "原帖暂无评论。" stays the same.

import type { FeedItemSummary, PaperSummary, PromptCard, PromptDetail, PromptCategory, PromptsQuery, PromptsResponse, PromptSourceKind } from "@aihot/contracts/site";
import { PROMPT_CATEGORIES } from "@aihot/contracts/site";
import { sql } from "../db.ts";
import { decodeCursor, encodeCursor, InvalidCursorError, queryBinding } from "../lib/cursor.ts";
import { toFeedItemSummary, type ItemRow } from "./items.ts";
import { toPaperSummary } from "./papers.ts";

const DEFAULT_LIMIT = 24;
const MIN_LIMIT = 1;
const MAX_LIMIT = 60;
const DEFAULT_WINDOW_DAYS = 90;
const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 365;
const PROMPT_PREVIEW_CHARS = 240;

export interface PromptRow {
  id: number;
  article_id: string | null;
  original_url: string;
  original_post_id: string | null;
  community: string;
  category: string;
  prompt_text: string;
  use_case: string | null;
  language: string;
  source_kind: string;
  captured_at: Date;
  updated_at: Date;
}

export async function loadPrompts(q: PromptsQuery = {}): Promise<PromptsResponse> {
  const now = q.now ?? new Date();
  const windowDays = Math.min(Math.max(q.windowDays ?? DEFAULT_WINDOW_DAYS, MIN_WINDOW_DAYS), MAX_WINDOW_DAYS);
  const limit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, MIN_LIMIT), MAX_LIMIT);
  const bind = queryBinding({ c: q.category ?? null, w: windowDays, l: limit });
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  type Cursor = { a: number; i: string; b: string };
  let after: { capturedAt: number; id: string } | null = null;
  if (q.cursor) {
    const c = decodeCursor<Cursor>("prompts1", q.cursor);
    if (c.b !== bind || typeof c.a !== "number" || typeof c.i !== "string") throw new InvalidCursorError("cursor does not match this query");
    after = { capturedAt: c.a, id: c.i };
  }

  const categoryClause = q.category ? sql`AND p.category = ${q.category}` : sql``;
  const cursorClause = after === null
    ? sql``
    : sql`AND (p.captured_at, p.id::text) < (to_timestamp(${after.capturedAt} / 1000.0), ${after.id})`;

  const rows = await sql<PromptRow[]>`
    SELECT p.id, p.article_id, p.original_url, p.original_post_id, p.community, p.category,
           p.prompt_text, p.use_case, p.language, p.source_kind, p.captured_at, p.updated_at
    FROM prompt_items p
    WHERE p.captured_at >= ${cutoff}
      AND p.prompt_text IS NOT NULL AND length(p.prompt_text) > 0
      AND p.category = ANY (${PROMPT_CATEGORIES}::text[])
      ${categoryClause}
      ${cursorClause}
    ORDER BY p.captured_at DESC, p.id DESC
    LIMIT ${limit + 1}`;

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor("prompts1", { a: last.captured_at.getTime(), i: last.id.toString(), b: bind }) : null;

  return {
    filters: { category: q.category ?? null },
    items: page.map(readPromptMeta).filter((x): x is PromptCard => x !== null),
    nextCursor,
    refreshAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    windowDays,
    generatedAt: now.toISOString(),
  };
}

export async function loadPromptDetail(id: string): Promise<PromptDetail | null> {
  const numericId = Number(id);
  const rows = await sql<PromptRow[]>`
    SELECT id, article_id, original_url, original_post_id, community, category,
           prompt_text, use_case, language, source_kind, captured_at, updated_at
    FROM prompt_items
    WHERE id = ${numericId}
    LIMIT 1`;
  const row = rows[0];
  if (!row) return null;
  const card = readPromptMeta(row);
  if (!card) return null;

  // FIX-AA.3 — populate the reverse-discovery panel directly on the detail object. This avoids
  // a second SSR fetch on the /prompts/:id page (the web loader already issues one for the
  // discover endpoint, but the api consumer of `loadPromptDetail` — if any — would otherwise
  // see a wire shape missing the two new keys). Best-effort: SQL throw on either join returns
  // [] so a join-table outage degrades to "panel hides" rather than 500.
  const { relatedPapers, relatedTools } = await loadPromptDiscover(id);

  return {
    ...card,
    promptText: row.prompt_text,
    originalPostId: row.original_post_id,
    relatedPapers,
    relatedTools,
  };
}

/**
 * Single gate that converts a DB row into a wire-shaped PromptCard. Returns null when the row is
 * malformed for the public surface (unknown category, missing prompt text, etc.). Every API path
 * that exposes prompt data goes through here so we never accidentally leak internal fields.
 */
export function readPromptMeta(row: PromptRow): PromptCard | null {
  if (!PROMPT_CATEGORIES.includes(row.category as PromptCategory)) return null;
  if (!row.prompt_text || row.prompt_text.length === 0) return null;
  const useCase = row.use_case?.trim() ?? null;
  const preview = row.prompt_text.length > PROMPT_PREVIEW_CHARS
    ? row.prompt_text.slice(0, PROMPT_PREVIEW_CHARS) + "…"
    : row.prompt_text;
  return {
    id: row.id.toString(),
    category: row.category as PromptCategory,
    useCase: useCase && useCase.length > 0 ? useCase : null,
    promptPreview: preview,
    language: row.language,
    community: row.community,
    sourceKind: normaliseSourceKind(row.source_kind),
    originalUrl: row.original_url,
    capturedAt: row.captured_at.toISOString(),
  };
}

function normaliseSourceKind(kind: string): PromptSourceKind {
  if (kind === "rss" || kind === "external" || kind === "searxng_search" || kind === "manual") return kind;
  return "external";
}

// ============================================================================
// FIX-AA.3 — /prompts/:id "反向发现" panel
// ============================================================================
//
// Given a prompt id (numeric, as a string), return the cross-axis items the reader might want to
// see next:
//   - relatedPapers: arXiv papers linked to this prompt via paper_prompts (capped at 6). Uses
//     the same PaperSummary shape as /papers list cards so /prompts/:id can reuse PaperSiblingCard.
//   - relatedTools: tools reachable from this prompt via paper_prompts → arxiv_id → tool_papers →
//     tools (2-hop; no direct prompt_prompts join exists today). FeedItemSummary because that's
//     the canonical /tools card shape.
//
// Both lists return [] when no rows match — the /prompts/:id detail page hides the whole panel
// rather than rendering an empty box (Lesson 13c: every cross-axis detail page renders-or-hides
// the same way).
//
// Best-effort semantics: any throw inside the SQL blocks is caught and converted to []. The
// /prompts/:id detail page must not 500 because a join table failed to query — losing the
// related panel is acceptable, losing the page is not. (loadPromptDiscover wraps each block in
// a try/catch as defense in depth.)
//
// Why a separate helper instead of inlining into loadPromptDetail: keeps the main detail query
// (one row + promptText) hot and small, and the related SQL is independent enough to unit-test
// in isolation. The 6-row caps keep the entire detail page cheap even when a prompt is heavily
// linked.
const PROMPT_DISCOVER_LIMIT = 6;

export async function loadPromptDiscover(promptId: string): Promise<{ relatedPapers: PaperSummary[]; relatedTools: FeedItemSummary[] }> {
  if (!/^\d{1,20}$/.test(promptId)) return { relatedPapers: [], relatedTools: [] };
  const numericId = Number(promptId);
  if (!Number.isFinite(numericId) || numericId <= 0) return { relatedPapers: [], relatedTools: [] };
  const [papers, tools] = await Promise.all([
    loadPromptRelatedPapers(numericId),
    loadPromptRelatedTools(numericId),
  ]);
  return { relatedPapers: papers, relatedTools: tools };
}

async function loadPromptRelatedPapers(promptId: number): Promise<PaperSummary[]> {
  try {
    const rows = await sql<Array<Pick<{
      arxiv_id: string; title_en: string; title_zh: string | null; abstract_en: string; abstract_zh: string | null;
      authors: string[]; primary_category: string; published_at: Date; abs_url: string; status: PaperSummary["status"];
    }, "arxiv_id" | "title_en" | "title_zh" | "abstract_en" | "abstract_zh" | "authors" | "primary_category" | "published_at" | "abs_url" | "status">>>`
      SELECT arxiv_id, title_en, title_zh, abstract_en, abstract_zh, authors, primary_category, published_at, abs_url, status
      FROM papers
      WHERE arxiv_id IN (SELECT arxiv_id FROM paper_prompts WHERE prompt_id = ${promptId})
      ORDER BY (CASE WHEN status = 'translated' THEN 0 ELSE 1 END),
               published_at DESC,
               arxiv_id DESC
      LIMIT ${PROMPT_DISCOVER_LIMIT}`;
    return rows.map(toPaperSummary);
  } catch {
    return [];
  }
}

async function loadPromptRelatedTools(promptId: number): Promise<FeedItemSummary[]> {
  // 2-hop: prompt_id → paper_prompts → arxiv_id → tool_papers → tools (publications). The
  // column list mirrors loadPaperRelatedTools (FIX-AA.2 in papers.ts) verbatim so we reuse
  // toFeedItemSummary to produce the canonical /tools card surface. Visibility + indexable gates
  // ensure we never surface admin-only or noindex rows by accident.
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
      LEFT JOIN stories st ON st.id = p.story_id AND st.merged_into IS NULL
      LEFT JOIN translations tr ON tr.article_id = p.article_id AND tr.lang = 'zh' AND tr.revision >= a.revision
      LEFT JOIN quote_translations qt ON p.channel = 'x' AND qt.tweet_id = substring(a.x_post->'quoted'->>'url' from '/status/([0-9]+)')
      WHERE tp.arxiv_id IN (SELECT arxiv_id FROM paper_prompts WHERE prompt_id = ${promptId})
        AND p.discovered_at IS NOT NULL
        AND p.visibility = 'public'
        AND p.indexable = true
      ORDER BY tp.created_at DESC, p.sort_at DESC, p.article_id DESC
      LIMIT ${PROMPT_DISCOVER_LIMIT}`;
    return rows.map(toFeedItemSummary);
  } catch {
    return [];
  }
}
