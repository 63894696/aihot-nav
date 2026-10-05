// search-fetch — the W5-2 orchestrator. Reads industry/search-queries.json, fans out across three
// providers (SearXNG round-robin, HN Algolia, GitHub Trending), dedupes by identityKeyForUrl, and
// sends each candidate through the LLM score gate (≥70). Passing candidates are written to
// `articles` via upsertMaterial — they enter `publications` because the score gate already
// filtered them, no editorial re-score needed.
//
// Why this lives outside the standard collectSource flow:
// - collectSource runs one fetcher per source kind; the search-engine virtual source has three
//   parallel fetchers per query list, and the score gate is the only signal of "live".
// - We persist `sourceId='search-api-virtual'` so the article is attributable, the FK passes,
//   and the admin UI can show which candidates came from search engines.
//
// Safety / cost controls:
// - queries are static (12 MVP); a single run fans out to 36 fetches (12 × 3).
// - scoreSearch returns null on a model outage and we skip rather than retry (matches
//   arxiv-translate.ts:95-98).
// - dedupe runs on identityKeyForUrl, so a URL seen via SearXNG and HN Algolia still costs one
//   score call (the dedupe happens before the gate, not after).
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@aihot/backend/config";
import { sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { identityKeyForUrl } from "@aihot/backend/lib/url";
import { scoreSearch, SEARCH_SCORE_THRESHOLD } from "@aihot/backend/publication/search-score";
import type { Candidate, SourceRow } from "@aihot/backend/sources/types";
import { fetchSearxng, type SearxngCursor } from "@aihot/backend/sources/searxng";
import { fetchHnAlgolia } from "@aihot/backend/sources/hn-algolia";
import { fetchGithubTrending } from "@aihot/backend/sources/github-trending";
import { fetchTavily } from "@aihot/backend/sources/tavily";

const SOURCE_ID = "search-api-virtual";
const CYCLE_CONCURRENCY = 6;

interface QueryFile {
  version: string;
  queries: Array<{ id: string; q: string; lang?: string; category?: string }>;
}

/** Tavily cycle gate: only invoke Tavily every TAVILY_CYCLE_EVERY cycles. With 24 cycles/day
 *  and TAVILY_CYCLE_EVERY=8, that is 3 cycles/day × ≤5 zh queries = ≤15 calls/day = ~450/month,
 *  comfortably below the 1000/month free tier. The counter persists in sources.cursor.tavilyCycleN
 *  so it survives worker restarts. */
const TAVILY_CYCLE_EVERY = 8;

interface RunResult {
  queries: number;
  fetched: number;
  deduped: number;
  scored: number;
  passed: number;
  skipped_model: number;
  upserted: number;
  providers: Record<string, number>;
}

export interface SearchFetchOpts {
  /** Per-query timeout for one provider fetch; default 12 s. */
  perFetchMs?: number;
  /** Soft overall cap; the orchestrator stops queueing new fetches past this. */
  budgetMs?: number;
  /** Limit on scored candidates per cycle (the gate, not the fetch). */
  maxScored?: number;
}

export async function fetchSearchQueries(opts: SearchFetchOpts = {}): Promise<RunResult> {
  const perFetchMs = opts.perFetchMs ?? 12_000;
  const budgetMs = opts.budgetMs ?? 4 * 60_000;
  const maxScored = opts.maxScored ?? 200;
  const deadline = Date.now() + budgetMs;

  const src = await loadVirtualSource();
  if (!src) {
    return { queries: 0, fetched: 0, deduped: 0, scored: 0, passed: 0, skipped_model: 0, upserted: 0, providers: {} };
  }
  if (!src.enabled) {
    return { queries: 0, fetched: 0, deduped: 0, scored: 0, passed: 0, skipped_model: 0, upserted: 0, providers: {} };
  }

  const queries = loadQueries("search");
  const cursorObj = (src.cursor as { searxng?: SearxngCursor; tavilyCycleN?: number } | null) ?? null;
  const cursor = cursorObj?.searxng ?? null;
  let nextSearxngCursor: SearxngCursor = cursor ?? { cursor: 0, recentlyFailed: [] };
  // Tavily cycle gate: bump the counter at the start of each run, only fire on cycles where
  // (cycleN % TAVILY_CYCLE_EVERY === 0). The first cycle (cycleN===0) is a normal run.
  const tavilyCycleN = (cursorObj?.tavilyCycleN ?? -1) + 1;
  const tavilyEnabled = (tavilyCycleN % TAVILY_CYCLE_EVERY) === 0;

  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  const providers: Record<string, number> = { searxng: 0, hn_algolia: 0, github_trending: 0, tavily: 0 };
  let fetched = 0;

  for (const q of queries) {
    if (Date.now() > deadline) break;
    const tasks: Promise<unknown>[] = [
      withTimeout(fetchSearxng(q, nextSearxngCursor), perFetchMs, `searxng:${q.id}`),
      withTimeout(fetchHnAlgolia(q), perFetchMs, `hn:${q.id}`),
      withTimeout(fetchGithubTrending(q), perFetchMs, `gh:${q.id}`),
    ];
    // Tavily arm: only when the query is lang:zh AND the cycle gate is open. en queries never
    // hit Tavily, which keeps the free-tier spend bounded.
    if (q.lang === "zh" && tavilyEnabled) {
      tasks.push(withTimeout(fetchTavily(q), perFetchMs, `tavily:${q.id}`));
    }
    const settled = await Promise.allSettled(tasks);
    const searxngRes = settled[0] as PromiseSettledResult<Awaited<ReturnType<typeof fetchSearxng>>>;
    const hnRes = settled[1] as PromiseSettledResult<Awaited<ReturnType<typeof fetchHnAlgolia>>>;
    const ghRes = settled[2] as PromiseSettledResult<Awaited<ReturnType<typeof fetchGithubTrending>>>;
    const tavilyRes = tasks.length === 4
      ? (settled[3] as PromiseSettledResult<Awaited<ReturnType<typeof fetchTavily>>>)
      : null;
    // SearXNG keeps its cursor across calls even on a per-query failure so a single dead
    // instance does not pin the worker to its neighbours for the rest of the run.
    if (searxngRes.status === "fulfilled") {
      nextSearxngCursor = searxngRes.value.cursor;
      providers.searxng += searxngRes.value.candidates.length;
      fetched += searxngRes.value.candidates.length;
      mergeDeduped(searxngRes.value.candidates, seen, candidates);
    }
    if (hnRes.status === "fulfilled") {
      providers.hn_algolia += hnRes.value.candidates.length;
      fetched += hnRes.value.candidates.length;
      mergeDeduped(hnRes.value.candidates, seen, candidates);
    }
    if (ghRes.status === "fulfilled") {
      providers.github_trending += ghRes.value.candidates.length;
      fetched += ghRes.value.candidates.length;
      mergeDeduped(ghRes.value.candidates, seen, candidates);
    }
    if (tavilyRes && tavilyRes.status === "fulfilled" && !tavilyRes.value.skippedNoKey) {
      providers.tavily += tavilyRes.value.candidates.length;
      fetched += tavilyRes.value.candidates.length;
      mergeDeduped(tavilyRes.value.candidates, seen, candidates);
    }
  }
  const deduped = candidates.length;

  // Score gate. concurrency bounded so a long score queue does not burst the model at once.
  let scored = 0;
  let passed = 0;
  let skippedModel = 0;
  let upserted = 0;
  for (let i = 0; i < candidates.length && scored < maxScored; i += CYCLE_CONCURRENCY) {
    if (Date.now() > deadline) break;
    const batch = candidates.slice(i, i + CYCLE_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (c) => {
        const r = await scoreSearch(c).catch((err): { passed: false; score: null; reason: string } => ({
          passed: false, score: null, reason: `score threw: ${(err as Error).message.slice(0, 120)}`,
        }));
        return { c, r };
      }),
    );
    for (const { c, r } of results) {
      scored += 1;
      if (r.score === null && !r.passed) {
        // Safety valve: model is disabled / unconfigured / budget. Skip the candidate rather
        // than retry; the next cycle will get another chance.
        skippedModel += 1;
        continue;
      }
      if (!r.passed) continue;
      passed += 1;
      // Score gate has already filtered; the article enters publications. We carry the provider
      // metadata forward via `raw` so the admin can see which provider surfaced the candidate.
      // upsertMaterial expects `via`; we keep `searchMeta` (which the score gate already read)
      // out of the persisted row by overriding the MaterialInput via field with the orchestrator's
      // own channel: "fetch".
      const material = {
        ...c,
        sourceId: SOURCE_ID,
        via: "fetch" as const,
        bodyText: c.bodyText ?? null,
        bodyHtml: c.bodyHtml ?? null,
        bodyStatus: c.bodyStatus ?? "pending",
        raw: c.searchMeta ?? c.raw,
      };
      try {
        await upsertMaterial(material);
        upserted += 1;
      } catch (err) {
        // One bad URL shouldn't stop the whole batch.
        if (process.env.NODE_ENV !== "test") console.error("[search-fetch] upsert failed:", (err as Error).message.slice(0, 200));
      }
    }
  }

  await persistCursor(src.id, nextSearxngCursor, tavilyCycleN);
  return { queries: queries.length, fetched, deduped, scored, passed, skipped_model: skippedModel, upserted, providers };
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
  // The query file carries two parallel sets: search-* (articles, this orchestrator) and
  // prompt-* (prompts, prompt-fetch.ts). Each consumer scopes its own set by id prefix so the
  // two pipelines never accidentally feed each other.
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

async function persistCursor(sourceId: string, searxngCursor: SearxngCursor, tavilyCycleN: number): Promise<void> {
  await sql`UPDATE sources SET cursor = ${sql.json({ searxng: searxngCursor, tavilyCycleN } as never)}, last_ok_at = COALESCE(last_ok_at, now()) WHERE id = ${sourceId}`;
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

// Re-export so the admin / test code can see the threshold without importing two modules.
export { SEARCH_SCORE_THRESHOLD };
