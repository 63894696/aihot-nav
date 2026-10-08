// Public pool (/all) with numeric pages, and search in its two orderings.
import type { PoolResponse, TimelineFilters } from "@aihot/contracts/site";
import type { FeedItemSummary } from "@aihot/contracts/site";
import { beijingDate, beijingMidnight } from "@aihot/contracts/time";
import { one, sql, withCustomPlans, type Db } from "../db.ts";
import { isCategoryKey } from "@aihot/contracts/taxonomy";
import {
  categoryCondition, channelCondition, ITEM_COLUMNS, ITEM_FROM, listedCondition, tagCondition, toFeedItemSummary, topicCondition,
  type ItemRow,
} from "./items.ts";

export const POOL_PAGE_SIZE = 40;
export const POOL_MAX_PAGES = 50;

export class SearchBusyError extends Error {
  readonly retryAfter: number;
  constructor(retryAfter: number) {
    super("search capacity exhausted");
    this.retryAfter = retryAfter;
  }
}

// Search capacity guard: bounded concurrency with a short queue. Overflow answers 503 + Retry-After
// instead of letting machine traffic drag list browsing down.
const MAX_CONCURRENT_SEARCHES = Number(process.env.SEARCH_MAX_CONCURRENCY || 4);
const MAX_QUEUED_SEARCHES = Number(process.env.SEARCH_MAX_QUEUE || 8);
let running = 0;
const waiters: Array<() => void> = [];

export async function withSearchCapacity<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT_SEARCHES) {
    if (waiters.length >= MAX_QUEUED_SEARCHES) throw new SearchBusyError(5);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = waiters.indexOf(go);
        if (i >= 0) waiters.splice(i, 1);
        reject(new SearchBusyError(5));
      }, 3000);
      const go = () => {
        clearTimeout(timer);
        resolve();
      };
      waiters.push(go);
    });
  }
  running += 1;
  try {
    return await withCustomPlans(fn);
  } finally {
    running -= 1;
    waiters.shift()?.();
  }
}

/** Search terms: whitespace separated, lower-cased, LIKE metacharacters escaped. */
export function searchTerms(q: string): string[] {
  return q
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((t) => t.replace(/[\\%_]/g, (m) => `\\${m}`));
}

/** Default search: subject, title or summary match (search_text), newest first. */
export function directMatchCondition(terms: string[]) {
  if (terms.length === 0) return sql``;
  return terms.reduce((acc, t) => sql`${acc} AND p.search_text LIKE ${"%" + t + "%"}`, sql``);
}

/**
 * FIX-BB-B — papers / prompts come from their own tables, NOT publications. They are
 * indexed into cross-axis candidates so /all?q=foo returns hits across tools, papers and
 * prompts. The SQL is a 2-arm query (papers + prompt_items) loaded separately and stitched
 * to the publications rows already produced by the run() function.
 *
 * Schema truth (verified against migrations 0039_papers.sql + 0042_prompts.sql):
 *   - papers: arxiv_id PK, title_en + title_zh, abstract_en + abstract_zh, primary_category,
 *     published_at, status. Translated title is "arXiv 论文" → site detail at /papers/:arxiv_id.
 *   - prompt_items: id bigserial PK, use_case, prompt_text, category, captured_at, article_id FK.
 *     The source URL is on `articles` (joined via article_id). Site detail at /prompts/:article_id.
 *
 * Why not asyncpool.combine into a single SQL UNION: the publications side hits pool_search
 * (GIN-trgm index + body fallback), while papers / prompt_items have no such index. A single
 * UNION across all three would force the planner to skip the GIN path. Keeping the queries
 * separate preserves the fast path for the 80% case.
 *
 * Why 2 * POOL_PAGE_SIZE cap: each cross-axis row replaces a tool row; the loader truncates
 * to POOL_PAGE_SIZE once it merges the three sources by time.
 */
