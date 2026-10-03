// Search-engine attribution badge + query line (W5-2).
// Reader-facing: the site shows a small "来源: Hacker News" label on cards and a one-line "查询来源"
// under the title on the detail page. The text is the literal query from industry/search-queries.json
// so the reader can see why a URL made it onto the timeline.

import type { SearchProvider } from "@aihot/contracts/site";
import { Badge } from "./Badge";

const LABEL: Record<SearchProvider, string> = {
  searxng: "SearXNG",
  hn_algolia: "Hacker News",
  github_trending: "GitHub Trending",
};

/** Compact provider chip. Use next to the source name on cards. */
export function SearchBadge({ provider, className = "" }: { provider: SearchProvider; className?: string }) {
  return (
    <Badge tone="accent" title={`通过 ${LABEL[provider]} 检索发现`} className={className}>
      {LABEL[provider]}
    </Badge>
  );
}

/** One-line "查询来源: …" label. Use on the detail page, below the title. */
export function SearchQueryLine({ provider, queryText }: { provider: SearchProvider; queryText: string }) {
  return (
    <p className="mt-1 text-[12.5px] text-ink-4">
      查询来源:{" "}
      <span className="text-ink-3">{queryText}</span>
      <span className="ml-1.5 text-ink-4">· {LABEL[provider]}</span>
    </p>
  );
}
