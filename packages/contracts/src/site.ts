// First-party site API (/api/site/*). Not a public API: it may evolve with the website,
// but it is served from the same public read layer as v1, RSS and MCP.
import type { CategoryKey, ChannelKey } from "./taxonomy.ts";

export type SourceKind = "rss" | "web_list" | "json_list" | "x_search" | "mp_account" | "external";

/**
 * Search-engine providers feed the search-api-virtual source (W5-2). null for every other source.
 * The detail layer surfaces the original query text alongside the provider, so readers can verify
 * why this URL was selected instead of trusting an opaque algorithm.
 */
export type SearchProvider = "searxng" | "hn_algolia" | "github_trending";

export interface SourceRef {
  id: string;
  name: string;
  kind: SourceKind;
  firstParty: boolean;
  iconUrl: string | null;
  iconSrcSet?: string;
  /** Set only when this source is `search-api-virtual`; otherwise null. */
  searchProvider: SearchProvider | null;
}

export interface MediaView {
  kind: "image" | "video";
  url: string;
  /** Full image for an on-demand viewer; list previews stay small. */
  fullUrl?: string;
  width: number | null;
  height: number | null;
  alt: string | null;
  poster: string | null;
  srcSet?: string;
}

export interface XPostView {
  authorName: string;
  handle: string;
  avatarUrl: string | null;
  avatarSrcSet?: string;
  text: string;
  translation: string | null;
  /** translation: Chinese translation of the quoted post, when it is in another language. */
  quoted: { authorName: string; handle: string; text: string; url: string; translation: string | null } | null;
  media: MediaView[];
}

export interface StoryRef {
  publicId: string;
  title: string;
}

export interface ItemSummary {
  id: string;
  revision: number;
  title: string;
  originalTitle: string | null;
  summary: string | null;
  reason: string | null;
  source: SourceRef;
  links: { aihot: string; original: string };
  publishedAt: string | null;
  discoveredAt: string;
  timelineAt: string;
  category: CategoryKey | null;
  tags: string[];
  score: number | null;
  selected: boolean;
  channel: "news" | "x";
  story: StoryRef | null;
  x: XPostView | null;
  /**
   * Set only when this item's source is `search-api-virtual` (W5-2). Carries the original query that
   * surfaced the URL, so readers can see why a search-engine result made it into the timeline.
   * `queryId` is the row id from industry/search-queries.json — stable, never translated.
   */
  searchMeta: { provider: SearchProvider; queryId: string; queryText: string } | null;
}

/** The fields rendered by a site feed card; full original text lives in the item detail. */
export interface FeedItemSummary extends Pick<ItemSummary, "id" | "title" | "summary" | "reason" | "publishedAt" | "timelineAt" | "category" | "tags" | "score" | "selected" | "channel" | "searchMeta"> {
  source: Pick<SourceRef, "name" | "searchProvider">;
  x: (Pick<XPostView, "authorName" | "handle" | "avatarUrl" | "avatarSrcSet" | "media"> & {
    quoted: Omit<NonNullable<XPostView["quoted"]>, "url"> | null;
  }) | null;
}

export interface GroupInfo {
  factId: string;
  story: StoryRef | null;
  /** Other public sources of the fact the card represents (same set as the expandable reports). */
  additionalSourceCount: number;
  /** Distinct public reports across the group's facts. */
  reportCount: number;
  /** Facts of the group (the card's own included) with at least one selected item under the current filters. */
  developmentCount: number;
  /** The newest development when it is not the card's own fact: why the card sits where it does. */
  latestDevelopment?: { factId: string; title: string; at: string } | null;
}

export interface TimelineCard {
  key: string;
  anchorAt: string;
  item: FeedItemSummary;
  group: GroupInfo | null;
}

export interface HotStripEntry {
  rank: number;
  title: string;
  heat: number;
  trend: "up" | "down" | "flat" | "new" | "unknown";
  storyPublicId: string | null;
  itemId: string | null;
  participants: HotParticipant[];
  participantCount: number;
}

export interface TimelineFilters {
  channel: ChannelKey;
  category: CategoryKey | null;
  tag: string | null;
  topic?: string | null;
}