async function loadCrossAxisCandidates(terms: string[], cap: number, db: Db): Promise<Array<{ crossAxis: "paper" | "prompt"; id: string; title: string; summary: string | null; published_at: Date | null; category: string | null; url: string | null }>> {
  if (terms.length === 0) return [];
  const likePatterns = terms.map((t) => `%${t}%`);
  try {
    // FIX-BB-BUG: alias `cross` is a reserved SQL keyword (CROSS JOIN) — Postgres parses
    // `) cross ORDER BY ...` as `) CROSS [JOIN] ... ORDER` and errors at ORDER. Renamed to
    // `ca` and added an explicit column list to keep the projection locked at the type level.
    const rows = await db<Array<{ crossAxis: "paper" | "prompt"; id: string; title: string; summary: string | null; published_at: Date | null; category: string | null; url: string | null }>>`
      SELECT ca."crossAxis", ca.id, ca.title, ca.summary, ca.published_at, ca.category, ca.url
        FROM (
          SELECT 'paper'::text AS "crossAxis",
                 papers.arxiv_id::text AS id,
                 coalesce(papers.title_zh, papers.title_en)::text AS title,
                 coalesce(papers.abstract_zh, papers.abstract_en)::text AS summary,
                 papers.published_at,
                 papers.primary_category AS category,
                 papers.abs_url AS url
            FROM papers
           WHERE papers.status IN ('fetched','translated','partial')
             AND (papers.title_en     ILIKE ANY(${likePatterns}::text[])
               OR papers.title_zh       ILIKE ANY(${likePatterns}::text[])
               OR papers.abstract_en    ILIKE ANY(${likePatterns}::text[])
               OR papers.abstract_zh    ILIKE ANY(${likePatterns}::text[]))
          UNION ALL
          SELECT 'prompt'::text AS "crossAxis",
                 -- FIX-BB-BUG-2: VPS smoke found all 44 prompt_items rows have article_id=''
                 -- (text col, empty), so the INNER JOIN on articles dropped every prompt hit.
                 -- Use pi.id (bigserial) as the row anchor when no article links, falling back
                 -- to the article_id text when one exists. Site detail reads /prompts/:id and
                 -- resolves to either a row id or article id; the detail page handles both.
                 coalesce(nullif(pi.article_id, ''), pi.id::text)::text AS id,
                 coalesce(pi.use_case, substring(pi.prompt_text, 1, 80))::text AS title,
                 pi.prompt_text::text AS summary,
                 pi.captured_at AS published_at,
                 pi.category::text AS category,
                 a.url AS url
            FROM prompt_items pi
            LEFT JOIN articles a ON a.id::text = pi.article_id
           WHERE (pi.use_case     ILIKE ANY(${likePatterns}::text[])
               OR pi.prompt_text   ILIKE ANY(${likePatterns}::text[]))
        ) ca
       ORDER BY ca.published_at DESC NULLS LAST
       LIMIT ${cap}`;
    return rows;
  } catch {
    // FIX-AA.4 lesson — defensive: any SQL throw on the cross-axis segment must NOT 500 the
    // whole /all page. Empty array means the user still sees the publications side.
    return [];
  }
}

/**
 * Project a cross-axis candidate into the FeedItemSummary shape DayList already renders.
 * We don't reuse toFeedItemSummary because papers / prompt_items rows lack the columns the
 * publication-side projection reads (channel, selected, score, x_post, searchMeta, story).
 * DayList reads crossAxis + id + title + summary + publishedAt; the rest falls back to
 * sensible empty defaults that mirror the original "empty pool row" guard.
 *
 * Exported for tests (apps/web/tests/pool-cross-axis.test.ts) so the projection is locked at
 * the contract level. The DB-free test pins the wire shape; the integration smoke against a
 * running API confirms the union actually returns hits.
 */
