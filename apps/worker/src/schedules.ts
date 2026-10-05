// Cron-style schedules (Asia/Shanghai). Each run is recorded in job_runs; missed slots run once.
import type { PgBoss } from "pg-boss";
import { FEATURES } from "@aihot/industry/features";
import { ensureQueue, recordRun } from "@aihot/backend/jobs/queue";
import { sweepUnprocessed } from "@aihot/backend/jobs/content";
import { translatePending } from "@aihot/backend/editorial/translate";
import { adaptIntervals, scheduleDueSources } from "@aihot/backend/sources/collect";
import { scheduleMpReconcile } from "@aihot/backend/sources/mp";
import { refreshSourceIcons } from "@aihot/backend/sources/icons";
import { computeHotRanking, snapshotHeat } from "@aihot/backend/events/hot";
import { refreshStoryStatuses } from "@aihot/backend/events/digest";
import { linkRelatedStories } from "@aihot/backend/events/group";
import { catchUpReports, composeDaily, composeMonthly, composeWeekly } from "@aihot/backend/reports/compose";
import { addDays, beijingDate, isoWeekLabel } from "@aihot/contracts/time";
import { runLeaderboardRound } from "@aihot/backend/leaderboard/method/run";
import { refreshLeaderboard } from "@aihot/backend/leaderboard/fetch/refresh";
import { dailyRetention } from "@aihot/backend/operations/retention";
import { submitIndexNow } from "@aihot/backend/operations/indexnow";
import { checkAlerts, sendDigest } from "@aihot/backend/operations/alerts";
import { autoReleaseUnknownReceipts } from "@aihot/backend/admin/runs";
import { forwardPendingFeedback } from "@aihot/backend/operations/feedback";
import { backupConfigured, runBackup } from "@aihot/backend/operations/backup";
import { sourceHealthWeekly } from "@aihot/backend/operations/reports";
import { markStalePendingReceipts } from "@aihot/backend/providers/receipts";
import { markStaleDeliveries } from "@aihot/backend/notify/deliver";
import { fetchArxivFeeds } from "./jobs/arxiv-fetch.ts";
import { translateArxivPending } from "./jobs/arxiv-translate.ts";
import { syncHuggingFaceDaily } from "./jobs/papers-hf-sync.ts";
import { fetchSearchQueries } from "./jobs/search-fetch.ts";
import { fetchPromptQueries } from "./jobs/prompt-fetch.ts";
import { fetchAwesomeCopilotAssets } from "./jobs/awesome-copilot-fetch.ts";

interface Scheduled {
  name: string;
  cron: string;
  run: () => Promise<unknown>;
  missed?: "skip" | "once";
}

const collecting = process.env.COLLECT_ENABLED !== "false";

