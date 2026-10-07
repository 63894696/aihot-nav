-- FIX-AA-B + FIX-AA-C: two additive pieces glued into one migration so the schema ship is atomic.
--
-- (1) paper_prompts — cross-axis join between papers and prompts (W5-3 v0.2.1-#5 added the
--     parallel tool_papers join, but the prompt side was deferred because there was no usage
--     path). FIX-AA-B wires the /papers/:id "反向发现" panel — given an arxiv paper, surface
--     the prompts captured alongside it. Today's seed is empty (the worker pipeline that maintains
--     this table is a follow-up; the structural existence is what matters for the read layer).
--
-- (2) papers_archive_runs — audit table for the FIX-AA-C NDJSON archive job (every 10 days).
--     Each row records one run: when, where the file lives on disk, sha256 + bytes + record
--     count, status, and any error message. The job writes a row on success AND on failure
--     so operators can grep for past failures without scraping worker logs.

-- ============================================================================
-- (1) paper_prompts — cross-axis join between papers and prompt_items
-- ============================================================================

CREATE TABLE IF NOT EXISTS paper_prompts (
  arxiv_id    text    NOT NULL REFERENCES papers(arxiv_id)      ON DELETE CASCADE,
  prompt_id   bigint  NOT NULL REFERENCES prompt_items(id)     ON DELETE CASCADE,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (arxiv_id, prompt_id)
);

-- /papers/:id → "相关提示词" list query path: WHERE arxiv_id = $1 ORDER BY created_at DESC.
CREATE INDEX IF NOT EXISTS paper_prompts_arxiv_id_idx
  ON paper_prompts (arxiv_id, created_at DESC);

-- Inverse: a prompt's "提到的论文" list (future use). Same shape, opposite column.
CREATE INDEX IF NOT EXISTS paper_prompts_prompt_id_idx
  ON paper_prompts (prompt_id, created_at DESC);

-- Empty seed by design. The worker pipeline (FIX-AA-B follow-up) will populate rows after
-- matching papers.primary_category against prompt_items.category. The schema is the only thing
-- this migration ships — the read layer can `JOIN` against it today and return [], and the
-- /papers/:id reverse-discovery block will render an empty state until the worker fills rows.

-- ============================================================================
-- (2) papers_archive_runs — audit for the 10-day NDJSON archive job
-- ============================================================================

CREATE TABLE IF NOT EXISTS papers_archive_runs (
  id              bigserial PRIMARY KEY,
  run_at          timestamptz NOT NULL DEFAULT now(),
  file_path       text NOT NULL,
  file_sha256     text,
  bytes           bigint,
  record_count    bigint,
  status          text NOT NULL CHECK (status IN ('success', 'failed', 'local-only')),
  error_message   text
);

-- Lookup is by recency — operators check the latest run first, then scan history.
CREATE INDEX IF NOT EXISTS papers_archive_runs_run_at_idx
  ON papers_archive_runs (run_at DESC);