export function toCrossAxisFeedItem(c: { crossAxis: "paper" | "prompt"; id: string; title: string; summary: string | null; published_at: Date | null; category: string | null; url: string | null }): FeedItemSummary {
  const publishedAt = c.published_at ? c.published_at.toISOString() : null;
  return {
    id: c.id,
    title: c.title,
    summary: c.summary,
    reason: null,
    publishedAt,
    timelineAt: publishedAt ?? new Date(0).toISOString(),
    category: c.category && isCategoryKey(c.category) ? c.category : null,
    tags: [],
    score: null,
    selected: false,
    channel: "news",
    searchMeta: null,
    source: { name: c.crossAxis === "paper" ? "arXiv 论文" : "提示词", searchProvider: null },
    x: null,
    crossAxis: c.crossAxis,
  };
}

/**
 * The public APIs' q (v1 and MCP): every term matches the subject, title or summary, or
 * the start of a body whose full text may be shown, as the API documents it ("title / Chinese
 * title / Chinese summary / body"). Results stay in time order.
 */
export function publicMatchCondition(terms: string[]) {
  if (terms.length === 0) return sql``;
  // Keep the body lookup correlated to the time-ordered candidates. Without OFFSET 0, PostgreSQL
  // may hash every matching body in pool_search before serving even the first 40 recent items.
  return terms.reduce(
    (acc, t) => sql`${acc} AND (p.search_text LIKE ${"%" + t + "%"} OR EXISTS (
      SELECT 1 FROM pool_search ps WHERE ps.article_id = p.article_id AND ps.body LIKE ${"%" + t + "%"} OFFSET 0))`,
    sql``,
  );
}

/** Unfiltered-by-search totals only set the page count; they are reused for 30 seconds per filter. */
const countCache = new Map<string, { at: number; n: number }>();
const countPending = new Map<string, Promise<number>>();
async function poolCount(key: string | null, query: () => Promise<Array<{ n: number }>>): Promise<number> {
  if (key === null) return Number(one(await query()).n);
  const hit = countCache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.n;
  const pending = countPending.get(key);
  if (pending) return pending;
  const load = (async () => {
    const n = Number(one(await query()).n);
    if (countCache.size >= 200) countCache.delete(countCache.keys().next().value!);
    countCache.set(key, { at: Date.now(), n });
    return n;
  })();
  countPending.set(key, load);
  try { return await load; } finally { countPending.delete(key); }
}

export interface PoolQuery extends TimelineFilters {
  q?: string | null;
  tab?: "time" | "relevance";
  page?: number;
  topicTags?: string[] | null;
  now?: Date;
}

