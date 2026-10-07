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
  DiscoverTriple,
  FeedItemSummary,
  PaperSummary,
  PromptCard,
} from "@aihot/contracts/site";
import {
  PROMPT_CATEGORIES,
  type PromptCategory,
} from "@aihot/contracts/site";
import { CATEGORY_KEYS, CATEGORY_LABELS, CHANNEL_KEYS, CHANNEL_LABELS, type CategoryKey, type ChannelKey } from "@aihot/contracts/taxonomy";
import { sql } from "../db.ts";
import { loadPrompts } from "./prompts.ts";
import { loadPapers } from "./papers.ts";
import { loadTools } from "./tools.ts";
import { toFeedItemSummary, type ItemRow } from "./items.ts";
import { toPaperSummary, type PaperRow } from "./papers.ts";
import { readPromptMeta, type PromptRow } from "./prompts.ts";

const BLOCK_LIMIT = 6;
const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_PROMPT_WINDOW_DAYS = 90;

export interface DiscoverQuery {
  category?: string | null;
  /** Channel filter forwarded from /all — only the "label" surfaces on the wire here; the
   *  underlying loadTools/loadPapers/loadPrompts calls keep their default `channel: "all"`
   *  semantics because the three-column discovery teaser is meant to stay unfiltered by channel.
   *  We need it echoed back so the UI can prefix the section heading ("一手 · 工具·提示词·论文
   *  三栏速览") when the user lands on /all?channel=firstParty without a category. */
  channel?: string | null;
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

// ============================================================================
// FIX-AA.4 — /all 三角联动 trial entry
// ============================================================================
//
// Given an optional category, return up to TRIPLE_LIMIT triples of the form (paper, tool, prompt)
// where the three nodes share an arxiv_id through the tool_papers + paper_prompts join tables.
// The wire shape mirrors the canonical /tools, /papers, /prompts card surfaces so the trial card
// can render three independent Links without extra shaping.
//
// Today (2026-10-07) the join tables are empty, so loadDiscoverTriples returns []. The section
// on /all renders as hidden until a future worker job (FIX-AA follow-up) populates paper_prompts
// for the highly-linked papers. Shipping the API + UI now means no rewiring when data lands.
//
// Best-effort: a SQL throw inside loadDiscoverTriples returns [] — a join-table outage must
// never 500 the home page. (Lesson 13c: each reverse-discovery surface tries/catches independently
// and the wire shape always carries all keys so the UI can degrade to empty.)
//
// Category routing: only the papers axis owns an arxiv_id-bearing category; we narrow with
// `axisOf(category) === "papers"` so a /all?category=writing URL doesn't filter the triples
// section at all (the writing taxonomy doesn't reach tool_papers).
const TRIPLE_LIMIT = 6;

export async function loadDiscoverTriples(category: string | null, now: Date): Promise<DiscoverTriple[]> {
  void now;
  const categoryClause = category && axisOf(category) === "papers" ? sql`AND pap.primary_category = ${category}` : sql``;
  try {
    // Two CTEs + one SELECT — same SQL runtime as a flat 3-table join. The ROW_NUMBER keeps the
    // most recent prompt for each (article_id, arxiv_id) thread so the triple is deterministic
    // even when paper_prompts has multiple rows for the same paper.
    const rows = await sql<Array<{
      // paper fields
      arxiv_id: string; title_en: string; title_zh: string | null; abstract_en: string;
      abstract_zh: string | null; authors: string[]; primary_category: string;
      published_at: Date; abs_url: string; status: PaperSummary["status"];
      // tool fields — gated by p.discovered_at IS NOT NULL + visibility='public' + indexable=true,
      // so column nullability matches the post-gate ItemRow shape (no need for `| null` on gated fields).
      tool_id: string; tool_revision: number; tool_title: string; tool_original_title: string | null;
      tool_summary: string | null; tool_reason: string | null; tool_category: string | null;
      tool_tags: string[]; tool_score: number | null; tool_selected: boolean; tool_eligible: boolean;
      tool_channel: "news" | "x"; tool_url: string; tool_published_at: Date | null;
      tool_discovered_at: Date; tool_timeline_at: Date; tool_sort_at: Date; tool_first_party: boolean;
      tool_visibility: string; tool_body_mode: "full" | "summary"; tool_syndicate: boolean; tool_indexable: boolean;
      tool_visible_after: Date | null; tool_backfill: boolean;
      tool_fact_id: number | null; tool_story_id: number | null;
      tool_source_id: string; tool_source_name: string; tool_source_kind: string;
      tool_source_mode: string; tool_source_icon: string | null;
      tool_x_post: Record<string, unknown> | null; tool_author: string | null; tool_language: string | null;
      tool_article_raw: Record<string, unknown> | null;
      tool_story_public_id: string | null; tool_story_title: string | null;
      tool_zh_text: string | null; tool_quoted_zh: string | null;
      // prompt fields (joined column set mirrors loadPaperRelatedPrompts / readPromptMeta)
      prompt_id: number; prompt_article_id: string | null; prompt_original_url: string;
      prompt_original_post_id: string | null; prompt_community: string; prompt_category: string;
      prompt_text: string; prompt_use_case: string | null; prompt_language: string;
      prompt_source_kind: string; prompt_captured_at: Date; prompt_updated_at: Date;
    }>>`
      WITH thread_keys AS (
        SELECT tp.article_id, tp.arxiv_id
        FROM tool_papers tp
        JOIN publications p ON p.article_id = tp.article_id
        WHERE p.discovered_at IS NOT NULL
          AND p.visibility = 'public'
          AND p.indexable = true
      ),
      thread_with_prompt AS (
        SELECT tk.article_id, tk.arxiv_id, pp.prompt_id,
               ROW_NUMBER() OVER (PARTITION BY tk.article_id, tk.arxiv_id ORDER BY pp.created_at DESC) AS rn
        FROM thread_keys tk
        JOIN paper_prompts pp ON pp.arxiv_id = tk.arxiv_id
      )
      SELECT
        pap.arxiv_id, pap.title_en, pap.title_zh, pap.abstract_en, pap.abstract_zh,
        pap.authors, pap.primary_category, pap.published_at, pap.abs_url, pap.status,
        p.article_id AS tool_id, p.revision AS tool_revision, p.title AS tool_title,
        p.original_title AS tool_original_title, p.summary AS tool_summary,
        p.reason AS tool_reason, p.category AS tool_category, p.tags AS tool_tags,
        p.score AS tool_score, p.selected AS tool_selected, p.eligible AS tool_eligible,
        p.channel AS tool_channel, p.url AS tool_url, p.published_at AS tool_published_at,
        p.discovered_at AS tool_discovered_at, p.timeline_at AS tool_timeline_at,
        p.sort_at AS tool_sort_at, p.first_party AS tool_first_party,
        p.visibility AS tool_visibility, p.body_mode AS tool_body_mode,
        p.syndicate AS tool_syndicate, p.indexable AS tool_indexable,
        p.visible_after AS tool_visible_after, p.backfill AS tool_backfill,
        p.fact_id AS tool_fact_id, p.story_id AS tool_story_id,
        s.id AS tool_source_id, s.name AS tool_source_name, s.kind AS tool_source_kind,
        s.participation_mode AS tool_source_mode, s.icon_url AS tool_source_icon,
        a.x_post AS tool_x_post, a.author AS tool_author, a.language AS tool_language,
        a.raw AS tool_article_raw,
        st.public_id::text AS tool_story_public_id, st.title AS tool_story_title,
        CASE WHEN p.channel = 'x' THEN tr.body_text END AS tool_zh_text,
        qt.text_zh AS tool_quoted_zh,
        pi.id AS prompt_id, pi.article_id AS prompt_article_id,
        pi.original_url AS prompt_original_url, pi.original_post_id AS prompt_original_post_id,
        pi.community AS prompt_community, pi.category AS prompt_category,
        pi.prompt_text AS prompt_text, pi.use_case AS prompt_use_case,
        pi.language AS prompt_language, pi.source_kind AS prompt_source_kind,
        pi.captured_at AS prompt_captured_at, pi.updated_at AS prompt_updated_at
      FROM thread_with_prompt twp
      JOIN papers pap ON pap.arxiv_id = twp.arxiv_id
      JOIN publications p ON p.article_id = twp.article_id
      JOIN sources s ON s.id = p.source_id
      JOIN articles a ON a.id = p.article_id
      LEFT JOIN stories st ON st.id = p.story_id AND st.merged_into IS NULL
      LEFT JOIN translations tr ON tr.article_id = p.article_id AND tr.lang = 'zh' AND tr.revision >= a.revision
      LEFT JOIN quote_translations qt ON p.channel = 'x' AND qt.tweet_id = substring(a.x_post->'quoted'->>'url' from '/status/([0-9]+)')
      JOIN prompt_items pi ON pi.id = twp.prompt_id
      WHERE twp.rn = 1
        AND p.discovered_at IS NOT NULL
        AND p.visibility = 'public'
        AND p.indexable = true
        ${categoryClause}
      ORDER BY pap.published_at DESC, twp.arxiv_id DESC
      LIMIT ${TRIPLE_LIMIT}`;

    return rows.map((r): DiscoverTriple | null => {
      const paper: PaperRow = {
        arxiv_id: r.arxiv_id, title_en: r.title_en, title_zh: r.title_zh,
        abstract_en: r.abstract_en, abstract_zh: r.abstract_zh, authors: r.authors,
        primary_category: r.primary_category, published_at: r.published_at,
        abs_url: r.abs_url, status: r.status,
      };
      const tool: ItemRow = {
        id: r.tool_id, revision: r.tool_revision, title: r.tool_title,
        original_title: r.tool_original_title, summary: r.tool_summary,
        reason: r.tool_reason, category: r.tool_category, tags: r.tool_tags,
        score: r.tool_score, selected: r.tool_selected, eligible: r.tool_eligible,
        channel: r.tool_channel, url: r.tool_url, published_at: r.tool_published_at,
        discovered_at: r.tool_discovered_at, timeline_at: r.tool_timeline_at,
        sort_at: r.tool_sort_at, first_party: r.tool_first_party,
        visibility: r.tool_visibility as ItemRow["visibility"], body_mode: r.tool_body_mode,
        syndicate: r.tool_syndicate, indexable: r.tool_indexable,
        visible_after: r.tool_visible_after, backfill: r.tool_backfill,
        fact_id: r.tool_fact_id, story_id: r.tool_story_id,
        source_id: r.tool_source_id, source_name: r.tool_source_name,
        source_kind: r.tool_source_kind as ItemRow["source_kind"], source_mode: r.tool_source_mode,
        source_icon: r.tool_source_icon, x_post: r.tool_x_post,
        author: r.tool_author, language: r.tool_language, article_raw: r.tool_article_raw,
        story_public_id: r.tool_story_public_id, story_title: r.tool_story_title,
        zh_text: r.tool_zh_text, quoted_zh: r.tool_quoted_zh,
      };
      const prompt: PromptRow = {
        id: r.prompt_id, article_id: r.prompt_article_id,
        original_url: r.prompt_original_url, original_post_id: r.prompt_original_post_id,
        community: r.prompt_community, category: r.prompt_category,
        prompt_text: r.prompt_text, use_case: r.prompt_use_case,
        language: r.prompt_language, source_kind: r.prompt_source_kind,
        captured_at: r.prompt_captured_at, updated_at: r.prompt_updated_at,
      };
      // readPromptMeta can return null for malformed categories — drop the triple in that case
      // so a single bad row doesn't blank the whole section.
      const promptCard = readPromptMeta(prompt);
      if (!promptCard) return null;
      return { paper: toPaperSummary(paper), tool: toFeedItemSummary(tool), prompt: promptCard };
    }).filter((x): x is DiscoverTriple => x !== null);
  } catch {
    return [];
  }
}

export async function loadDiscover(q: DiscoverQuery = {}): Promise<DiscoverResponse> {
  const now = q.now ?? new Date();
  const rawCategory = q.category?.trim() || null;
  // Validate at the boundary: an unknown category returns null (no axis owns it) so the wire
  // still answers 200 with three blocks of unfiltered data rather than 4xx'ing the whole page.
  const category = rawCategory && axisOf(rawCategory) ? rawCategory : null;
  const label = category ? (CATEGORY_LABELS[category as CategoryKey] ?? null) : null;
  // Channel echo: same boundary-validation philosophy — an unknown channel key is normalised
  // to "all" so the wire always carries a valid ChannelKey (or null). The label maps "all" to
  // "全部", which would render as a noisy prefix on the section heading; we suppress it by
  // returning null when the resolved channel is "all" — the UI then falls back to categoryLabel
  // and finally to the bare heading, matching the unfiltered landing behaviour.
  const rawChannel = q.channel?.trim() || null;
  const channel: ChannelKey | null = rawChannel && (CHANNEL_KEYS as readonly string[]).includes(rawChannel)
    ? (rawChannel as ChannelKey)
    : null;
  const channelLabel: string | null = channel && channel !== "all" ? CHANNEL_LABELS[channel] : null;
  const [tools, papers, prompts, triples] = await Promise.all([
    loadToolsBlock(category, now),
    loadPapersBlock(category, now),
    loadPromptsBlock(category, now),
    loadDiscoverTriples(category, now),
  ]);
  return {
    category,
    categoryLabel: label,
    channel,
    channelLabel,
    tools,
    papers,
    prompts,
    triples,
    generatedAt: now.toISOString(),
  };
}
