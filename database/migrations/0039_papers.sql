-- Papers from arXiv topic feeds (cs.AI / cs.CL / cs.LG / cs.CV / cs.RO).
-- One row per arxiv_id (the canonical key, e.g. "2601.12345"). The title/abstract/key points in
-- the response come from the LLM-translated columns when status='translated', otherwise the raw
-- English. fetched_at advances when the feed shows the paper again (re-submission notice).
CREATE TABLE IF NOT EXISTS papers (
  arxiv_id          text PRIMARY KEY,
  title_en          text NOT NULL,
  title_zh          text,
  abstract_en       text NOT NULL,
  abstract_zh       text,
  key_points        text[],
  authors           text[] NOT NULL,
  primary_category  text NOT NULL,
  categories        text[] NOT NULL,
  pdf_url           text NOT NULL,
  abs_url           text NOT NULL,
  source_id         text NOT NULL REFERENCES sources(id),
  published_at      timestamptz NOT NULL,
  fetched_at        timestamptz NOT NULL DEFAULT now(),
  translated_at     timestamptz,
  status            text NOT NULL DEFAULT 'fetched' CHECK (status IN ('fetched','translating','translated','partial','failed')),
  fail_count        int  NOT NULL DEFAULT 0,
  summary_model     text,
  summary_attempt   int  NOT NULL DEFAULT 0
);

-- List endpoint primary order: newest by published_at.
CREATE INDEX IF NOT EXISTS papers_published_at_idx ON papers (published_at DESC);
-- Worker queue scan: pending translations, oldest first.
CREATE INDEX IF NOT EXISTS papers_translate_pending_idx ON papers (status, published_at) WHERE status IN ('fetched','partial','failed');
-- Category filter for /papers?category=cs.AI
CREATE INDEX IF NOT EXISTS papers_primary_category_idx ON papers (primary_category, published_at DESC);
