// Daily fresh-tools list for /api/site/daily: a focused window on tool_release items.
// Filter: selected + visible_after gate + tag contains "新工具" + score ≥ minScore + discovered within sinceHours.
// Sort: score desc, sort_at desc. Top N (default 30).
// Designed for the navigation layer's "每日新品" homepage; does not fold items into reading groups
// (timeline.ts groups by story/fact, daily keeps each item flat for card-by-card rendering).
import type { FeedItemSummary } from "@aihot/contracts/site";
import { sql } from "../db.ts";
import { ITEM_COLUMNS, ITEM_FROM, selectedCondition, toFeedItemSummary, type ItemRow } from "./items.ts";

export interface DailyQuery {
  sinceHours?: number;   // default 24
  minScore?: number;     // default 70
  limit?: number;        // default 30, capped 60
  now?: Date;
}

export interface DailyResponse {
  items: FeedItemSummary[];
  refreshAt: string | null;
  generatedAt: string;
}

/**
 * Tags that mark an item as a "new tool / model / platform" — the "AI 圈新工具" set
 * surfaced on /new and reused by /tools. Legacy items carry the deprecated "新工具" tag
 * (pre-prompt-whitelist); current model output puts one of {产品更新, 模型发布, 平台} as
 * the first CATEGORY_TAG. We match either so the homepage keeps working across the cutover.
 */
const NEW_TOOL_TAGS = ["新工具", "产品更新", "模型发布", "平台"];

export async function loadDaily(q: DailyQuery = {}): Promise<DailyResponse> {
  const now = q.now ?? new Date();
  const sinceHours = Math.min(Math.max(q.sinceHours ?? 24, 1), 168);   // 1h..7d
  const minScore = Math.min(Math.max(q.minScore ?? 70, 0), 100);
  const limit = Math.min(Math.max(q.limit ?? 30, 1), 60);
  const cutoff = new Date(now.getTime() - sinceHours * 60 * 60 * 1000);

  const rows = await sql<ItemRow[]>`
    SELECT ${ITEM_COLUMNS} ${ITEM_FROM}
    WHERE ${selectedCondition(now)}
      AND p.discovered_at >= ${cutoff}
      AND p.score >= ${minScore}
      AND p.tags && ${NEW_TOOL_TAGS}::text[]
    ORDER BY p.score DESC NULLS LAST, p.sort_at DESC, p.discovered_at DESC
    LIMIT ${limit}`;

  const refreshAt = await nextDailyRelease(cutoff, minScore, now);

  return {
    items: rows.map(toFeedItemSummary),
    refreshAt,
    generatedAt: now.toISOString(),
  };
}

/** Earliest upcoming visible_after inside the daily window — caches expire by then so a new release appears promptly. */
async function nextDailyRelease(cutoff: Date, minScore: number, now: Date): Promise<string | null> {
  const [row] = await sql<{ t: Date | null }[]>`
    SELECT min(p.visible_after) AS t FROM publications p
    WHERE p.visibility = 'public' AND p.selected AND p.visible_after > ${now}
      AND p.discovered_at >= ${cutoff} AND p.score >= ${minScore}
      AND p.tags && ${NEW_TOOL_TAGS}::text[]`;
  return row?.t ? row.t.toISOString() : null;
}