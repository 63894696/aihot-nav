-- FIX-T (code-prompts auto-translation): zh translations of copilot_assets.title + description.
--
-- Why a separate table (NOT columns on copilot_assets):
--   1. Cardinality — translations are per (asset, locale). Putting them in copilot_assets would
--      either lock us to one locale or require a hstore/jsonb of unknown shape. The dedicated
--      table keeps a typed PK (asset_id, locale) and stays easy to query.
--   2. Lifecycle — translations are written by a worker job (code-prompts.fetch_translations)
--      that is independent of awesome-copilot-fetch (which mutates body_md / blob_sha). When
--      the upstream asset is re-fetched, the translation row is either re-translated (when
--      source_hash changes) or skipped (when the input is stable). Marking this lifecycle on
--      the parent row would conflate "fetched" with "translated".
--   3. Cost — translations cost LLM calls. The receipts / budget system needs a single
--      purpose tag ('translate_copilot') to count attempts. A dedicated table makes the
--      call-site obvious.
--
-- Wire scope (decided 2026-10-06): ONLY translate frontmatter->>'description' (the "what
-- does this do?" line) and a derived title (currently the filename without the .md suffix).
-- body_md is NOT translated — it's English markdown scaffolding, mostly tool declarations +
-- code blocks, and adding machine-translated noise to a developer's .github/ directory is
-- a footgun. `fields` jsonb is reserved for future use (e.g. translating `applyTo` arrays
-- or handoffs); left as empty `{}` for now.
--
-- Storage shape:
--   - asset_id FK to copilot_assets(id) with ON DELETE CASCADE — when an asset is removed
--     upstream, its translations follow.
--   - locale check constraint locks the supported set to ('zh', 'en') for now. Adding a
--     locale = new migration. 'en' is a no-op pass-through copy kept for symmetry so the
--     publication layer can pick "show translated" without branching on locale presence.
--   - source_hash is sha256 of `${title}\n${description}` taken at translation time. When
--     the upstream frontmatter changes (and awesome-copilot-fetch re-upserts the row),
--     source_hash diverges → worker re-translates. Cheap change-detection without
--     frontmatter diffing.
--   - model / attempt / status fields mirror papers-translate's lifecycle so the worker
--     reuses the same retry/skip pattern.
--
-- Indexes:
--   - PK is (asset_id, locale) — no extra index needed.
--   - translation queue scan: assets needing (re-)translation. Mirrors
--     copilot_assets_analyze_pending_idx (0049). Use a partial index on copilot_assets
--     status='indexed' (only fully-analyzed assets are eligible — fetched/analyzing may
--     still have stale frontmatter). Worker joins on copilot_translations to filter out
--     already-translated-and-stable rows by source_hash.

CREATE TABLE IF NOT EXISTS copilot_translations (
  asset_id     bigint NOT NULL REFERENCES copilot_assets(id) ON DELETE CASCADE,
  locale       text   NOT NULL CHECK (locale IN ('zh', 'en')),
  -- Translated title (derived from filename for now — awesome-copilot has no separate
  -- title field). Kept as a real column (not derived in code) so the worker can record
  -- exact LLM output for re-translation diff.
  title        text   NOT NULL,
  -- Translated frontmatter.description. NULL when the source row has no description key
  -- (legacy assets). The detail page renders "—" instead of an empty string.
  description  text,
  -- Reserved for future field-level translations (applyTo, handoffs). Empty today —
  -- the user explicitly opted out of body / fields translation in the FIX-T decision.
  fields       jsonb  NOT NULL DEFAULT '{}'::jsonb,
  -- Model key used for this row (e.g. 'minimax-m3'). Recorded for diagnosis when the
  -- worker flips primary models.
  model        text,
  -- Translation lifecycle — matches papers.status semantics:
  --   translated: full success, both title and description (when present) populated.
  --   partial:    model returned fewer fields than asked (rare; we asked for 2).
  --   failed:     model call failed and we still want the row around so re-try on next cycle.
  status       text   NOT NULL DEFAULT 'translated'
    CHECK (status IN ('translated', 'partial', 'failed')),
  fail_count   int    NOT NULL DEFAULT 0,
  last_error   text,
  -- sha256 of `${title}\n${description}` (the upstream input). The worker compares this
  -- against the current copilot_assets row on each cycle; mismatch → re-translate.
  source_hash  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_id, locale)
);

-- Translation queue scan: assets whose frontmatter has shifted since the last translation,
-- OR have no translation row yet. Worker query shape:
--   SELECT a.id FROM copilot_assets a
--   LEFT JOIN copilot_translations t ON t.asset_id = a.id AND t.locale = 'zh'
--   WHERE a.status = 'indexed'
--     AND (t.asset_id IS NULL OR t.source_hash <> md5(a.frontmatter->>'description'))
--   ORDER BY a.fetched_at DESC LIMIT N
--
-- The LEFT JOIN benefits from copilot_translations PK being (asset_id, locale) — that
-- index covers the lookup. The status='indexed' partial filter lives on copilot_assets
-- (already covered by copilot_assets_analyze_pending_idx pattern in 0049). No additional
-- index needed on copilot_translations itself for the queue scan.

-- Diagnostic index: count rows per (locale, status) for the admin UI "how many
-- translations are stuck in failed" view. Composite because that's the natural axis.
CREATE INDEX IF NOT EXISTS copilot_translations_locale_status_idx
  ON copilot_translations (locale, status);
