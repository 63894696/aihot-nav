-- W5-3 prompts collection: prompt_items table + source_comments sub-table + articles.type column.
-- Additive only — new tables are IF NOT EXISTS, the articles.type column is ADD COLUMN IF NOT EXISTS
-- nullable (no NOT NULL, no DEFAULT) so existing rows keep working and no constraint can break
-- older code paths that don't know about the new field.
--
-- Why three objects:
--   1. prompt_items: one row per prompt we collect. original_url is unique so the same community
--      post won't double-import. category is a free-text key in the prompt space (writing / 绘画 /
--      学习 / 调研 / 设计) — surfaced verbatim by /api/site/prompts?category= and indexed below.
--   2. source_comments: comments from the original web page, fetched once at capture time. We
--      snapshot fetch_status so a later failure can be distinguished from "never tried" (default
--      'ok' on insert; 'failed' / 'timeout' are set by fetchOriginalComments when something goes
--      wrong — see packages/backend/src/sources/comments.ts).
--   3. articles.type: nullable discriminator so future publication code can branch on the prompt
--     type without joining prompt_items for every row. Existing rows get NULL, which means
--     "article" everywhere.

CREATE TABLE IF NOT EXISTS prompt_items (
  id               bigserial PRIMARY KEY,
  article_id       text REFERENCES articles(id) ON DELETE CASCADE,
  original_url     text NOT NULL,
  original_post_id text,
  community        text NOT NULL,
  category         text NOT NULL,
  prompt_text      text NOT NULL,
  use_case         text,
  language         text NOT NULL DEFAULT 'en',
  source_kind      text NOT NULL,
  captured_at      timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (original_url)
);

-- /prompts list default order: newest first within a category.
CREATE INDEX IF NOT EXISTS prompt_items_category_idx
  ON prompt_items (category, captured_at DESC);
-- Top-level /prompts list (no category) sorts by captured_at only.
CREATE INDEX IF NOT EXISTS prompt_items_captured_at_idx
  ON prompt_items (captured_at DESC);

CREATE TABLE IF NOT EXISTS source_comments (
  id             bigserial PRIMARY KEY,
  prompt_item_id bigint NOT NULL REFERENCES prompt_items(id) ON DELETE CASCADE,
  author_name    text,
  body           text NOT NULL,
  posted_at      timestamptz,
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  fetch_status   text NOT NULL DEFAULT 'ok'
    CHECK (fetch_status IN ('ok', 'failed', 'timeout'))
);

-- Comment list order: oldest first within a prompt so the conversation reads top-down.
CREATE INDEX IF NOT EXISTS source_comments_prompt_item_idx
  ON source_comments (prompt_item_id, posted_at);

ALTER TABLE articles ADD COLUMN IF NOT EXISTS type text;
CREATE INDEX IF NOT EXISTS articles_type_idx ON articles (type) WHERE type IS NOT NULL;
