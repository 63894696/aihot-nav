// GitHub Trending — third zero-budget search engine source.
//
// Why this file:
// - Open-source AI projects trend on GitHub before they show up on blogs. We pull daily trending
//   repos and surface new repos (or new velocity bursts) to the editorial pipeline.
// - The free public endpoint `https://github-trending-api.de.a9sapp.eu/<lang>/<since>` mirrors
//   github.com/trending. No API key.
//
// What this is NOT:
// - It's not the GitHub REST API. Real trending needs scraping github.com/trending; this endpoint
//   is a third-party mirror that occasionally goes stale. The score gate keeps noise out.

import { guardedFetch } from "../lib/http-fetch.ts";
import { identityKeyForUrl } from "../lib/url.ts";
import { stripTags, collapseWhitespace } from "../lib/text.ts";
import type { Candidate } from "./types.ts";

/**
 * GitHub Trending mirror base URL. Exported as `let` so tests can point it at a local stub, and so
 * deployments behind an egress proxy can override it without code changes.
 */
export let GH_TRENDING_API = "https://github-trending-api.de.a9sapp.eu";
const QUERY_TIMEOUT_MS = 8_000;
const MAX_RESULTS = 25;

interface GhTrendingAuthor {
  name?: string;
  username?: string;
  url?: string;
  avatar?: string;
}

interface GhRepo {
  author?: string;
  repo?: string;
  name?: string;       // "owner/repo"
  url?: string;        // "/owner/repo"
  description?: string | null;
  language?: string | null;
  languageColor?: string | null;
  stars?: number;
  forks?: number;
  currentPeriodStars?: number;
  builtBy?: GhTrendingAuthor[];
}

/**
 * Fetch GitHub Trending for a fixed language window (default: daily, English languages we cover).
 * The query's category is mapped to a GitHub language when possible; otherwise we fetch all
 * languages for the daily window.
 */
export async function fetchGithubTrending(query: { id: string; q: string; lang?: string; category?: string }): Promise<{ candidates: Candidate[] }> {
  // The third-party endpoint only takes language and since; it does not take a free-text query.
  // We always pull "daily" (the shortest window — what the LLM score gate wants is fresh).
  const since = "daily";
  const lang = langForCategory(query.category) ?? "";
  const url = `${GH_TRENDING_API}/${encodeURIComponent(lang)}/${since}`;
  const res = await guardedFetch(url, {
    timeoutMs: QUERY_TIMEOUT_MS,
    headers: { accept: "application/json" },
    maxBytes: 2 * 1024 * 1024,
  });
  if (res.status !== 200) throw new Error(`GitHub Trending returned ${res.status}`);
  let json: GhRepo[] | null;
  try {
    json = JSON.parse(res.text());
  } catch (e) {
    throw new Error(`GitHub Trending returned non-JSON: ${String(e).slice(0, 80)}`);
  }
  const repos = Array.isArray(json) ? json : [];
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const r of repos) {
    const repoUrl = r.url && r.url.startsWith("http") ? r.url : r.url ? `https://github.com${r.url}` : null;
    if (!repoUrl) continue;
    const id = identityKeyForUrl(repoUrl);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = r.name ?? r.repo ?? "";
    const title = collapseWhitespace(stripTags(r.repo ?? name ?? "")).slice(0, 300) || null;
    if (!title) continue;
    const desc = collapseWhitespace(stripTags(r.description ?? "")).slice(0, 1000) || null;
    out.push({
      url: repoUrl,
      ...(id.startsWith("url:") ? {} : { identityKey: id }),
      title,
      author: r.author ?? (name ? name.split("/")[0] : null),
      publishedAt: null,
      excerpt: desc,
      categories: query.category ? [query.category] : [],
      searchMeta: { provider: "github_trending", queryId: query.id, queryText: query.q, queryLang: query.lang ?? null, queryCategory: query.category ?? null, language: r.language ?? null, stars: r.stars ?? null, currentPeriodStars: r.currentPeriodStars ?? null },
    });
    if (out.length >= MAX_RESULTS) break;
  }
  return { candidates: out };
}

/** Map editorial categories to GitHub Trending language filters. Empty string = all languages. */
function langForCategory(category: string | undefined): string | null {
  if (!category) return null;
  const map: Record<string, string> = {
    model_release: "python",
    tool_release: "typescript",
    tool_update: "typescript",
    research_paper: "python",
  };
  return map[category] ?? null;
}
