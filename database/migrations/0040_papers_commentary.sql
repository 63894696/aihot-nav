-- Papers: Hugging Face community metrics + external community interpretation sources.
-- Additive only — purely ADD COLUMN IF NOT EXISTS + new indexes. No backfill (HF upvotes are an
-- external signal that is null until papers-hf-sync runs; commentary columns are null until the
-- GitHub mapping jobs in Sprint B fill them in).
--
-- commentary_source uses a short slug (kept in sync with the 5 sources listed in /papers
-- sidebar): 'dair-ai' | 'zhaoyang97' | 'km1994' | 'kitsumiko' | 'huggingface'. The detail
-- page renders the friendly name + GitHub URL; this column is the machine-readable key.
ALTER TABLE papers
  ADD COLUMN IF NOT EXISTS commentary_md_url    text,
  ADD COLUMN IF NOT EXISTS commentary_source    text,
  ADD COLUMN IF NOT EXISTS hf_paper_id          text,
  ADD COLUMN IF NOT EXISTS hf_upvotes           int     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hf_comments          int     NOT NULL DEFAULT 0;

-- /papers list default ORDER BY:
--   1) translated first (status='translated' before anything else, so the reader sees
--      finished translations regardless of arxiv age)
--   2) HF upvotes desc (when both are translated, prefer the paper the community upvoted)
--   3) published_at desc (tie-break by recency).
-- A partial index on the translated-first + recency prefix keeps the sort cheap; the
-- COALESCE(hf_upvotes,0) second sort uses a smaller secondary index that the planner can
-- combine with the partial one. We add two indexes instead of one composite so each phase
-- is cheap.
CREATE INDEX IF NOT EXISTS papers_translated_first_idx
  ON papers ((CASE WHEN status = 'translated' THEN 0 ELSE 1 END), published_at DESC);

CREATE INDEX IF NOT EXISTS papers_hf_upvotes_idx
  ON papers (hf_upvotes DESC NULLS LAST, published_at DESC);