export interface TimelineResponse {
  filters: TimelineFilters;
  cards: TimelineCard[];
  nextCursor: string | null;
  /** Absolute time when a pending item in this scope becomes visible; the page re-checks then. */
  refreshAt: string | null;
  hot: HotStripEntry[] | null;
  dayCounts: Record<string, number>;
  generatedAt: string;
}

export interface PoolResponse {
  filters: TimelineFilters & { q: string | null; tab: "time" | "relevance" };
  items: FeedItemSummary[];
  page: number;
  pageCount: number;
  total: number;
  todayCount: number;
  freshness: string;
  generatedAt: string;
}

/** Top tool_release items in the last sinceHours, the homepage ("/new") payload. */
export interface DailyResponse {
  items: FeedItemSummary[];
  /** Earliest upcoming visible_after inside the daily window — caches expire then. */
  refreshAt: string | null;
  generatedAt: string;
}

/** Sort orders for the /tools grid. "recent" = newest by sort_at, "score" = highest score first. */
export type ToolsSort = "recent" | "score";

/**
 * /tools payload: the navigation layer's tool catalog. One card per publication in the
 * tool_release set (any item tagged 产品更新 / 模型发布 / 平台 / legacy 新工具). Each row IS a
 * distinct tool announcement (no entity dedup yet) — clicking a card opens the existing /items/:id
 * detail page, where the worker has already scored and translated the source. Future W3+ may add a
 * tools/tools_versions schema for canonical entities; the public shape here stays the same.
 */
export interface ToolsFilters {
  category: CategoryKey | null;
  tag: string | null;
  /** "all" keeps the default news-only set; "x" and "firstParty" mirror the timeline channels. */
  channel: ChannelKey;
  sort: ToolsSort;
}

export interface ToolsResponse {
  filters: ToolsFilters;
  items: FeedItemSummary[];
  nextCursor: string | null;
  /** Absolute time when the next pending release becomes visible inside this scope. */
  refreshAt: string | null;
  /** Earliest discovered_at in the result window — the UI uses it to show "last N days". */
  windowDays: number;
  generatedAt: string;
}

/** /papers — translation-officer feed (W4b plan §2.1). One card per arXiv paper; independent
 *  of publications because papers have a long-lived lifecycle (no 7-day window, no 5-axis
 *  score, no editorial "selected" gate). LLM-translated columns are filled in by the worker
 *  after the fetcher writes the raw English row. */
export type PaperStatus = "fetched" | "translating" | "translated" | "partial" | "failed";

export interface PaperSummary {
  /** The arXiv canonical id, e.g. "2601.12345". */
  id: string;
  titleEn: string;
  /** null when status is fetched/failed; LLM-translated otherwise. */
  titleZh: string | null;
  /** First 240 chars of the English abstract — enough for the card, full text on detail. */
  abstractEn: string;
  /** null when not yet translated. */
  abstractZh: string | null;
  /** First 6 authors + "et al." sentinel for longer lists (detail page shows the full list). */
  authors: string[];
  primaryCategory: string;
  publishedAt: string;
  absUrl: string;
  status: PaperStatus;
}

export interface PaperFilters {
  category: string | null;
  tag: string | null;
}

export interface PapersQuery {
  category?: string | null;
  tag?: string | null;
  windowDays?: number;
  limit?: number;
  cursor?: string | null;
  now?: Date;
}

export interface PapersResponse {
  filters: PaperFilters;
  items: PaperSummary[];
  nextCursor: string | null;
  /** Earliest upcoming fetch window inside the active filter — caches expire then so a new
   *  arXiv drop appears promptly. */
  refreshAt: string | null;
  windowDays: number;
  generatedAt: string;
}

export interface PaperDetail extends PaperSummary {
  /** Full English abstract (no truncation). */
  abstractEnFull: string;
  /** Full Chinese abstract when translated; null otherwise. */
  abstractZhFull: string | null;
  /** 3-5 short bullets extracted by the LLM; [] until translated. */
  keyPoints: string[];
  pdfUrl: string;
  fetchedAt: string;
  translatedAt: string | null;
  summaryModel: string | null;
}

export interface OutlineEntry {
  id: string;
  text: string;
  level: number;
}

export interface ItemDetail extends ItemSummary {
  readingMode: "full" | "summary-only";
  author: string | null;
  language: string | null;
  /** Chinese body (translation or Chinese original) and original body, whitelisted HTML. */
  body: { zh: string | null; original: string | null; zhKind: "translation" | "original" | null; complete: boolean } | null;
  outline: OutlineEntry[];
  relatedStories: StoryRef[];
  indexable: boolean;
  markdownAvailable: boolean;
  group: GroupInfo | null;
}

