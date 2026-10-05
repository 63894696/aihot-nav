// Brave Search API — paid 5th engine, gated to zh-only queries (FIX-S).
//
// Why this file:
// - FIX-S: After Tavily (FIX-R) proved Chinese coverage is the weak axis, the user authorised a
//   second paid AI-search engine to widen the net. BraveSearch is a traditional crawler + free
//   credit ($5/month ≈ 1000 queries at 1 QPS). It complements Tavily with stronger Chinese
//   news + blog index (Brave Search has been scraping Chinese sources since 2021) so dedupe
//   across (SearXNG, HN, GH, Tavily, Brave) gives meaningfully more coverage than Tavily alone.
// - Every call goes through `paidRequest` (same path as Jina/SocialData/Tavily) so each request
//   writes a receipts row and the budgets.per_minute/per_hour/per_day caps apply. Service name
//   is `brave`; caps are set by migration 0047_brave_search_engine.sql.
//
// Cost / cycle controls (set by the caller, not here):
// - This file does NOT throttle. search-fetch.ts and prompt-fetch.ts only invoke fetchBrave
//   for queries with `lang === "zh"` so the call surface is small. The orchestrator also
//   persists a cycle counter so it can skip Brave on off-cycles when the free credit is tight.
//
// Output shape:
// - Same as HN Algolia / SearXNG / Tavily: Candidate[] with searchMeta.provider="brave". refId
//   carries the Brave URL so the article's via line is traceable.

import { credential } from "../config.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { identityKeyForUrl } from "../lib/url.ts";
import { stripTags, collapseWhitespace } from "../lib/text.ts";
import { paidRequest, ProviderRejectedError } from "../providers/receipts.ts";
import { sanitizeJsonControlChars } from "./tavily.ts";
import type { Candidate } from "./types.ts";

const QUERY_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESULTS = 8;

/** Brave query-string parameters — POST not supported by Brave Web Search API. */
interface BraveQueryParams {
  q: string;
  count?: number;
  safesearch?: "off" | "moderate" | "strict";
  freshness?: string; // 'pd' / 'pw' / 'pm' / 'py' — Brave's relative date qualifiers
}

interface BraveResult {
  url?: string;
  title?: string;
  description?: string;
  age?: string | null;
  profile?: { name?: string } | null;
}

interface BraveResponse {
  web?: { results?: BraveResult[] };
  query?: { original?: string };
}

interface BraveReceiptResponse {
  results: BraveResult[];
  latencyMs: number;
}

export interface BraveFetchResult {
  candidates: Candidate[];
  /** True when BRAVE_API_KEY is absent; the caller should skip silently without burning a cycle. */
  skippedNoKey?: boolean;
  /** True on every-failure (retryable); the caller may retry next cycle. */
  exhausted?: boolean;
}

/**
 * Run one zh query through Brave Search. Returns the candidates, plus a soft-skip signal when
 * the API key is absent (the worker treats that as "not configured" rather than "failed").
 *
 * Identity: Brave URLs are passed through identityKeyForUrl, same as the other engines, so
 * dedupe across SearXNG/HN/GH/Tavily/Brave still works.
 */
export async function fetchBrave(
  query: { id: string; q: string; lang?: string; category?: string },
): Promise<BraveFetchResult> {
  const apiKey = credential("collectors", "BRAVE_API_KEY");
  if (!apiKey) {
    // No-key is NOT a paid-request failure: returning skippedNoKey lets the caller drop the
    // attempt cleanly. We deliberately do NOT go through paidRequest here because there is no
    // point charging a request we cannot make.
    return { candidates: [], skippedNoKey: true };
  }
  const base = (credential("collectors", "BRAVE_BASE_URL") ?? "https://api.search.brave.com").replace(/\/$/, "");

  // Brave Search API uses GET with query-string params (no POST body). Encode the query in the
  // URL so the request body stays empty — guardedFetch sends `body: undefined` cleanly.
  const params = new URLSearchParams({
    q: query.q,
    count: String(DEFAULT_MAX_RESULTS),
    safesearch: "moderate",
  });
  const url = `${base}/res/v1/web/search?${params.toString()}`;

  let receipt;
  try {
    receipt = await paidRequest(
      {
        service: "brave",
        model: null,
        purpose: "search.zh",
        subject: `q:${query.id}`,
        identity: { queryId: query.id, queryLang: query.lang ?? null, queryCategory: query.category ?? null },
        requestSummary: { queryId: query.id, queryChars: query.q.length, maxResults: DEFAULT_MAX_RESULTS },
      },
      async () => {
        const started = Date.now();
        const res = await guardedFetch(url, {
          method: "GET",
          headers: {
            accept: "application/json",
            // Brave uses a custom header (X-Subscription-Token), not Bearer.
            "x-subscription-token": apiKey,
          },
          timeoutMs: QUERY_TIMEOUT_MS,
          maxBytes: 2 * 1024 * 1024,
          route: "direct",
        });
        if (res.status === 401 || res.status === 403) {
          // Auth/config errors are not retryable: a new key is needed, not a new attempt.
          throw new ProviderRejectedError(`brave HTTP ${res.status}`, res.status, false);
        }
        if (res.status === 429 || res.status >= 500) {
          throw new ProviderRejectedError(`brave HTTP ${res.status}`, res.status, true);
        }
        if (res.status !== 200) {
          throw new ProviderRejectedError(`brave HTTP ${res.status}`, res.status, false);
        }
        let json: BraveResponse;
        try {
          // Same defense as Tavily: error responses occasionally ship raw control chars inside
          // JSON string literals. Reuse the Tavily walker — it has the same semantics (escape
          // 0x00-0x1F inside string literals, leave the rest alone). Exporting from tavily.ts
          // is intentional; the fix is a single shared primitive, not per-engine.
          json = JSON.parse(sanitizeJsonControlChars(res.text())) as BraveResponse;
        } catch (e) {
          throw new ProviderRejectedError(`brave non-JSON: ${String(e).slice(0, 80)}`, res.status, false);
        }
        const results = Array.isArray(json.web?.results) ? json.web!.results! : [];
        return {
          response: { results, latencyMs: Date.now() - started } as BraveReceiptResponse,
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
  const parsed = receipt.response as BraveReceiptResponse | null;
  if (!parsed || !Array.isArray(parsed.results)) {
    // Defensive: a malformed stored receipt. Treat as exhausted so the orchestrator doesn't
    // silently publish empty results.
    return { candidates: [], exhausted: true };
  }
  const candidates = mapBraveResults(parsed.results, query);
  return { candidates };
}

function mapBraveResults(results: BraveResult[], query: { id: string; q: string; lang?: string; category?: string }): Candidate[] {
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
    const summary = collapseWhitespace(stripTags(r.description ?? "")).slice(0, 2000) || null;
    out.push({
      url: r.url,
      ...(id.startsWith("url:") ? {} : { identityKey: id }),
      title,
      excerpt: summary,
      author: null,
      publishedAt: parseBraveDate(r.age ?? null),
      categories: query.category ? [query.category] : [],
      searchMeta: {
        provider: "brave",
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

function parseBraveDate(v: string | null | undefined): Date | null {
  // Brave's `age` field is human-readable ("2 days ago", "3 hours ago", "2026-10-05",
  // "just now"). Date.parse handles ISO 8601 and many RFC 2822 forms but not the relative
  // qualifiers — best effort, return null for anything Date.parse rejects.
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t) : null;
}