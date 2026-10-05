-- awesome-copilot collector assets (Step 3.7 of code-prompts source expansion).
--
-- Why an independent table (NOT into prompt_items):
--   1. Schema gap — prompt_items.UNIQUE is (original_url) only, but awesome-copilot
--      assets are versioned by (repo, branch, slug) where the slug is the path
--      within github.com/github/awesome-copilot (e.g. "agents/code-reviewer.md"),
--      NOT a single canonical URL. The raw github URL changes whenever the file
--      moves between branches (main vs. release/*). Using (source_id, slug) as
--      the natural key matches how arxiv-fetch (papers, migration 0039) uses
--      (arxiv_id) — a canonical stable identifier that survives URL drift.
--   2. Shape gap — awesome-copilot content is 100+ line markdown with structured
--      YAML frontmatter (description / model / tools / arguments / etc.). The
--      `PromptCard` / `PromptDetail` wire schema in packages/contracts/src/site.ts
--      only carries `promptPreview` (240 chars) + `promptText` (full body). It
--      has no slot for frontmatter, no slot for the kind tag ('agent' /
--      'instruction' / 'skill'), no slot for the source's 5-axis rubric. The
--      dedicated awesome-copilot publication layer reads from this table
--      directly (mirrors how packages/backend/src/publication/papers.ts reads
--      from papers).
--   3. Lifecycle gap — prompt_items is editorial-5-axis scored (selection-score.md)
--      and the /code-prompts column gates on "is there a real reusable prompt
--      here?". awesome-copilot entries are documentation/scaffolding for code
--      generation agents, NOT single-turn reusable prompts. They belong to a
--      different category facet (`prompt-template-library` vs `prompt-instance`)
--      and would not pass scorePrompt's "single-turn reusable" filter anyway.
--
-- This table mirrors the papers (migration 0039) design:
--   - independent primary key (no FK to articles or prompt_items)
--   - source_id FK to sources(id) so admin UI shows provenance
--   - status/fail_count/translate state machine
--   - dedicated indexes for list + queue scans
--
-- Frontmatter is captured as raw jsonb (not normalized into individual cells)
-- because (a) the YAML schema varies per asset type (agents have model/tools,
-- instructions have description, skills have trigger words), and (b) we want
-- the publication layer to render the full original context verbatim.

CREATE TABLE IF NOT EXISTS copilot_assets (
  id               bigserial PRIMARY KEY,
  source_id        text NOT NULL REFERENCES sources(id),
  -- The asset's kind within awesome-copilot: 'agent' / 'instruction' / 'skill'.
  -- One per source_id row (we run three external-awesome-copilot-{agents,
  -- instructions,skills} sources, each writes only its own asset_kind).
  asset_kind       text NOT NULL CHECK (asset_kind IN ('agent', 'instruction', 'skill')),
  -- Path within github.com/github/awesome-copilot, e.g. "agents/code-reviewer.md".
  -- Stable across commit hashes and branch names — that's the whole point of
  -- using slug over original_url for the UNIQUE constraint.
  slug             text NOT NULL,
  -- Original filename only (e.g. "code-reviewer.md"), derived from slug for
  -- ergonomic display. The full slug is the canonical join key.
  filename         text NOT NULL,
  -- Raw frontmatter parsed from the markdown file (YAML → JSON). Awesome-copilot
  -- frontmatter fields: description, model, tools, arguments (agents only),
  --               applyTo, excludeAgent, tools (instructions only),
  --               display_name, description (skills only).
  -- Stored as jsonb so future filter UI can pivot by `description->>'model'` etc.
  frontmatter      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Full markdown body (frontmatter stripped). May be 100+ lines for detailed
  -- agents; the publication layer renders this verbatim in the detail page.
  body_md          text NOT NULL,
  -- GitHub raw URL at fetch time. The URL itself is NOT the canonical key —
  -- it's recorded for deep-link provenance only. URL drift across commit hashes
  -- / branches does NOT trigger a re-insert (UNIQUE constraint is on slug).
  raw_url          text NOT NULL,
  -- GitHub commit SHA at fetch time. When this changes we know the asset was
  -- updated upstream; the worker uses it as a cheap 'should I re-fetch?' hint
  -- before doing the full body_md diff.
  commit_sha       text,
  -- The blob SHA of the file itself (different from commit_sha — file may move
  -- between commits without changing). Empty string allowed for repos without
  -- a public tree API.
  blob_sha         text,
  size_bytes       int,
  -- Repository slug (e.g. "github/awesome-copilot"). Stable per source_id, but
  -- recorded for deep-link provenance.
  repo_slug        text NOT NULL DEFAULT 'github/awesome-copilot',
  default_branch   text NOT NULL DEFAULT 'main',
  status           text NOT NULL DEFAULT 'fetched'
    CHECK (status IN ('fetched', 'analyzing', 'indexed', 'failed')),
  fail_count       int  NOT NULL DEFAULT 0,
  last_error       text,
  fetched_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Composite UNIQUE: (source_id, slug) — the natural key. See header §1.
  -- Mirrors how papers (arxiv_id PK) and prompt_items (original_url UNIQUE)
  -- each pick the most-stable identifier available.
  UNIQUE (source_id, slug)
);

-- /code-prompts list default order: newest first within an asset_kind.
-- Mirrors papers_published_at_idx (0039) and prompt_items_category_idx (0042).
CREATE INDEX IF NOT EXISTS copilot_assets_kind_idx
  ON copilot_assets (asset_kind, fetched_at DESC);

-- Top-level /code-prompts list (no asset_kind filter): newest first.
CREATE INDEX IF NOT EXISTS copilot_assets_fetched_at_idx
  ON copilot_assets (fetched_at DESC);

-- Worker queue scan: sources with status in 'fetched' (just-arrived, needs
-- analyze pass) or 'failed' (re-try eligible). Mirrors papers_translate_idx.
CREATE INDEX IF NOT EXISTS copilot_assets_analyze_pending_idx
  ON copilot_assets (status, fetched_at)
  WHERE status IN ('fetched', 'failed');

-- Source-level stats query for the admin UI ("how many assets per source").
-- Composite index because the typical query is `SELECT count(*), source_id FROM
-- copilot_assets GROUP BY source_id` after a refresh.
CREATE INDEX IF NOT EXISTS copilot_assets_source_idx
  ON copilot_assets (source_id, asset_kind);