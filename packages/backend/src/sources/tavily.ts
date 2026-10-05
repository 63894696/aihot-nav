// Tavily search engine — paid 4th engine, gated to zh-only queries.
//
// Why this file:
// - FIX-R: zh queries currently only hit SearXNG (which has weak Chinese coverage in public
//   instances) + HN Algolia / GitHub Trending (English-first, often 0 results for lang:zh).
//   Tavily is the only consumer-grade search API with a usable free tier (~1000 calls/month)
//   and reasonable Chinese results.
// - Every call goes through `paidRequest` (same path as Jina/SocialData) so each request writes
//   a receipts row and the budgets.per_minute/per_hour/per_day caps apply. Service name is
//   `tavily`; caps are set by migration 0046_tavily_search_engine.sql.
//
// Cost / cycle controls (set by the caller, not here):
// - This file does NOT throttle. search-fetch.ts and prompt-fetch.ts only invoke fetchTavily
//   for queries with `lang === "zh"` so the call surface is small. The orchestrator also
//   persists a cycle counter so it can skip Tavily on off-cycles when the free tier is tight.
//
// Output shape:
// - Same as HN Algolia / SearXNG: Candidate[] with searchMeta.provider="tavily". refId carries
//   the Tavily URL so the article's via line is traceable.

import { credential } from "../config.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { identityKeyForUrl } from "../lib/url.ts";
import { stripTags, collapseWhitespace } from "../lib/text.ts";
import { paidRequest, ProviderRejectedError } from "../providers/receipts.ts";
import type { Candidate } from "./types.ts";

const QUERY_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESULTS = 8;

/** Tavily request body — `search_depth=basic` is the cheapest depth and enough for headlines. */
interface TavilyRequestBody {
  query: string;
  max_results?: number;
  include_raw_content?: boolean;
  topic?: "general" | "news";
  search_depth?: "basic" | "advanced";
}

interface TavilyResult {
  url?: string;
  title?: string;
  content?: string;
  raw_content?: string;
  score?: number;
  published_date?: string | null;
}

interface TavilyResponse {
  results?: TavilyResult[];
  answer?: string;
}

interface TavilyReceiptResponse {
  results: TavilyResult[];
  latencyMs: number;
}

export interface TavilyFetchResult {
  candidates: Candidate[];
  /** True when TAVILY_API_KEY is absent; the caller should skip silently without burning a cycle. */
  skippedNoKey?: boolean;
  /** True on every-failure (retryable); the caller may retry next cycle. */
  exhausted?: boolean;
}

/**
 * Run one zh query through Tavily. Returns the candidates, plus a soft-skip signal when the API
 * key is absent (the worker treats that as "not configured" rather than "failed").
 *
 * Identity: Tavily URLs are passed through identityKeyForUrl, same as the other engines, so
 * dedupe across SearXNG/HN/GH/Tavily still works.
 */
export async function fetchTavily(
  query: { id: string; q: string; lang?: string; category?: string },
): Promise<TavilyFetchResult> {
  const apiKey = credential("collectors", "TAVILY_API_KEY");
  if (!apiKey) {
    // No-key is NOT a paid-request failure: returning skippedNoKey lets the caller drop the
    // attempt cleanly. We deliberately do NOT go through paidRequest here because there is no
    // point charging a request we cannot make.
    return { candidates: [], skippedNoKey: true };
  }
  const base = (credential("collectors", "TAVILY_BASE_URL") ?? "https://api.tavily.com").replace(/\/$/, "");

  const reqBody: TavilyRequestBody = {
    query: query.q,
    max_results: DEFAULT_MAX_RESULTS,
    include_raw_content: false,
    topic: "news",
    search_depth: "basic",
  };

  let receipt;
  try {
    receipt = await paidRequest(
      {
        service: "tavily",
        model: null,
        purpose: "search.zh",
        subject: `q:${query.id}`,
        identity: { queryId: query.id, queryLang: query.lang ?? null, queryCategory: query.category ?? null },
        requestSummary: { queryId: query.id, queryChars: query.q.length, maxResults: DEFAULT_MAX_RESULTS },
      },
      async () => {
        const started = Date.now();
        const res = await guardedFetch(`${base}/search`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(reqBody),
          timeoutMs: QUERY_TIMEOUT_MS,
          maxBytes: 2 * 1024 * 1024,
          route: "direct", // Tavily is a paid SaaS, called direct per AGENTS.md "direct" route.
        });
        if (res.status === 401 || res.status === 403) {
          // Auth/config errors are not retryable: a new key is needed, not a new attempt.
          throw new ProviderRejectedError(`tavily HTTP ${res.status}`, res.status, false);
        }
        if (res.status === 429 || res.status >= 500) {
          throw new ProviderRejectedError(`tavily HTTP ${res.status}`, res.status, true);
        }
        if (res.status !== 200) {
          throw new ProviderRejectedError(`tavily HTTP ${res.status}`, res.status, false);
        }
        let json: TavilyResponse;
        try {
          json = JSON.parse(res.text()) as TavilyResponse;
        } catch (e) {
          throw new ProviderRejectedError(`tavily non-JSON: ${String(e).slice(0, 80)}`, res.status, false);
        }
        const results = Array.isArray(json.results) ? json.results : [];
        return {
          response: { results, latencyMs: Date.now() - started } as TavilyReceiptResponse,
          requestId: res.headers.get("x-request-id"),
          usage: null,
          cost: null,
        };
      },
    );
  } catch (err) {
    // paidRequest threw — bubble as exhausted so the orchestrator treats it as a soft failure.
    // ProviderRejectedError is the expected shape; everything else is an unexpected exception
    // we want to surface.
    if (err instanceof ProviderRejectedError) return { candidates: [], exhausted: true };
    throw err;
  }

  // Receipt returned. On a cached/reused receipt, `response` is whatever was previously stored;
  // on a fresh call, it carries the parsed `results` array we put there.
  const parsed = receipt.response as TavilyReceiptResponse | null;
  if (!parsed || !Array.isArray(parsed.results)) {
    // Defensive: a malformed stored receipt. Treat as exhausted so the orchestrator doesn't
    // silently publish empty results.
    return { candidates: [], exhausted: true };
  }
  const candidates = mapTavilyResults(parsed.results, query);
  return { candidates };
}

function mapTavilyResults(results: TavilyResult[], query: { id: string; q: string; lang?: string; category?: string }): Candidate[] {
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
    const summary = collapseWhitespace(stripTags(r.content ?? r.raw_content ?? "")).slice(0, 2000) || null;
    out.push({
      url: r.url,
      ...(id.startsWith("url:") ? {} : { identityKey: id }),
      title,
      excerpt: summary,
      author: null,
      publishedAt: parseTavilyDate(r.published_date ?? null),
      categories: query.category ? [query.category] : [],
      searchMeta: {
        provider: "tavily",
        queryId: query.id,
        queryText: query.q,
        queryLang: query.lang ?? null,
        queryCategory: query.category ?? null,
        refId: r.url,
      },
    });
  }
  return out;
}

function parseTavilyDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t) : null;
}
