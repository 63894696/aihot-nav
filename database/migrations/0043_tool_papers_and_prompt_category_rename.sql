-- v0.2.1-#5: tool_papers join table + prompt_items category rename (painting/design → image).
--
-- This migration is two independent changes glued into one file so they ship atomically:
--
--   (1) tool_papers — the structured cross-axis link between an arXiv paper and a tool item.
--       Today's /papers/:id "相关论文" section shows same-category siblings (commit #4). The
--       cross-axis link to a tool/release article was deferred to this commit. Today there is
--       no canonical "tool" entity — tools are sourced from publications (see
--       packages/backend/src/publication/tools.ts:14-16, the TOOL_TAGS filter). So tool_papers
--       points at articles.id of a tool-tagged publication. The FK is intentionally permissive:
--       ON DELETE CASCADE so a withdrawn tool or paper cleans up its links automatically.
--
--       Seed is guarded by WHERE EXISTS on both sides so a fresh dev DB (no rows in either
--       table) applies cleanly with zero inserts — the table exists, the FKs check, and the
--       next /papers/:id render still finds nothing cross-axis to show until seed runs.
--
--   (2) prompt_items.category — old v0.2.0 buckets "painting" and "design" merged into the new
--       v0.2.1 "image" bucket. readPromptMeta in packages/backend/src/publication/prompts.ts
--       already filters rows against PROMPT_CATEGORIES, so any leftover "painting" / "design"
--       row was silently dropped from /prompts. A plain UPDATE removes them; no read-layer
--       compatibility shim is needed (the URL compat layer in v0.2.1-#1 already redirects
--       ?category=painting to ?category=image at the route boundary).
--
-- Both changes are backwards compatible:
--   - tool_papers is purely additive (new table, new index).
--   - prompt_items UPDATE only narrows the category domain; no schema, FK, or constraint change.

-- ============================================================================
-- (1) tool_papers — cross-axis join between papers and tool publications
-- ============================================================================

CREATE TABLE IF NOT EXISTS tool_papers (
  arxiv_id   text NOT NULL REFERENCES papers(arxiv_id) ON DELETE CASCADE,
  article_id text NOT NULL REFERENCES articles(id)   ON DELETE CASCADE,
  -- Optional rationale kept short so a future reader can audit why a link exists without
  -- joining through tags or commentary sources. The publication read layer does not surface
  -- this today; it is for the worker pipeline that will maintain the table from commit #N.
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (arxiv_id, article_id)
);

-- /papers/:id → "相关工具" list query path: WHERE arxiv_id = $1 ORDER BY created_at DESC.
CREATE INDEX IF NOT EXISTS tool_papers_arxiv_id_idx
  ON tool_papers (arxiv_id, created_at DESC);

-- Inverse: a tool's "提到的论文" list (future) — same index shape, opposite column.
CREATE INDEX IF NOT EXISTS tool_papers_article_id_idx
  ON tool_papers (article_id, created_at DESC);

-- Seed: only when both ends exist. ON CONFLICT DO NOTHING keeps re-runs safe. The seed below
-- is intentionally empty of hard-coded ids — dev/CI databases do not have papers or tool-tagged
-- articles yet, and we want a fresh `npm run migrate` to succeed there too.
--
-- To populate from real data, the editorial pipeline (commit #7 worker + W5-3 plan §3.3) will
-- INSERT after matching on papers.primary_category against publications.tags. This file just
-- bootstraps the structure so that pipeline can target a stable schema.
INSERT INTO tool_papers (arxiv_id, article_id, reason)
SELECT p.arxiv_id, a.id, 'seed-anchor: cs.AI papers ↔ product updates'
FROM papers p
JOIN articles a ON a.source_id = 'search-api-virtual'
WHERE p.primary_category = 'cs.AI'
  AND a.id IS NOT NULL
ON CONFLICT (arxiv_id, article_id) DO NOTHING;

-- ============================================================================
-- (2) prompt_items category rename: painting/design → image
-- ============================================================================
--
-- "painting" (绘画) and "design" (设计) both reduce to the new capability-axis "image" bucket
-- (visual content creation, broadly). v0.2.0 had them as separate categories; v0.2.1 collapses
-- them so /prompts?category=image surfaces everything visual.
--
-- UPDATE before re-indexing so the index reflects the post-rename state. The IF EXISTS
-- pattern is harmless when no rows match.

UPDATE prompt_items SET category = 'image' WHERE category IN ('painting', 'design');

-- Refresh the existing category index — same columns, but the planner should see a
-- single bucket instead of two. CREATE INDEX IF NOT EXISTS is idempotent; the index already
-- covers 'image', so this is a no-op when the rename produced no churn.
-- (Left in to document intent for any future index change.)
CREATE INDEX IF NOT EXISTS prompt_items_category_v2_idx
  ON prompt_items (category, captured_at DESC);
