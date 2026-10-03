-- W5-2: zero-budget search engine query API source. The collectors (SearXNG / HN Algolia / GitHub
-- Trending) do not have a per-source URL to poll like RSS does; the orchestrator (apps/worker/src
-- jobs/search-fetch.ts) iterates a fixed query list and writes candidates into `articles` with
-- source_id = 'search-api-virtual'. The row below is the FK target for that insert; the source
-- is treated as one virtual source even though the candidates come from three providers.
--
-- We widen sources.kind to include 'search_api' so the virtual row passes the existing CHECK.
-- Pure widening of an enum-like text CHECK: every existing row's kind already matches one of the
-- seven values, so no UPDATE is needed. The orchestrator is the only writer to this row's
-- collected articles; the standard `collectSource` flow skips kind='search_api' (see
-- packages/backend/src/sources/collect.ts:88-91 — mp_account/external skip pattern, applied here).
ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_kind_check;
ALTER TABLE sources ADD  CONSTRAINT sources_kind_check
  CHECK (kind IN ('rss', 'web_list', 'json_list', 'x_search', 'mp_account', 'external', 'search_api'));

-- The virtual source row. participation_mode='hot_signal' so it does NOT enter the editorial
-- pipeline: search candidates have already been filtered by the LLM score gate ≥ 70, and they
-- skip the editorial 5-axis re-score (which would re-call the LLM and double our model spend).
-- tier=T2 (matches the heuristic trust of the three providers: HN Algolia is high signal,
-- SearXNG mixed, GitHub Trending low-volume). site_fulltext=false is enforced by AGENTS.md
-- unless the source opts in; this row does not opt in.
INSERT INTO sources (id, name, kind, config, tier, first_party, participation_mode, interval_minutes,
                     site_fulltext, syndicate_fulltext, enabled, next_fetch_at)
VALUES ('search-api-virtual', 'Search Engines (SearXNG / HN / GitHub)', 'search_api',
        '{"queryFile":"industry/search-queries.json"}',
        'T2', false, 'hot_signal', 60, false, false, true, now())
ON CONFLICT (id) DO NOTHING;
