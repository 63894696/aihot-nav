// awesome-copilot contracts — wire shape for the /api/site/awesome-copilot/{list,detail}
// read layer (publication/awesome-copilot.ts).
//
// Three asset kinds — `agent` / `instruction` / `skill` — one entry per source_id row in
// industry/sources.json (`external-awesome-copilot-{agents,instructions,skills}`). The asset
// kind is the natural filter facet; there is no editorial taxonomy on top.
//
// Why a dedicated wire shape (NOT reusing PromptCard / PaperSummary):
//   1. Cards have a "use this prompt" affordance; awesome-copilot assets are scaffolding for
//      code-gen agents, not single-turn reusable prompts — the UI affordance is "copy this
//      entire file into your project's .github/ directory".
//   2. frontmatter jsonb is the asset's distinguishing field; PromptCard has no slot for it
//      and adding one would dilute the contract.
//   3. Source-of-truth for slug stability (slug is the (source_id, slug) UNIQUE key, NOT the
//      raw_url) — same shape discipline as `arxiv_id` on `PaperSummary`.

export type CopilotAssetKind = "agent" | "instruction" | "skill";

export const COPILOT_ASSET_KINDS: readonly CopilotAssetKind[] = [
  "agent",
  "instruction",
  "skill",
] as const;

export const COPILOT_ASSET_KIND_LABELS: Record<CopilotAssetKind, string> = {
  agent: "Agent",
  instruction: "Instruction",
  skill: "Skill",
};

/** One-line guide for the worker and the admin dropdown: how to bucket borderline rows. */
export const COPILOT_ASSET_KIND_GUIDES: Record<CopilotAssetKind, string> = {
  agent: "Code-gen agent with tools + model + handoffs (lives in agents/)",
  instruction: "Apply-on-save / chat-mode behavior added to a project's instruction set",
  skill: "Reusable skill with trigger words that an agent loads on demand",
};

/** Wire shape used by the list view and the per-card render. */
export interface CopilotAssetSummary {
  /** Composite id `{source_id}::{slug}` so the list → detail nav stays stable across rows. */
  id: string;
  /** Asset kind within awesome-copilot. Drives the card variant + the filter chip row. */
  assetKind: CopilotAssetKind;
  /** Path within github.com/github/awesome-copilot (e.g. "agents/code-reviewer.agent.md"). */
  slug: string;
  /** Original filename only (e.g. "code-reviewer.agent.md"). */
  filename: string;
  /** Captured frontmatter fields rendered as a flat key→value map. `description` is the
   *  "what does this do?" line used on the card; other fields (model / tools / display_name)
   *  surface as a small metadata strip. The publication layer collapses nested blocks into a
   *  single string — the raw `frontmatter` jsonb is not exposed here. */
  frontmatter: Record<string, unknown>;
  /** First 240 chars of body_md — the card teaser. */
  bodyPreview: string;
  /** GitHub raw URL at fetch time. */
  rawUrl: string;
  fetchedAt: string;
  updatedAt: string;
}

export interface CopilotAssetDetail extends CopilotAssetSummary {
  /** Full markdown body (frontmatter stripped). May be 100+ lines for detailed agents. */
  bodyMd: string;
  /** repo_slug (e.g. "github/awesome-copilot"); recorded for deep-link provenance. */
  repoSlug: string;
  defaultBranch: string;
  blobSha: string | null;
  sizeBytes: number | null;
  status: "fetched" | "analyzing" | "indexed" | "failed";
  /** Optional per-locale translations from `copilot_translations` (FIX-T, 2026-10-06).
   *  Map shape: `{ [locale]: CopilotTranslation }`. Missing locales mean the worker has
   *  not translated that locale yet (or marked it failed permanently). UI falls back to
   *  the English frontmatter.description when a locale is absent. */
  translations: Partial<Record<"zh" | "en", CopilotTranslation>>;
}

export interface CopilotAssetFilters {
  kind: CopilotAssetKind | null;
}

export interface CopilotAssetsQuery {
  kind?: CopilotAssetKind | null;
  cursor?: string | null;
  limit?: number;
  now?: Date;
}

export interface CopilotAssetsResponse {
  filters: CopilotAssetFilters;
  items: CopilotAssetSummary[];
  nextCursor: string | null;
  refreshAt: string | null;
  generatedAt: string;
}

/**
 * One translated text bundle (zh / en) for an awesome-copilot asset.
 *
 * FIX-T (2026-10-06): the worker (`code-prompts.fetch_translations`) translates
 * frontmatter->>'description' + a derived title (currently the filename without
 * the .md suffix). `body_md` is intentionally NOT translated — see
 * `database/migrations/0050_copilot_translations.sql` for the decision rationale.
 *
 * `fields` is reserved for future field-level translations (applyTo arrays,
 * handoffs). Today it's always `{}`. Detail page renders the row as
 * "title + description" only and never inspects `fields`.
 */
export interface CopilotTranslation {
  locale: "zh" | "en";
  title: string;
  /** NULL when the upstream frontmatter has no description key (legacy assets). */
  description: string | null;
  fields: Record<string, unknown>;
  model: string | null;
  status: "translated" | "partial" | "failed";
}