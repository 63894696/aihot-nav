// /api/site/changelog — tool/model/platform update aggregation (W4a, plan §2.1).
// Data source: publications WHERE tags && ['产品更新'] (no itemType column on publications; tags only).
// Pattern: mirrors loadTools() — same windowDays/cursor/filter shape, no score in output, default sort
// is `discovered_at DESC` (newest first) since the page is a feed, not a ranking.
//
// Filtering by `tag` (and the channel/category axes) reuses the helpers in items.ts so the WHERE
// composition stays consistent with /api/site/timeline and /api/site/tools.
import type { CategoryKey, ChannelKey } from "@aihot/contracts/taxonomy";
import type { FeedItemSummary } from "@aihot/contracts/site";
import { sql } from "../db.ts";
import { decodeCursor, encodeCursor, InvalidCursorError, queryBinding } from "../lib/cursor.ts";
import {
  ITEM_COLUMNS, ITEM_FROM, categoryCondition, channelCondition, selectedCondition, tagCondition, toFeedItemSummary, type ItemRow,
} from "./items.ts";

/** Tag set that qualifies a publication as a tool/model/platform update. Single-tag filter
 *  (vs loadTools' `&& TOOL_TAGS`) because /changelog is update-only — not the full tool surface. */
const UPDATE_TAGS = ["产品更新"] as const;

/** Defaults — outside these the UI would render a broken page or hit a slow query. */
const DEFAULT_LIMIT = 60;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;
const DEFAULT_WINDOW_DAYS = 30;
const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 90;

export interface ChangelogQuery {
  category?: CategoryKey | null;
  tag?: string | null;
  channel?: ChannelKey;
  /** Time window in days (default 30, capped 1..90). */
  windowDays?: number;
  /** Page size (default 60, capped 1..100). Larger than /tools (24) because this is a feed view. */
  limit?: number;
  /** Opaque cursor returned by a prior request. */
  cursor?: string | null;
  /** Frozen "now" for deterministic tests. */
  now?: Date;
}

export interface ChangelogResponse {
  filters: { channel: string; category: string | null; tag: string | null };
  items: FeedItemSummary[];
  nextCursor: string | null;
  /** Earliest upcoming visible_after in scope — caches expire then (matches /api/site/tools). */
  refreshAt: string | null;
  windowDays: number;
  generatedAt: string;
}

function binding(q: ChangelogQuery): string {
  return queryBinding({ c: q.channel ?? "all", k: q.category ?? null, t: q.tag ?? null, w: q.windowDays ?? DEFAULT_WINDOW_DAYS, l: q.limit ?? DEFAULT_LIMIT });
}

function filterSql(q: ChangelogQuery) {
  return sql`${channelCondition(q.channel)} ${categoryCondition(q.category)} ${tagCondition(q.tag)}`;
}

export async function loadChangelog(q: ChangelogQuery = {}): Promise<ChangelogResponse> {
  const now = q.now ?? new Date();
  const windowDays = Math.min(Math.max(q.windowDays ?? DEFAULT_WINDOW_DAYS, MIN_WINDOW_DAYS), MAX_WINDOW_DAYS);
  const limit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, MIN_LIMIT), MAX_LIMIT);
  const bind = binding(q);
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  // Decode cursor (discovered_at + article_id, bound to this filter scope). No score dimension.
  type Cursor = { d: number; i: string; b: string };
  let after: { discoveredAt: number; id: string } | null = null;
  if (q.cursor) {
    const c = decodeCursor<Cursor>("changelog1", q.cursor);
    if (c.b !== bind || typeof c.d !== "number" || typeof c.i !== "string") throw new InvalidCursorError("cursor does not match this query");
    after = { discoveredAt: c.d, id: c.i };
  }

  const cursorPredicate = after === null
    ? sql``
    : sql`AND (p.discovered_at, p.article_id) < (to_timestamp(${after.discoveredAt / 1000}), ${after.id})`;

  const rows = await sql<ItemRow[]>`
    SELECT ${ITEM_COLUMNS} ${ITEM_FROM}
    WHERE ${selectedCondition(now)}
      AND p.discovered_at >= ${cutoff}
      AND p.tags && ${UPDATE_TAGS}::text[]
      ${filterSql(q)}
      ${cursorPredicate}
    ORDER BY p.discovered_at DESC, p.article_id DESC
    LIMIT ${limit + 1}`;

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = hasMore && last
    ? encodeCursor("changelog1", { d: last.discovered_at.getTime(), i: last.id, b: bind })
    : null;

  // Earliest upcoming visible_after inside the changelog window — caches expire then.
  const refreshAt = await nextChangelogRelease(cutoff, q, now);

  return {
    filters: {
      channel: q.channel ?? "all",
      category: q.category ?? null,
      tag: q.tag ?? null,
    },
    items: page.map(toFeedItemSummary),
    nextCursor,
    refreshAt,
    windowDays,
    generatedAt: now.toISOString(),
  };
}

/** Earliest upcoming visible_after inside the changelog window — same idea as tools.ts. */
async function nextChangelogRelease(cutoff: Date, q: ChangelogQuery, now: Date): Promise<string | null> {
  const [row] = await sql<{ t: Date | null }[]>`
    SELECT min(p.visible_after) AS t FROM publications p
    WHERE p.visibility = 'public' AND p.selected AND p.visible_after > ${now}
      AND p.discovered_at >= ${cutoff}
      AND p.tags && ${UPDATE_TAGS}::text[]
      ${filterSql(q)}`;
  return row?.t ? row.t.toISOString() : null;
}
