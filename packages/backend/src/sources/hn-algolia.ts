// Hacker News via Algolia — second zero-budget search engine source.
//
// Why this file:
// - HN Algolia exposes a free, keyless JSON API: https://hn.algolia.com/api/v1/search?query=&tags=story.
// - AI/tech releases show up on HN fast; the same query list covers both.
// - Same shape as searxng.ts: one query per call, ~30 candidates, URL identity stable across fetches.

import { guardedFetch } from "../lib/http-fetch.ts";
import { identityKeyForUrl } from "../lib/url.ts";
import { stripTags, collapseWhitespace } from "../lib/text.ts";
import type { Candidate } from "./types.ts";

/**
 * HN Algolia base URL. Exported as `let` so tests can point it at a local stub, and so deployments
 * behind an egress proxy can override it without code changes.
 */
export let HN_API = "https://hn.algolia.com/api/v1/search";
const QUERY_TIMEOUT_MS = 8_000;
const MAX_RESULTS = 30;

interface HnHit {
  objectID: string;
  title?: string | null;
  story_title?: string | null;
  url?: string | null;
  story_url?: string | null;
  author?: string | null;
  created_at_i?: number;
  num_comments?: number;
  points?: number;
  _tags?: string[];
}

export interface HnAlgoliaResult {
  candidates: Candidate[];
}

/**
 * Run one query against HN Algolia. Returns up to 30 candidates sorted by relevance (Algolia's
 * default) — popular stories that mention the query terms.
 */
export async function fetchHnAlgolia(query: { id: string; q: string; lang?: string; category?: string }): Promise<HnAlgoliaResult> {
  const url = `${HN_API}?query=${encodeURIComponent(query.q)}&tags=story&hitsPerPage=${MAX_RESULTS}`;
  const res = await guardedFetch(url, {
    timeoutMs: QUERY_TIMEOUT_MS,
    headers: { accept: "application/json" },
    maxBytes: 2 * 1024 * 1024,
  });
  if (res.status !== 200) {
    // HN Algolia is usually up; a non-200 is a real outage and the worker should retry next slot.
    throw new Error(`HN Algolia returned ${res.status}`);
  }
  let json: { hits?: HnHit[] } | null;
  try {
    json = JSON.parse(res.text());
  } catch (e) {
    throw new Error(`HN Algolia returned non-JSON: ${String(e).slice(0, 80)}`);
  }
  const hits = json?.hits ?? [];
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    const storyUrl = h.url ?? h.story_url;
    if (!storyUrl) continue;
    if (!/^https?:\/\//i.test(storyUrl)) continue;
    const id = identityKeyForUrl(storyUrl);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const title = collapseWhitespace(stripTags(h.title ?? h.story_title ?? "")).slice(0, 300) || null;
    if (!title) continue;
    out.push({
      url: storyUrl,
      ...(id.startsWith("url:") ? {} : { identityKey: id }),
      title,
      author: h.author ?? null,
      publishedAt: h.created_at_i ? new Date(h.created_at_i * 1000) : null,
      excerpt: buildExcerpt(h),
      categories: query.category ? [query.category] : [],
      searchMeta: { provider: "hn_algolia", queryId: query.id, queryText: query.q, queryLang: query.lang ?? null, queryCategory: query.category ?? null, refId: h.objectID },
    });
    if (out.length >= MAX_RESULTS) break;
  }
  return { candidates: out };
}

function buildExcerpt(h: HnHit): string | null {
  // HN Algolia gives a small body of structured fields but no body text. Compose a useful summary
  // so the LLM scorer has something to grade on.
  const parts: string[] = [];
  if (typeof h.points === "number") parts.push(`${h.points} points`);
  if (typeof h.num_comments === "number") parts.push(`${h.num_comments} comments`);
  if (h._tags && h._tags.length) parts.push(`tags: ${h._tags.join(", ")}`);
  return parts.length ? parts.join(" • ") : null;
}
