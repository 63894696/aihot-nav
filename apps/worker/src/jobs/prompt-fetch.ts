// prompt-fetch — W5-3 v0.2.1-#7 orchestrator for the prompts column. Reads the prompt-* queries
// from industry/search-queries.json, fans out across the same SearXNG instances used by
// search-fetch (no HN Algolia / GitHub Trending — those providers don't surface reusable prompt
// content well, see the inline doc on industry/search-queries.json prompt-* entries), dedupes by
// identityKeyForUrl, and runs the LLM prompt-score gate (extracts {promptText, useCase,
// category}). Passing candidates are written to prompt_items with source_kind='searxng_search'.
// They are NOT linked to articles and skip the editorial pipeline — the prompt-score gate already
// filtered for "is there a real reusable prompt here?", and the published column is read by
// packages/backend/src/publication/prompts.ts which gates by PROMPT_CATEGORIES.
//
// Why this lives outside the standard collectSource flow:
// - collectSource runs one fetcher per source kind; the search-engine virtual source has a
//   parallel fetcher per query list, and the score gate is the only signal of "live".
// - We persist the virtual source row 'prompts-api-virtual' (database/migrations/0044_prompts_api_source.sql)
//   so the worker has an identity for cursor + ops visibility (admin can see the source even
//   though no FK joins it to prompt_items — the prompt_items row carries source_kind text
//   instead, because a single prompt can come from multiple sources over time).
//
// Safety / cost controls:
// - queries are static (10 MVP: 5 categories × en/zh); a single run fans out to 10 fetches.
// - scorePrompt returns {extracted:false} on a model outage and we skip rather than retry (same
//   contract as scoreSearch).
// - dedupe runs on identityKeyForUrl BEFORE the gate, so a URL seen twice (SearXNG round-robin
//   hit the same instance twice) costs one score call.
// - ON CONFLICT (original_url) DO NOTHING means a re-run is idempotent — no upsert churn.
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@aihot/backend/config";
import { sql } from "@aihot/backend/db";
import { identityKeyForUrl } from "@aihot/backend/lib/url";
import { scorePrompt } from "@aihot/backend/publication/prompt-score";
import type { Candidate, SourceRow } from "@aihot/backend/sources/types";
import { fetchSearxng, type SearxngCursor } from "@aihot/backend/sources/searxng";

const SOURCE_ID = "prompts-api-virtual";
const SOURCE_KIND = "searxng_search";
const CYCLE_CONCURRENCY = 6;

interface QueryFile {
  version: string;
  queries: Array<{ id: string; q: string; lang?: string; category?: string }>;
}

interface RunResult {
  queries: number;
  fetched: number;
  deduped: number;
  scored: number;
  extracted: number;
  skipped_model: number;
  inserted: number;
  duplicates: number;
}

export interface PromptFetchOpts {
  /** Per-query timeout for one provider fetch; default 12 s. */
  perFetchMs?: number;
  /** Soft overall cap; the orchestrator stops queueing new fetches past this. */
  budgetMs?: number;
  /** Limit on scored candidates per cycle (the gate, not the fetch). */
  maxScored?: number;
}

