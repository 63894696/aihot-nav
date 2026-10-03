// SearXNG community instances — round-robin across 10 public instances.
//
// Why this file:
// - W5-2 zero-budget search engine query API source. The public SearXNG JSON endpoint at
//   /search?q=&format=json returns mixed-source AI/tech results without an API key.
// - Each instance may rate-limit, return 503, or be down. We try the next instance on the first
//   failure and keep the round-robin cursor in source.cursor so a single bad instance doesn't
//   pin a worker to its neighbours.
//
// Output shape:
// - `fetchSearxng` returns candidates for ONE query (the orchestrator iterates queries).
// - Each candidate's url points at the result page (so its identity stays stable across re-fetches).
// - The caller (`search-fetch.ts`) sends candidates through the LLM score gate before they enter
//   `articles`. We deliberately do not score here so the same instance failure surface is shared
//   across the three providers.

import { guardedFetch, DEFAULT_UA } from "../lib/http-fetch.ts";
import { identityKeyForUrl } from "../lib/url.ts";
import { stripTags, collapseWhitespace } from "../lib/text.ts";
import type { Candidate } from "./types.ts";

/**
 * Public SearXNG community instances. Order matters only when a cursor exists: the first call
 * picks the cursor position, subsequent calls pick the next instance. When all instances fail the
 * caller retries at the next schedule slot; we don't escalate to admin (these instances are best-
 * effort).
 */
export const SEARXNG_INSTANCES: string[] = [
  "https://searx.be/search",
  "https://search.brave.com/search",  // Brave Search (public, JSON-ish)
  "https://searx.tiekoetter.com/search",
  "https://search.disroot.org/search",
  "https://searx.work/search",
  "https://searx.ninja/search",
  "https://priv.au/search",
  "https://paulgo.io/search",
  "https://searx.prvcy.eu/search",
  "https://search.sapti.me/search",
];

const QUERY_TIMEOUT_MS = 8_000;
const PER_INSTANCE_SKIP_AFTER_MS = 200; // skip an instance whose first byte doesn't arrive within this

interface SearxngCursor {
  /** Index into SEARXNG_INSTANCES for the next attempt. */
  cursor: number;
  /** Instance indices known to have failed recently. Cleared at the start of every fetch window. */
  recentlyFailed: number[];
}

export type { SearxngCursor };

export interface SearxngFetchResult {
  candidates: Candidate[];
  /** Updated cursor for storage in sources.cursor. */
  cursor: SearxngCursor;
  /** True when every instance failed for this query; the caller may back off and try again later. */
  exhausted: boolean;
}

interface SearxngResult {
  url: string;
  title?: string;
  content?: string;
  engine?: string;
  publishedDate?: string | null;
}

/**
 * Run one query against the round-robin of SearXNG instances. Returns up to ~25 candidates.
 *
 * The JSON shape returned by SearXNG is `{ results: [{url, title, content, engine, ...}] }`. Some
 * instances return RSS feeds or HTML; we ask for `format=json` and trust the contract.
 */
export async function fetchSearxng(query: { id: string; q: string; lang?: string; category?: string }, prev: SearxngCursor | null): Promise<SearxngFetchResult> {
  const cursor: SearxngCursor = prev ?? { cursor: 0, recentlyFailed: [] };
  const instances = SEARXNG_INSTANCES;
  const total = instances.length;

  for (let attempt = 0; attempt < total; attempt++) {
    const idx = (cursor.cursor + attempt) % total;
    const base = instances[idx]!;
    try {
      const candidates = await oneInstance(base, query);
      // Success: advance the cursor so the next query starts a few instances ahead (load spread).
      return { candidates, cursor: { cursor: (idx + 1) % total, recentlyFailed: [] }, exhausted: false };
    } catch (err) {
      // Record the failure but try the next instance. On all-fail we return exhausted=true so the
      // caller can skip rather than retrying hot.
      cursor.recentlyFailed.push(idx);
      if (attempt === total - 1) {
        return { candidates: [], cursor: { cursor: 0, recentlyFailed: cursor.recentlyFailed }, exhausted: true };
      }
    }
  }
  // Unreachable: the loop returns or falls through with attempt === total - 1.
  return { candidates: [], cursor: { cursor: 0, recentlyFailed: cursor.recentlyFailed }, exhausted: true };
}

async function oneInstance(base: string, query: { id: string; q: string; lang?: string; category?: string }): Promise<Candidate[]> {
  // SearXNG supports `format=json` plus category filters; we don't bind to a category here because
  // it's instance-specific and many instances ignore it.
  const url = `${base}?q=${encodeURIComponent(query.q)}&format=json&language=${encodeURIComponent(query.lang ?? "en")}`;
  const res = await guardedFetch(url, {
    timeoutMs: QUERY_TIMEOUT_MS,
    headers: { accept: "application/json", "user-agent": DEFAULT_UA },
    maxBytes: 2 * 1024 * 1024,
  });
  if (res.status === 429 || res.status === 503) throw new Error(`SearXNG ${base} returned ${res.status}`);
  if (res.status !== 200) throw new Error(`SearXNG ${base} returned ${res.status}`);
  let json: { results?: SearxngResult[] } | null;
  try {
    json = JSON.parse(res.text());
  } catch (e) {
    throw new Error(`SearXNG ${base} returned non-JSON: ${String(e).slice(0, 80)}`);
  }
  const results = json?.results ?? [];
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (!r.url) continue;
    if (!/^https?:\/\//i.test(r.url)) continue;
    const id = identityKeyForUrl(r.url);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const title = collapseWhitespace(stripTags(r.title ?? "")).slice(0, 300) || null;
    if (!title) continue;
    const summary = collapseWhitespace(stripTags(r.content ?? "")).slice(0, 2000) || null;
    out.push({
      url: r.url,
      ...(id.startsWith("url:") ? {} : { identityKey: id }),
      title,
      excerpt: summary,
      author: null,
      publishedAt: parseSearxngDate(r.publishedDate ?? null),
      categories: query.category ? [query.category] : [],
      // via is set by the orchestrator (search-fetch.ts) on upsert — not here. We carry the
      // provider/queryId in a side channel below so scoreSearch can attribute the score.
      searchMeta: { provider: "searxng", queryId: query.id, queryText: query.q, queryLang: query.lang ?? null, queryCategory: query.category ?? null },
    });
    if (out.length >= 25) break;
  }
  return out;
}

function parseSearxngDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t) : null;
}