export interface GroupReport {
  id: string;
  title: string;
  summary: string | null;
  source: SourceRef;
  timelineAt: string;
  originalUrl: string;
  selected: boolean;
}

export interface GroupReportsResponse {
  factId: string;
  revision: string;
  reports: GroupReport[];
  nextCursor: string | null;
}

export interface Development {
  factId: string;
  title: string;
  occurredAt: string | null;
  representative: ItemSummary;
  reportCount: number;
}

export interface DevelopmentsResponse {
  story: StoryRef;
  revision: string;
  developments: Development[];
  nextCursor: string | null;
}

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  requestId: string;
  retryAfter?: number;
}

// ---------------------------------------------------------------------------
// Hot ranking and stories
// ---------------------------------------------------------------------------

export interface HotParticipant {
  name: string;
  kind: "editorial" | "signal";
  /** The source's icon, or for an X account its latest collected avatar (proxied). */
  iconUrl: string | null;
  iconSrcSet?: string;
}


export interface HotEntryView {
  rank: number;
  story: StoryRef;
  heat: number;
  trend: "up" | "down" | "flat" | "new" | "unknown";
  trendPct: number | null;
  badges: Array<"surge" | "new" | "rising">;
  participantCount: number;
  sourceCount: number;
  signalCount: number;
  reportCount: number;
  sourceNames: string[];
  latestAt: string;
  firstReportAt: string;
  representative: { id: string; url: string; sourceName: string } | null;
  participants: HotParticipant[];
  /** Hourly heat over the 24 hours up to the ranking, oldest first; null where no comparable snapshot exists. */
  spark: Array<number | null>;
  /** The story's AI digest, else its fact statement. */
  summary: string | null;
  /** The latest development, one line. */
  latest: string | null;
  /** A picture from the story's public reports (the representative first), for the leading cards. */
  cover: { url: string; srcSet?: string; width: number | null; height: number | null } | null;
}

export interface HotResponse {
  computedAt: string | null;
  ruleVersion: string | null;
  windowHours: number;
  entries: HotEntryView[];
}

export interface HeatPoint {
  hour: string;
  heat: number;
  participants: number;
}

export interface StoryReportView {
  id: string;
  title: string;
  summary: string | null;
  source: SourceRef;
  publishedAt: string;
  originalUrl: string;
  selected: boolean;
  factId: string;
}

export interface StoryFactView {
  factId: string;
  title: string;
  occurredAt: string | null;
  firstReportAt: string;
  reportCount: number;
  representative: StoryReportView;
}

export interface StoryDetail {
  publicId: string;
  title: string;
  status: "active" | "watching" | "settled";
  reportCount: number;
  sourceCount: number;
  firstReportAt: string | null;
  latestAt: string | null;
  digest: string | null;
  digestUpdatedAt: string | null;
  /** The story's own factual summary, when it has one. */
  summary: string | null;
  /** Without a digest or summary: the summary of the report the story started from. */
  excerpt: { text: string; sourceName: string } | null;
  latest: string | null;
  whyHot: {
    participants48h: number;
    newParticipants6h: number;
    recentReports24h: number;
    observationComplete: boolean;
    rank: number | null;
    heat: number | null;
  };
  developments: StoryFactView[];
  officialReports: StoryReportView[];
  timeline: StoryReportView[];
  heat: HeatPoint[];
  related: Array<StoryRef & { relation: "storyline" | "related"; latestAt: string | null }>;
}

// ---------------------------------------------------------------------------
// Reports (daily / weekly / monthly)
// ---------------------------------------------------------------------------

export type ReportKind = "daily" | "weekly" | "monthly";

export interface ReportCitation {
  itemId: string | null;
  title: string;
  summary: string | null;
  sourceName: string;
  sourceUrl: string;
  sourceId: string | null;
  sourceIconUrl: string | null;
  sourceIconSrcSet?: string;
  firstParty: boolean;
  role: string | null;
  storyPublicId: string | null;
  /** When the cited report was published, if it is still in the database. */
  publishedAt: string | null;
  /** False once the item was withdrawn; the citation then shows as removed. */
  available: boolean;
}