export async function fetchPromptQueries(opts: PromptFetchOpts = {}): Promise<RunResult> {
  const perFetchMs = opts.perFetchMs ?? 12_000;
  const budgetMs = opts.budgetMs ?? 4 * 60_000;
  const maxScored = opts.maxScored ?? 200;
  const deadline = Date.now() + budgetMs;

  const src = await loadVirtualSource();
  if (!src) {
    return { queries: 0, fetched: 0, deduped: 0, scored: 0, extracted: 0, skipped_model: 0, inserted: 0, duplicates: 0 };
  }
  if (!src.enabled) {
    return { queries: 0, fetched: 0, deduped: 0, scored: 0, extracted: 0, skipped_model: 0, inserted: 0, duplicates: 0 };
  }

  const queries = loadQueries("prompt");
  const cursor = (src.cursor as { searxng?: SearxngCursor } | null)?.searxng ?? null;
  let nextSearxngCursor: SearxngCursor = cursor ?? { cursor: 0, recentlyFailed: [] };

  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  let fetched = 0;

  for (const q of queries) {
    if (Date.now() > deadline) break;
    const res = await Promise.allSettled([
      withTimeout(fetchSearxng(q, nextSearxngCursor), perFetchMs, `searxng:${q.id}`),
    ]);
    if (res[0].status === "fulfilled") {
      nextSearxngCursor = res[0].value.cursor;
      fetched += res[0].value.candidates.length;
      mergeDeduped(res[0].value.candidates, seen, candidates);
    }
  }
  const deduped = candidates.length;

  // Extract gate. concurrency bounded so a long queue does not burst the model at once. scorePrompt
  // returns {extracted, result, reason} and never throws for a model outage (the safety valve).
  let scored = 0;
  let extracted = 0;
  let skippedModel = 0;
  let inserted = 0;
  let duplicates = 0;
  for (let i = 0; i < candidates.length && scored < maxScored; i += CYCLE_CONCURRENCY) {
    if (Date.now() > deadline) break;
    const batch = candidates.slice(i, i + CYCLE_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (c) => {
        const r = await scorePrompt(c).catch((err): { extracted: false; result: null; reason: string } => ({
          extracted: false, result: null, reason: `score threw: ${(err as Error).message.slice(0, 120)}`,
        }));
        return { c, r };
      }),
    );
    for (const { c, r } of results) {
      scored += 1;
      if (!r.extracted) {
        skippedModel += 1;
        continue;
      }
      extracted += 1;
      const meta = c.searchMeta;
      const community = communityFromProvider(meta?.provider, c.url);
      const language = languageFromUrl(c.url, meta?.queryLang ?? null);
      try {
        const inserted_row = await insertPromptItem({
          article_id: null,
          original_url: c.url,
          original_post_id: meta?.refId ?? null,
          community,
          category: r.result!.category,
          prompt_text: r.result!.promptText,
          use_case: r.result!.useCase,
          language,
          source_kind: SOURCE_KIND,
        });
        if (inserted_row) inserted += 1;
        else duplicates += 1;
      } catch (err) {
        if (process.env.NODE_ENV !== "test") console.error("[prompt-fetch] insert failed:", (err as Error).message.slice(0, 200));
      }
    }
  }

  await persistCursor(src.id, nextSearxngCursor);
  return { queries: queries.length, fetched, deduped, scored, extracted, skipped_model: skippedModel, inserted, duplicates };
}

async function loadVirtualSource(): Promise<SourceRow | null> {
  const [row] = await sql<SourceRow[]>`
    SELECT id, name, kind, config, tier, participation_mode, first_party, interval_minutes, enabled, cursor, fail_count
    FROM sources WHERE id = ${SOURCE_ID}`;
  return row ?? null;
}

function loadQueries(prefix: "search" | "prompt"): QueryFile["queries"] {
  const file = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/search-queries.json"), "utf8")) as QueryFile;
  if (!Array.isArray(file.queries)) return [];
  return file.queries.filter((q) => typeof q.id === "string" && q.id.startsWith(`${prefix}-`));
}

function mergeDeduped(batch: Candidate[], seen: Set<string>, out: Candidate[]): void {
  for (const c of batch) {
    const id = c.identityKey ?? identityKeyForUrl(c.url);
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ ...c, identityKey: id });
  }
}

interface InsertRow {
  article_id: string | null;
  original_url: string;
  original_post_id: string | null;
  community: string;
  category: string;
  prompt_text: string;
  use_case: string | null;
  language: string;
  source_kind: string;
}

/**
 * Insert a prompt_items row. Returns true on insert, false when the original_url already exists
 * (ON CONFLICT DO NOTHING). The query is parameterized end-to-end; no string concatenation.
 */
async function insertPromptItem(row: InsertRow): Promise<boolean> {
  const res = await sql<{ id: string }[]>`
    INSERT INTO prompt_items (article_id, original_url, original_post_id, community, category,
                              prompt_text, use_case, language, source_kind, captured_at, updated_at)
    VALUES (${row.article_id}, ${row.original_url}, ${row.original_post_id}, ${row.community},
            ${row.category}, ${row.prompt_text}, ${row.use_case}, ${row.language}, ${row.source_kind},
            now(), now())
    ON CONFLICT (original_url) DO NOTHING
    RETURNING id
  `;
  return res.length > 0;
}

function communityFromProvider(provider: string | undefined, url: string): string {
  // SearXNG aggregates many engines; we surface the host's registered name as the community
  // signal so a Reddit link reads "reddit.com", a flowgpt link reads "flowgpt.com", etc. This is
  // a coarse heuristic — once we have a curated sources list (#9 in the v0.2.1 series), this
  // gets refined to use the source's label. Until then, host-root is honest and stable.
  if (!provider) return "searxng";
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "searxng";
  }
}

function languageFromUrl(url: string, queryLang: string | null): string {
  if (queryLang === "zh" || queryLang === "en") return queryLang;
  try {
    const host = new URL(url).host.toLowerCase();
    if (host.endsWith(".cn") || host === "zhuanlan.zhihu.com" || host === "juejin.cn") return "zh";
  } catch {
    // fall through
  }
  return "en";
}

async function persistCursor(sourceId: string, cursor: SearxngCursor): Promise<void> {
  await sql`UPDATE sources SET cursor = ${sql.json({ searxng: cursor } as never)}, last_ok_at = COALESCE(last_ok_at, now()) WHERE id = ${sourceId}`;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
