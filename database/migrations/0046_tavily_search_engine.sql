-- FIX-R: Tavily as the 4th search engine (zh-only).
--
-- Why a budget row now:
-- - The orchestrator only calls Tavily for lang:zh queries and only on gated cycles (cycle %
--   N === 0; N is set in search-fetch.ts / prompt-fetch.ts). Even so, every call goes through
--   `providers/receipts.ts` paidRequest, which calls checkBudget(service='tavily') — without a
--   row in `budgets`, checkBudget throws "no budget configured for tavily".
--
-- Caps chosen for Tavily's free tier (~1000 calls/month):
-- - per_minute=3: throttle bursts so we never accidentally batch-fire.
-- - per_hour=30: leaves headroom for the four zh search queries × every-other-cycle gate.
-- - per_day=1000: aligned with the public free tier cap. We accept that the next month starts
--   after the day counter rolls.
--
-- ON CONFLICT DO NOTHING makes the migration idempotent — re-running is safe.
INSERT INTO budgets (service, per_minute, per_hour, per_day, note) VALUES
  ('tavily', 3, 30, 1000, 'Tavily 搜索（zh 查询按请求计费，按 cycle gate 触发）')
ON CONFLICT (service) DO NOTHING;
