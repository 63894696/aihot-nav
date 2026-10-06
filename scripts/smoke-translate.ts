// One-shot smoke entry for FIX-T.2 — invoke translateCodePromptsPending(limit=3)
// on VPS without going through the cron loop. Mirrors the cron handler body so
// we observe the same code path the periodic job runs.
import { translateCodePromptsPending } from "../apps/worker/src/jobs/code-prompts-translate.ts";

const t0 = Date.now();
const results = await translateCodePromptsPending({ limit: 3, budgetMs: 90_000 });
const elapsed = Date.now() - t0;
console.log(`elapsed=${elapsed}ms count=${results.length}`);
for (const r of results) console.log(JSON.stringify(r));
process.exit(0);