export interface ReportDetail {
  kind: ReportKind;
  key: string;
  title: string;
  windowStart: string;
  windowEnd: string;
  generatedAt: string;
  revision: number;
  lead: { title: string; leadParagraph: string } | null;
  overview: string | null;
  highlights: ReportCitation[];
  /** As edited: daily categories, weekly and monthly themes. */
  sections: Array<{ label: string; summary: string | null; items: ReportCitation[] }>;
  /** Reading order: every section item once, labelled with its section. */
  stories: Array<ReportCitation & { label: string }>;
  flashes: ReportCitation[];
  /**
   * The front page's picture: from the lead item (a daily's lead, a weekly or monthly's first highlight),
   * else from another public report of that event. Captioned with the story when it is not the lead's own.
   */
  cover: { url: string; srcSet?: string; width: number | null; height: number | null; caption: string | null } | null;
  metrics: Record<string, number>;
  readingMinutes: number;
  prev: string | null;
  next: string | null;
}

export interface ReportIndexEntry {
  key: string;
  title: string | null;
  generatedAt: string;
  count: number;
}

/** Figures and samples for the about page (site-only; not part of v1). */
export interface SiteStats {
  /** Sources collected from now. */
  sources: number;
  /** Enabled sources by kind: x_search, rss, web_list, mp_account, json_list. */
  sourceKinds: Record<string, number>;
  /** Of them, sources that only count toward heat (their items never reach 精选). */
  heatOnlySources: number;
  /** Everything collected and not withdrawn, heat-only sources included. */
  items: number;
  selected: number;
  dailies: number;
  /** The last 24 hours: items found (heat-only sources included), and items that made 精选 (by their place on the timeline). */
  day: { collected: number; selected: number };
  /** Enabled sources in a daily shuffle, for the about page's river: one line per source. */
  sampleSources: Array<{ name: string; kind: string; heatOnly: boolean }>;
  /** The latest 精选, newest first. */
  latest: Array<{ id: string; title: string; source: string }>;
}

/** A reading page transfers one language; the canonical item retains both for exports. */
export interface SiteItemDetail extends Omit<ItemDetail, "x"> {
  x: Omit<XPostView, "text" | "translation"> | null;
  hasTranslation: boolean;
  bodyLanguage: "zh" | "original";
}

export interface StoryFollowup {
  factId: string;
  representative: { id: string; title: string; source: { name: string }; timelineAt: string };
}
export interface StoryFollowupsResponse { items: StoryFollowup[]; more: boolean }

/**
 * /tools/:id payload. Same shape as the /items/:id detail, plus two extras:
 * - `updates`: siblings published in the last 7 days that share at least one tag (no canonical
 *   tools/tools_versions schema yet, so "same tool update" is approximated by tag overlap ≥ 1)
 * - `related`: top-scoring siblings whose tags intersect this item's tags in ≥ 2 places
 */
export interface SiteToolDetail extends SiteItemDetail {
  updates: FeedItemSummary[];
  related: FeedItemSummary[];
}

/** All issue keys keep numbering and calendars stable; closed daily months omit their titles. */
export interface ReportNavigationEntry { key: string; title?: string | null; count?: number }

// ---------------------------------------------------------------------------
// W5-3 prompt column. Visitors-facing list of usable prompts collected from
// public posts across the web, with their original-page comments surfaced as
// user-feedback voices. See docs/features/prompts-collection.md.

/**
 * Top-level buckets the prompt column filters by. Capability-axis (writing / coding / image / video
 * / audio / agent / data / research / study / other) so a prompt card and a tool card can share the
 * same key on the detail page. Legacy `painting` is gone (folded into `image`) and `design` is gone
 * (folded into `image` and `other`); see migrations/XXXX_prompt_painting_to_image.sql for the row
 * rewrite. Adding a key here also requires an editorial-prompt update so the worker keeps tagging
 * rows into the new bucket.
 */
export type PromptCategory =
  | "writing"
  | "coding"
  | "image"
  | "video"
  | "audio"
  | "agent"
  | "data"
  | "research"
  | "study"
  | "other";

export const PROMPT_CATEGORIES: readonly PromptCategory[] = [
  "writing",
  "coding",
  "image",
  "video",
  "audio",
  "agent",
  "data",
  "research",
  "study",
  "other",
] as const;

