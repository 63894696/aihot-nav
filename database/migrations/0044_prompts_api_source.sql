-- W5-3 v0.2.1-#7: zero-budget search engine virtual source for the prompts column. Same pattern as
-- migration 0041 (search-api-virtual) but scoped to industry/search-queries.json prompt-* entries
-- and writing to prompt_items (not articles). The orchestrator (apps/worker/src/jobs/prompt-fetch.ts)
-- iterates a fixed query list and writes extracted prompts with source_kind='searxng_search' on
-- the prompt_items row. The row below is the FK-less source identity — prompt_items does not
-- FK to sources (it has its own source_kind text column), but the worker still needs a row so
-- (a) the admin UI can show "Prompts Search" as a feed source for ops visibility, and (b) the
-- orchestrator can persist its SearXNG round-robin cursor and rate-limit window via the same
-- sources.cursor JSON column pattern.
--
-- participation_mode='hot_signal' mirrors search-api-virtual: the prompt-score gate already
-- filters for "is there a real reusable prompt here?", so we do NOT run the editorial 5-axis
-- re-score on prompts. tier=T2 (mixed signal of SearXNG instances); site_fulltext is irrelevant
-- for this row because it does not feed the article pipeline.
ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_kind_check;
ALTER TABLE sources ADD  CONSTRAINT sources_kind_check
  CHECK (kind IN ('rss', 'web_list', 'json_list', 'x_search', 'mp_account', 'external', 'search_api', 'prompts_api'));

INSERT INTO sources (id, name, kind, config, tier, first_party, participation_mode, interval_minutes,
                     site_fulltext, syndicate_fulltext, enabled, next_fetch_at)
VALUES ('prompts-api-virtual', 'Prompts Search (SearXNG)', 'prompts_api',
        '{"queryFile":"industry/search-queries.json","queryPrefix":"prompt-"}',
        'T2', false, 'hot_signal', 60, false, false, true, now())
ON CONFLICT (id) DO NOTHING;