export async function loadPool(query: PoolQuery): Promise<PoolResponse> {
  const now = query.now ?? new Date();
  const page = Math.min(Math.max(query.page ?? 1, 1), POOL_MAX_PAGES);
  const q = query.q?.trim() || null;
  const tab = q && query.tab === "relevance" ? "relevance" : "time";
  const terms = q ? searchTerms(q) : [];
  const filters = sql`${channelCondition(query.channel)} ${categoryCondition(query.category)} ${tagCondition(query.tag)} ${topicCondition(query.topicTags)}`;
  const offset = (page - 1) * POOL_PAGE_SIZE;
  const cap = POOL_MAX_PAGES * POOL_PAGE_SIZE;
  // A fixed clock (tests, replays) never shares cached totals.
  const filterKey = query.now ? null : JSON.stringify([query.channel, query.category, query.tag, query.topicTags ?? null]);

  // Searches go through pool_search (eligible items only): trigram indexes for longer terms, a small
  // table to scan for one- and two-character ones.
  const like = (col: ReturnType<typeof sql>, t: string) => sql`${col} LIKE ${"%" + t + "%"}`;
  const run = async (db: Db) => {
    if (!q) {
      // Page ids from the timeline index first, then the joins for those rows only.
      const rows = await db<ItemRow[]>`
        WITH page AS (
          SELECT p.article_id FROM publications p WHERE ${listedCondition(now)} AND p.eligible ${filters}
          ORDER BY p.timeline_at DESC, p.article_id DESC LIMIT ${POOL_PAGE_SIZE} OFFSET ${offset})
        SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE p.article_id IN (SELECT article_id FROM page)
        ORDER BY p.timeline_at DESC, p.article_id DESC`;
      return {
        rows,
        total: await poolCount(filterKey, () => db<{ n: number }[]>`
        SELECT count(*) AS n FROM (SELECT 1 FROM publications p WHERE ${listedCondition(now)} AND p.eligible ${filters} LIMIT ${cap}) t`),
        crossRows: [] as Array<Awaited<ReturnType<typeof loadCrossAxisCandidates>>[number]>,
      };
    }
    if (tab === "relevance") {
      // Rank narrow rows first: no article bodies or translations enter the sort/count. The public
      // total stops at 2,000, even though ranking must consider every matching item.
      // For an unfiltered trigram search, match each indexed field separately. OR across fields
      // can make PostgreSQL scan every toasted body instead. Keep other searches inline so short
      // terms, additional terms and selective publication filters retain their existing plans.
      const splitFields = terms.length === 1 && /[\p{L}\p{N}]{3}/u.test(terms[0]!)
        && (!query.channel || query.channel === "all") && !query.category && !query.tag && !query.topicTags?.length;
      const partScore = terms.reduce(
        (acc, t) => sql`${acc} + (CASE WHEN ${like(sql`ps.direct`, t)} THEN 3 ELSE 0 END) + (CASE WHEN ${like(sql`ps.body`, t)} THEN 1 ELSE 0 END)`,
        sql`0`,
      );
      const titleScore = terms.reduce((acc, t) => sql`${acc} + (CASE WHEN ${like(sql`lower(p.title)`, t)} THEN 6 ELSE 0 END)`, sql`0`);
      const anyMatch = terms.reduce((acc, t) => sql`${acc} AND (${like(sql`ps.direct`, t)} OR ${like(sql`ps.body`, t)})`, sql`TRUE`);
      const matches = splitFields ? sql`
        SELECT coalesce(d.article_id, b.article_id) AS article_id,
          (CASE WHEN d.article_id IS NOT NULL THEN 3 ELSE 0 END) + (CASE WHEN b.article_id IS NOT NULL THEN 1 ELSE 0 END) AS part
        FROM (SELECT article_id FROM pool_search WHERE direct LIKE ${"%" + terms[0]! + "%"}) d
        FULL JOIN (SELECT article_id FROM pool_search WHERE body LIKE ${"%" + terms[0]! + "%"}) b ON b.article_id = d.article_id`
        : sql`SELECT ps.article_id, (${partScore}) AS part FROM pool_search ps WHERE ${anyMatch}`;
      type RankedRow = Omit<ItemRow, "id"> & { id: string | null; rel: number; total: number };
      const result = await db<RankedRow[]>`
        WITH matches AS ${splitFields ? sql`MATERIALIZED` : sql`NOT MATERIALIZED`} (${matches}), scored AS MATERIALIZED (
          SELECT p.article_id, p.timeline_at, matches.part + (${titleScore}) AS rel
          FROM matches JOIN publications p ON p.article_id = matches.article_id JOIN sources s ON s.id = p.source_id
          WHERE ${listedCondition(now)} AND p.eligible ${filters}
        ), page AS MATERIALIZED (
          SELECT article_id, rel FROM scored ORDER BY rel DESC, timeline_at DESC, article_id DESC
          LIMIT ${POOL_PAGE_SIZE} OFFSET ${offset}
        ), total AS (SELECT count(*) AS n FROM (SELECT 1 FROM scored LIMIT ${cap}) capped)
        SELECT hydrated.*, total.n AS total FROM total LEFT JOIN LATERAL (
          SELECT ${ITEM_COLUMNS}, page.rel ${ITEM_FROM} JOIN page ON page.article_id = p.article_id
        ) hydrated ON true ORDER BY hydrated.rel DESC, hydrated.timeline_at DESC, hydrated.id DESC`;
      const rows = result.filter((r): r is ItemRow & { rel: number; total: number } => r.id !== null);
      // FIX-BB-B — relevance tab still surfaces papers / prompt_items under the same q. We cap
      // at 2 * POOL_PAGE_SIZE so a papers-rich query doesn't get dominated by tools at the
      // top, then truncate to POOL_PAGE_SIZE in the merge below.
      const crossRows = await loadCrossAxisCandidates(terms, 2 * POOL_PAGE_SIZE, db);
      return { rows, total: Number(result[0]!.total), crossRows };
    }
    // Default search: newest first straight from the timeline index; the total from the pool's
    // search rows, where one- and two-character terms scan a small table instead of every item.
    const rows = await db<ItemRow[]>`
      WITH page AS (
        SELECT p.article_id FROM publications p WHERE ${listedCondition(now)} AND p.eligible ${filters} ${directMatchCondition(terms)}
        ORDER BY p.timeline_at DESC, p.article_id DESC LIMIT ${POOL_PAGE_SIZE} OFFSET ${offset})
      SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE p.article_id IN (SELECT article_id FROM page)
      ORDER BY p.timeline_at DESC, p.article_id DESC`;
    const direct = terms.reduce((acc, t) => sql`${acc} AND ${like(sql`ps.direct`, t)}`, sql``);
    const { n } = one(await db<{ n: number }[]>`
      SELECT count(*) AS n FROM (SELECT 1 FROM pool_search ps JOIN publications p ON p.article_id = ps.article_id
        WHERE ${listedCondition(now)} AND p.eligible ${filters} ${direct} LIMIT ${cap}) t`);
    // FIX-BB-B — see relevance branch; cross-axis rows ride on the same timelineAt DESC key.
    const crossRows = await loadCrossAxisCandidates(terms, 2 * POOL_PAGE_SIZE, db);
    return { rows, total: Number(n), crossRows };
  };

  const { rows, total, crossRows } = q ? await withSearchCapacity(run) : await run(sql);
  const today = beijingDate(now);
  const meta = one(await sql<{ today_count: number; updated_at: Date | null }[]>`
    SELECT (SELECT count(*) FROM publications p
      WHERE ${listedCondition(now)} AND p.eligible AND p.timeline_at >= ${beijingMidnight(today)} ${filters}) AS today_count,
      (SELECT max(p.updated_at) FROM publications p WHERE p.eligible) AS updated_at`);

  // FIX-BB-B — when q is present, splice cross-axis candidates into the publication rows.
  //   - Empty q: keep the legacy path untouched (crossRows === []).
  //   - Merge key: timelineAt DESC (both sides share ISO strings after the projection above).
  //   - Truncate to POOL_PAGE_SIZE — preserves the existing page navigator without changes.
  //   - total = publications + cross-axis candidates; the UI already caps at 2000+.
  const pubItems = rows.map(toFeedItemSummary);
  let items: FeedItemSummary[];
  let mergedTotal: number;
  if (q && crossRows.length > 0) {
    const crossItems = crossRows.map(toCrossAxisFeedItem);
    const merged = [...pubItems, ...crossItems];
    merged.sort((a, b) => (b.timelineAt > a.timelineAt ? 1 : b.timelineAt < a.timelineAt ? -1 : b.id > a.id ? -1 : b.id < a.id ? 1 : 0));
    items = merged.slice(0, POOL_PAGE_SIZE);
    mergedTotal = total + crossRows.length;
  } else {
    items = pubItems;
    mergedTotal = total;
  }

  return {
    filters: { channel: query.channel, category: query.category, tag: query.tag, topic: query.topic ?? null, q, tab },
    items,
    page,
    pageCount: Math.min(POOL_MAX_PAGES, Math.max(1, Math.ceil(mergedTotal / POOL_PAGE_SIZE))),
    total: mergedTotal,
    todayCount: Number(meta.today_count),
    freshness: (meta.updated_at ?? now).toISOString(),
    generatedAt: now.toISOString(),
  };
}
