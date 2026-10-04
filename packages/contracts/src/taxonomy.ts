// Public vocabularies shared by the website, the API and the worker. The categories themselves belong to
// the industry pack (industry/taxonomy.ts); their keys are external identities (URLs, API, RSS).
import { CATEGORIES } from "@aihot/industry/taxonomy";

export type CategoryKey = (typeof CATEGORIES)[number]["key"];
export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key) as unknown as readonly [CategoryKey, ...CategoryKey[]];

/** Website tab labels. */
export const CATEGORY_LABELS = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label])) as Record<CategoryKey, string>;

/** The public API, RSS and MCP use the same categories as the website. */
export const PUBLIC_API_CATEGORY_KEYS = CATEGORY_KEYS;
export type PublicApiCategoryKey = CategoryKey;

export function toPublicApiCategory(category: string | null): PublicApiCategoryKey | null {
  return isCategoryKey(category) ? category : null;
}

export function isCategoryKey(value: unknown): value is CategoryKey {
  return typeof value === "string" && (CATEGORY_KEYS as readonly string[]).includes(value);
}

export const CHANNEL_KEYS = ["all", "news", "x", "firstParty"] as const;
export type ChannelKey = (typeof CHANNEL_KEYS)[number];

export const CHANNEL_LABELS: Record<ChannelKey, string> = {
  all: "全部",
  news: "资讯",
  x: "X",
  firstParty: "一手",
};

export function isChannelKey(value: unknown): value is ChannelKey {
  return typeof value === "string" && (CHANNEL_KEYS as readonly string[]).includes(value);
}

export const LEADERBOARD_PUBLIC_BOARDS = ["overall", "coding", "reasoning", "knowledge", "professional"] as const;
export type LeaderboardBoardKey = (typeof LEADERBOARD_PUBLIC_BOARDS)[number];

export const LEADERBOARD_BOARD_LABELS: Record<LeaderboardBoardKey, string> = {
  overall: "综合",
  coding: "编程",
  reasoning: "推理",
  knowledge: "知识",
  professional: "专业办公",
};

/** Article ids. Also the local-data import validation pattern. */
export const ARTICLE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Legacy category keys (v0.2.0 事件型 9 类) → v0.2.1 能力型分类映射。
 *
 * `/all?category=ai-models` 这种老 URL 已经在用,改 key 必须走 URL 兼容层:route loader 收到老 key 时
 * 返回 301 重定向到新 key 对应 URL(详见 apps/web/app/lib/categoryCompat.ts)。
 *
 * 备注:这是**计划**的映射,真正生效要等 commit #2 扩 industry/taxonomy.ts 引入新能力型 keys;这里
 * 提前定义好 contract,让 admin / RSS / sitemap 那边改的时候能引用同一份表,不会出现"两个老 key 字典"。
 */
export const LEGACY_CATEGORY_REDIRECT: Readonly<Record<string, string>> = {
  "ai-models": "research",
  "ai-products": "other",
  "industry": "other",
  "funding": "other",
  "policy": "other",
  "paper": "research",
  "safety": "other",
  "tip": "writing",
  "opinion": "writing",
};

/** True when `value` is one of the legacy 9 keys that needs a 301 redirect. */
export function isLegacyCategoryKey(value: unknown): value is keyof typeof LEGACY_CATEGORY_REDIRECT {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(LEGACY_CATEGORY_REDIRECT, value);
}

/**
 * Resolve an incoming category param: legacy key → mapped new key; unknown → null (caller should 301
 * or 400 depending on context). Pure: no DB / no fetch.
 */
export function resolveCategoryKey(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  if (isLegacyCategoryKey(value)) return LEGACY_CATEGORY_REDIRECT[value];
  if (isCategoryKey(value)) return value;
  return null;
}
