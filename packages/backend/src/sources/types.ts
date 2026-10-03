import type { MaterialInput } from "../content/materials.ts";

export interface SourceRow {
  id: string;
  name: string;
  kind: "rss" | "web_list" | "json_list" | "x_search" | "mp_account" | "external" | "search_api";
  config: Record<string, any>;
  tier: string;
  participation_mode: "editorial" | "hot_signal" | "isolated";
  first_party: boolean;
  interval_minutes: number;
  enabled: boolean;
  cursor: Record<string, any> | null;
  fail_count: number;
}

/**
 * Side-channel attached by the search-engine fetchers (searxng/hn-algolia/github-trending). The
 * orchestrator promotes this into the `via` field when it writes the article. Not present on
 * candidates from RSS / web_list / json_list collectors.
 */
export interface SearchMeta {
  provider: "searxng" | "hn_algolia" | "github_trending";
  queryId: string;
  queryText: string;
  queryLang?: string | null;
  queryCategory?: string | null;
  refId?: string | null;
  language?: string | null;
  stars?: number | null;
  currentPeriodStars?: number | null;
}

/**
 * What a fetcher found on a listing, before identity and timeline rules are applied. Whether the
 * article page is then fetched for a body is decided per source (jobs/content.ts route).
 */
export type Candidate = Omit<MaterialInput, "sourceId" | "via"> & {
  categories?: string[];
  searchMeta?: SearchMeta;
};

export class FetchError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}