/** Display labels for each bucket. Used by the chip row, the detail page and the admin editor. */
export const PROMPT_CATEGORY_LABELS: Record<PromptCategory, string> = {
  writing: "写作",
  coding: "编程",
  image: "图像",
  video: "视频",
  audio: "音频",
  agent: "Agent",
  data: "数据",
  research: "调研",
  study: "学习",
  other: "其他",
};

/** One-line guide for the worker and the admin dropdown: how to bucket borderline rows. */
export const PROMPT_CATEGORY_GUIDES: Record<PromptCategory, string> = {
  writing: "改写、扩写、润色、营销文案、长文、翻译",
  coding: "代码生成、review、debug、refactor、test",
  image: "SD/MJ/DALL-E 风格、negative prompt、camera/lighting(legacy `painting` rows remap here)",
  video: "文生视频 / 图生视频 / 镜头控制 / 视频编辑 prompt",
  audio: "TTS / 音乐生成 / 声音克隆 / 播客编辑",
  agent: "工具调用、多步任务、planning、reflection",
  data: "SQL/Pandas、可视化、ETL、数据清洗",
  research: "市场分析、竞品、用户访谈、文献综述",
  study: "tutor、知识图谱、记忆卡片(legacy `design` rows related to study go here)",
  other: "兜底",
};

export interface PromptCard {
  id: string;
  category: PromptCategory;
  /** One-line summary of where the prompt can be applied (≤80 chars). */
  useCase: string | null;
  /** Prompt text body — short cards truncate; the detail page holds the full string. */
  promptPreview: string;
  language: string;
  community: string;
  sourceKind: PromptSourceKind;
  originalUrl: string;
  capturedAt: string;
}

/** Source-kind values seen by the prompt column. A subset of the wider SourceKind so we don't
 * accidentally surface prompt rows tagged with kinds we don't understand. */
export type PromptSourceKind = "manual" | "searxng_search" | "rss" | "external";

export interface PromptDetail extends PromptCard {
  /** Full prompt text (not truncated). */
  promptText: string;
  originalPostId: string | null;
}

export interface PromptsResponse {
  filters: { category: PromptCategory | null };
  items: PromptCard[];
  nextCursor: string | null;
  refreshAt: string | null;
  windowDays: number;
  generatedAt: string;
}

/**
 * v0.2.1-#6 — three-block cross-axis discovery view surfaced on /all. One HTTP call returns a
 * narrow slice of each column so the page can render tools / papers / prompts side-by-side with
 * a category chip that filters all three. The server picks each block's items with the same
 * filter logic its dedicated route uses (loadTools / loadPapers / loadPrompts); the contract is
 * only a slice, never the whole feed.
 *
 * `appliedCategory` is the v0.2.1 capability key actually used in each block — the categories
 * are disjoint by axis (CATEGORY_KEYS only on tools, ARXIV_PRIMARY only on papers, PROMPT_CATEGORIES
 * only on prompts), so when the user lands on /all?category=writing the tools block carries
 * `appliedCategory: null` and the UI quietly skips the chip there. Pinning the per-block shape
 * is what keeps the wire honest about cross-axis coverage.
 */
export interface DiscoverBlock<T> {
  items: T[];
  /** Echoed back so the UI can show the column heading ("writing · 12 条") without refetching. */
  appliedCategory: string | null;
  /** The route path that lists this block's full feed with the same category — "查看全部 →" target. */
  fullPath: string;
  /** True when the block is empty because the axis has no data for this filter, not because the
   *  underlying column is broken. The UI uses this to render "暂无相关提示词" instead of an error. */
  empty: boolean;
}

export interface DiscoverResponse {
  /** Echoed back unchanged. Lets the UI render the same chip the rest of /all already shows. */
  category: string | null;
  /** Truncated label for the chip ("写作 · 查看全部 → /prompts?category=writing"). */
  categoryLabel: string | null;
  tools: DiscoverBlock<FeedItemSummary>;
  papers: DiscoverBlock<PaperSummary>;
  prompts: DiscoverBlock<PromptCard>;
  generatedAt: string;
}

export interface PromptsQuery {
  category?: PromptCategory | null;
  cursor?: string | null;
  windowDays?: number;
  limit?: number;
  now?: Date;
}
