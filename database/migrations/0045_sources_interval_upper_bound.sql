-- v0.2.1 + FIX-O: widen sources.interval_minutes upper bound.
--
-- The original CHECK (interval_minutes BETWEEN 1 AND 1440) was set when every source was a fast RSS
-- / X search / web list — a 24h ceiling was a natural cap. Two source classes proved too slow for
-- that ceiling:
--
--   (1) community-prompt / awesome-list (prompthero / flowgpt / awesome-chatgpt-prompts /
--       awesome-prompt-engineering / reddit r/ChatGPTPromptEngineering / r/ClaudeAI) — these are
--       curated galleries updated weekly-bimonthly; the orchestrator would re-poll every day and
--       always see the same page. The previous Python edit tried `interval_minutes = 4320` (3
--       days) and the CHECK rejected it on every setup run, blocking every worker start (commit
--       FIX-N `9808acb` had to set them all to 1440 to make setup pass).
--
--   (2) future T3 / external / leaderboard-mirror sources that legitimately probe monthly cadence.
--
-- This migration widens the upper bound to 43200 minutes (30 days). The lower bound stays at 1.
-- No row currently exceeds 4320, so the change is purely additive: zero existing rows fail; we
-- just gain headroom for slow-cadence sources to declare their natural rhythm.
--
-- Backwards compatibility:
--   - DROP IF EXISTS makes this idempotent: re-running it is safe (no-op on the second run).
--   - No row data changes; only the bound widens.
--   - The seed (`scripts/seed.ts`) and `industry/sources.json` continue to be the source of truth
--     for actual values; this migration only relaxes the schema so they can express 1441-43200.

ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_interval_minutes_check;
ALTER TABLE sources ADD  CONSTRAINT sources_interval_minutes_check
  CHECK (interval_minutes >= 1 AND interval_minutes <= 43200);