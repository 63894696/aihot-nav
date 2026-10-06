-- W5-3 FIX-X (commentary pipeline): papers.commentary_status + skipped_reason.
--
-- Why additive only:
--   1. Migration 0040 already added `commentary_md_url text` + `commentary_source text` —
--      those columns are the *output* of the commentary pipeline (where the .md lives, who
--      authored it). 0040 was written speculatively; the pipeline was never wired. This
--      migration adds the *lifecycle* state that the pipeline needs to know what to do next
--      for each paper (skip / generate / publish).
--   2. commentary_status enum:
--        pending   — paper translated but commentary not attempted yet. Default for every
--                    translated row that doesn't yet have commentary_md_url. The local
--                    commentary-gen CLI picks these up.
--        published — commentary_md_url is set and the front-end should render the section.
--        skipped   — explicitly opted out by the human in the CLI. Records the reason in
--                    skipped_reason so we don't re-prompt next cycle.
--      No CHECK on the wire — we keep status as free text and validate in the publication
--      read layer (mirrors papers.status which is also free text — see 0001_core.sql).
--   3. skipped_reason: short free text (max ~120 chars). Examples:
--        "未达 7-level skeleton 阈值: paper 太短 (abstract 87 chars)"
--        "与 paradigm-radar 不匹配: 缺第二个独立信号"
--        "human 审稿后认为不适合 micropaper"
--      We don't enum this — the human's reason is data we shouldn't pre-bucket.
--   4. commentary_updated_at: when status last flipped. Used by the CLI to scope a re-run
--      without re-touching every translated paper.
--
-- Wire scope (decided 2026-10-06):
--   - status default 'pending' for any translated paper that lacks commentary_md_url.
--   - status default NULL (not 'pending') for fetched / failed / translating papers — the
--     CLI only acts on translated papers, so leaving NULL avoids confusing dashboards.
--   - No backfill of existing rows: pre-existing commentary_md_url rows keep whatever
--     status the publication layer infers ("published" if md url present, else untouched).

ALTER TABLE papers
  ADD COLUMN IF NOT EXISTS commentary_status     text
    CHECK (commentary_status IS NULL OR commentary_status IN ('pending', 'published', 'skipped')),
  ADD COLUMN IF NOT EXISTS commentary_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS skipped_reason        text;

-- Backfill: translated rows with a published commentary stay published; translated rows
-- without commentary become pending; everything else stays NULL.
-- This is a one-shot backfill — re-runnable safely because UPDATE ... WHERE keeps the same
-- state when the value is already correct.
UPDATE papers
   SET commentary_status     = CASE
                                  WHEN commentary_md_url IS NOT NULL THEN 'published'
                                  WHEN translated_at IS NOT NULL      THEN 'pending'
                                  ELSE NULL
                                END,
       commentary_updated_at = COALESCE(commentary_updated_at, translated_at, fetched_at)
 WHERE commentary_status IS NULL;

-- /commentary queue scan: translated papers that haven't been attempted yet.
-- Partial index — only the pending slice matters to the worker / CLI.
CREATE INDEX IF NOT EXISTS papers_commentary_pending_idx
  ON papers (translated_at DESC)
  WHERE commentary_status = 'pending';
