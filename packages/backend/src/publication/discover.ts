// /api/site/discover — v0.2.1-#6 three-block cross-axis discovery slice.
//
// One HTTP call returns a narrow window of each column (tools / papers / prompts) so /all can
// render a side-by-side discovery view without fanning out three separate requests from the
// browser. The block size is intentionally small (default 6 per axis) — this is a teaser
// surface, not the column feed. "查看全部 →" on each block jumps to /tools, /papers or /prompts
// with the same category already applied.
//
// Category routing by axis (the v0.2.1 capability-axis taxonomy from industry/taxonomy.ts):
//   - CATEGORY_KEYS           → only the tools block
//   - ARXIV_PRIMARY_KEYS      → only the papers block
//   - PROMPT_CATEGORIES       → only the prompts block
//
// A category that does not belong to the block's axis is silently dropped from that block —
// the wire's `appliedCategory` tells the UI which block(s) actually consumed the filter, so
// a /all?category=writing URL renders the chip only above the prompts column.
//
// Best-effort semantics: a failure in one block must not break the other two. We try/catch
// each block independently and surface the result via `empty`. The endpoint never 5xx's for a
// partial outage — visitors see whatever did load and a quiet "暂无" on the broken block.
import type {
  DiscoverBlock,
  DiscoverResponse,
  FeedItemSummary,
  PaperSummary,
  PromptCard,
} from "@aihot/contracts/site";
import {
  PROMPT_CATEGORIES,
  type PromptCategory,
} from "@aihot/contracts/site";
import { CATEGORY_KEYS, CATEGORY_LABELS, type CategoryKey } from "@aihot/contracts/taxonomy";
import { loadPrompts } from "./prompts.ts";
import { loadPapers } from "./papers.ts";
import { loadTools } from "./tools.ts";

const BLOCK_LIMIT = 6;
const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_PROMPT_WINDOW_DAYS = 90;

export interface DiscoverQuery {
  category?: string | null;
  /** Caller-provided clock; tests pin this for snapshot stability. */
  now?: Date;
}

/**
 * Resolve which axis a category key belongs to. CATEGORY_KEYS (capability-axis taxonomy for
 * tools) and PROMPT_CATEGORIES (v0.2.1 capability-axis for prompts) are disjoint by construction
 * (industry/taxonomy.ts v0.2.1). The papers block accepts anything that isn't in those two sets
 * — loadPapers treats `category` as a free-form arXiv primary_category string and there is no
 * exported ARXIV_PRIMARY_KEYS list today (see packages/contracts/src/site.ts:loadPapers signature).
 * v0.2.0→v0.2.1 legacy buckets ("painting", "design") are NOT routed here — the route loader
 * collapses them to "image" before they reach this loader (see v0.2.1-#5 +
 * apps/web/app/routes/prompts.tsx compatCategory).
 */
type Axis = "tools" | "papers" | "prompts";

function axisOf(category: string | null): Axis | null {
  if (!category) return null;
  if ((CATEGORY_KEYS as readonly string[]).includes(category)) return "tools";
  if ((PROMPT_CATEGORIES as readonly string[]).includes(category)) return "prompts";
  // Anything else falls through to the papers axis (arXiv primary_category). The unknown
  // category is still validated upstream by the caller, so a bogus string never reaches here.
  return "papers";
}

function asCategoryKey(c: string): CategoryKey {
  // axisOf() already confirmed this key is in CATEGORY_KEYS, so the cast is safe here. Used
  // solely to feed the strongly-typed loadTools({ category }) parameter.
  return c as CategoryKey;
}

function asPromptCategory(c: string): PromptCategory {
  // Same as asCategoryKey but for PROMPT_CATEGORIES / loadPrompts.
  return c as PromptCategory;
}

function blockFullPath(axis: Axis, category: string | null): string {
  // Same shape as each dedicated route's category= query param; /prompts already routes via
  // PROMPT_CATEGORIES, /tools via CATEGORY_KEYS, /papers via primary_category (ARXIV_PRIMARY).
  // The "查看全部 →" link uses this verbatim, so it stays bookmarkable.
  const qs = category ? `?category=${encodeURIComponent(category)}` : "";
  if (axis === "tools") return `/tools${qs}`;
  if (axis === "papers") return `/papers${qs}`;
  return `/prompts${qs}`;
}

async function loadToolsBlock(category: string | null, now: Date): Promise<DiscoverBlock<FeedItemSummary>> {
  const owned = axisOf(category) === "tools" ? asCategoryKey(category as string) : null;
  try {
    const data = await loadTools({
      channel: "all",
      category: owned,
      tag: null,
      sort: "recent",
      windowDays: DEFAULT_WINDOW_DAYS,
      limit: BLOCK_LIMIT,
      cursor: null,
      now,
    });
    return {
      items: data.items,
      appliedCategory: owned,
      fullPath: blockFullPath("tools", owned),
      empty: data.items.length === 0,
    };
  } catch {
    return { items: [], appliedCategory: null, fullPath: blockFullPath("tools", null), empty: true };
  }
}

async function loadPapersBlock(category: string | null, now: Date): Promise<DiscoverBlock<PaperSummary>> {
  const owned = axisOf(category) === "papers" ? category : null;
  try {
    const data = await loadPapers({
      category: owned,
      tag: null,
      windowDays: DEFAULT_WINDOW_DAYS,
      limit: BLOCK_LIMIT,
      cursor: null,
      now,
    });
    return {
      items: data.items,
      appliedCategory: owned,
      fullPath: blockFullPath("papers", owned),
      empty: data.items.length === 0,
    };
  } catch {
    return { items: [], appliedCategory: null, fullPath: blockFullPath("papers", null), empty: true };
  }
}

async function loadPromptsBlock(category: string | null, now: Date): Promise<DiscoverBlock<PromptCard>> {
  const owned = axisOf(category) === "prompts" ? asPromptCategory(category as string) : null;
  try {
    const data = await loadPrompts({
      category: owned,
      windowDays: DEFAULT_PROMPT_WINDOW_DAYS,
      limit: BLOCK_LIMIT,
      cursor: null,
      now,
    });
    return {
      items: data.items,
      appliedCategory: owned,
      fullPath: blockFullPath("prompts", owned),
      empty: data.items.length === 0,
    };
  } catch {
    return { items: [], appliedCategory: null, fullPath: blockFullPath("prompts", null), empty: true };
  }
}

export async function loadDiscover(q: DiscoverQuery = {}): Promise<DiscoverResponse> {
  const now = q.now ?? new Date();
  const rawCategory = q.category?.trim() || null;
  // Validate at the boundary: an unknown category returns null (no axis owns it) so the wire
  // still answers 200 with three blocks of unfiltered data rather than 4xx'ing the whole page.
  const category = rawCategory && axisOf(rawCategory) ? rawCategory : null;
  const label = category ? (CATEGORY_LABELS[category as CategoryKey] ?? null) : null;
  const [tools, papers, prompts] = await Promise.all([
    loadToolsBlock(category, now),
    loadPapersBlock(category, now),
    loadPromptsBlock(category, now),
  ]);
  return {
    category,
    categoryLabel: label,
    tools,
    papers,
    prompts,
    generatedAt: now.toISOString(),
  };
}
