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

import type { PromptCard, PromptDetail, PromptCategory, PromptsQuery, PromptsResponse, PromptSourceKind } from "@aihot/contracts/site";
import { PROMPT_CATEGORIES } from "@aihot/contracts/site";
import { sql } from "../db.ts";
import { decodeCursor, encodeCursor, InvalidCursorError, queryBinding } from "../lib/cursor.ts";

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

  return {
    ...card,
    promptText: row.prompt_text,
    originalPostId: row.original_post_id,
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