export const SCHEDULES: Scheduled[] = [
  { name: "content.sweep", cron: "*/5 * * * *", run: sweepUnprocessed },
  // Full-text translations of newly selected items (model calls; off with MODEL_CALLS_ENABLED=false).
  { name: "content.translate", cron: "*/5 * * * *", run: () => translatePending() },
  { name: "hot.rank", cron: "*/5 * * * *", run: () => computeHotRanking() },
  { name: "hot.snapshot", cron: "2 * * * *", run: () => snapshotHeat() },
  { name: "stories.status", cron: "7 * * * *", run: refreshStoryStatuses },
  { name: "stories.links", cron: "12 * * * *", run: linkRelatedStories },
  { name: "reports.daily", cron: "0 8 * * *", missed: "once", run: () => composeDaily(beijingDate(Date.now())) },
  { name: "reports.weekly", cron: "0 10 * * 1", missed: "once", run: () => composeWeekly(isoWeekLabel(addDays(beijingDate(Date.now()), -7))) },
  {
    name: "reports.monthly",
    cron: "30 10 1 * *",
    missed: "once",
    run: () => {
      const [y, m] = beijingDate(Date.now()).split("-").map(Number) as [number, number];
      return composeMonthly(m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`);
    },
  },
  { name: "reports.catch-up", cron: "15 * * * *", run: () => catchUpReports() },
  { name: "ops.retention", cron: "30 3 * * *", missed: "once", run: () => dailyRetention() },
  { name: "sources.icons", cron: "40 4 * * *", missed: "once", run: () => refreshSourceIcons() },
  // IndexNow for new indexable pages (off unless INDEXNOW_SUBMIT_ENABLED).
  { name: "seo.indexnow", cron: "50 5 * * *", missed: "once", run: () => submitIndexNow() },
  // Work a stopped process left half way becomes visible, and unknown paid requests get their one
  // automatic release, before the alerts look.
  {
    name: "ops.recover",
    cron: "*/10 * * * *",
    run: async () => ({ receipts: await markStalePendingReceipts(), released: await autoReleaseUnknownReceipts(), deliveries: await markStaleDeliveries() }),
  },
  { name: "ops.alerts", cron: "*/10 * * * *", run: () => checkAlerts() },
  // One message with the follow-ups that do not touch readers (nothing when there are none).
  { name: "ops.digest", cron: "0 9 * * *", missed: "once", run: () => sendDigest() },
  // Feedback that did not reach the internal Feishu chat when it was sent (off with FEISHU_INTERNAL_ENABLED).
  { name: "feedback.forward", cron: "*/10 * * * *", run: () => forwardPendingFeedback() },
  ...(backupConfigured() ? [{ name: "ops.backup", cron: "10 4 * * *", missed: "once" as const, run: () => runBackup() }] : []),
  { name: "reports.source-health", cron: "0 9 * * 1", missed: "once", run: () => sourceHealthWeekly() },
  // Four upstream checks a day; a new run is published only when the evidence changed. With collection
  // off only the computation runs, over the snapshots already stored.
  ...(FEATURES.leaderboard
    ? [{ name: "leaderboard.round", cron: "5 2,8,14,20 * * *", missed: "once" as const, run: () => (collecting ? refreshLeaderboard() : runLeaderboardRound()) }]
    : []),
  ...(collecting
    ? [
        { name: "sources.schedule", cron: "* * * * *", run: () => scheduleDueSources() },
        { name: "sources.adapt-intervals", cron: "20 4 * * *", run: adaptIntervals },
        // WeChat official accounts (paid), each once per its interval.
        { name: "sources.mp-reconcile", cron: "*/15 * * * *", run: () => scheduleMpReconcile() },
      ]
    : []),
  // Codex reset monitor: checked every minute, scanned every 5 (every 3 while hot). It reads X through
  // SocialData, so without that key there is nothing to run.
  // W4b: arXiv paper fetch (5 topic RSS) and LLM translation of pending papers.
  // Translate runs singleton: two parallel runs would double-call the LLM on the same row.
  { name: "arxiv.fetch", cron: "*/20 * * * *", run: () => fetchArxivFeeds() },
  { name: "arxiv.translate", cron: "*/2 * * * *", missed: "once", run: () => translateArxivPending() },
  // W4b-2: Hugging Face daily-papers → community upvotes / comments on existing papers.
  // Once a day, normal schedule (no singleton needed: writes are idempotent, one paper per row).
  { name: "papers.hf-sync", cron: "13 5 * * *", missed: "once", run: () => syncHuggingFaceDaily() },
  // W5-2: zero-budget search-engine orchestrator. Reads industry/search-queries.json, fans out
  // across SearXNG / HN Algolia / GitHub Trending, dedupes, and runs the LLM score gate (≥70).
  // Singleton not required: the orchestrator's dedupe + identity_key on `articles` makes
  // concurrent runs safe; the safety valve in scoreSearch handles a model outage.
  { name: "search.fetch", cron: "0 * * * *", run: () => fetchSearchQueries() },
  // W5-3 v0.2.1-#7: prompts column orchestrator. Reads prompt-* queries from the same file,
  // fans out across SearXNG (only — HN / GitHub Trending don't surface reusable prompts),
  // dedupes, and runs the LLM prompt-score gate (extract {promptText, useCase, category}).
  // Writes pass the prompt_items UNIQUE(original_url) gate via ON CONFLICT DO NOTHING, so a
  // re-run is idempotent. Singleton not required for the same reason as search.fetch. The 5-min
  // offset from search.fetch keeps the two score batches from colliding on the model at :00.
  { name: "prompts.fetch", cron: "5 * * * *", run: () => fetchPromptQueries() },
  // W5-3 code-prompts expansion: pull github.com/github/awesome-copilot assets (agents /
  // instructions / skills) into copilot_assets. Driven by an explicit `*/15 * * * *` cycle
  // (NOT every 20 min like arxiv) — GitHub Contents API allows 60 unauth requests/hour/IP,
  // so 4-per-hour × 3 sources = 12 tree calls + raw fetches stays well under budget. The job
  // self-throttles via blob_sha skip: unchanged files never re-download.
  { name: "awesome-copilot.fetch", cron: "*/15 * * * *", run: () => fetchAwesomeCopilotAssets() },
];

export async function registerSchedules(boss: PgBoss) {
  for (const s of SCHEDULES) {
    const queue = `cron.${s.name}`;
    await ensureQueue(queue, { policy: "singleton", retryLimit: 1, expireInSeconds: 3600 });
    await boss.schedule(queue, s.cron, {}, { tz: "Asia/Shanghai", missed: s.missed ?? "skip" });
    // Schedules fire at minute boundaries; a 15 s pickup keeps them on time with a third of the polling.
    await boss.work(queue, { pollingIntervalSeconds: 15 }, async () => recordRun(s.name, s.run));
  }
  // A schedule removed from the table (a module switched off) must not keep firing from an earlier run.
  const names = new Set(SCHEDULES.map((s) => `cron.${s.name}`));
  for (const existing of await boss.getSchedules()) {
    if (existing.name.startsWith("cron.") && !names.has(existing.name)) await boss.unschedule(existing.name);
  }
}
