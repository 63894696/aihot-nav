-- FIX-S: Brave Search as the 5th search engine (zh-only).
--
-- Why a budget row now:
-- - The orchestrator only calls Brave for lang:zh queries and only on gated cycles (cycle %
--   N === 0; N is set in search-fetch.ts / prompt-fetch.ts). Even so, every call goes through
--   `providers/receipts.ts` paidRequest, which calls checkBudget(service='brave') — without a
--   row in `budgets`, checkBudget throws "no budget configured for brave".
--
-- Caps chosen for Brave Search's free tier ($5/month credit ≈ 1000 queries):
-- - per_minute=3: throttle bursts so we never accidentally batch-fire (Brave also rate-limits
--   at 1 QPS per IP).
-- - per_hour=30: leaves headroom for the four zh search queries × every-other-cycle gate.
-- - per_day=1000: aligned with the public free credit cap.
--
-- ON CONFLICT DO NOTHING makes the migration idempotent — re-running is safe.
INSERT INTO budgets (service, per_minute, per_hour, per_day, note) VALUES
  ('brave', 3, 30, 1000, 'Brave Search API（$5/月 credit，9 zh × cycle_every=8 ≈ 810/月）')
ON CONFLICT (service) DO NOTHING;