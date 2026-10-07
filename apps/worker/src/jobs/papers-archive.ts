// papers-archive — FIX-AA-C. Every 10 days (cron `0 4 */10 * *` Asia/Shanghai) the worker
// dumps the entire papers table to a single NDJSON file under data/papers-archive/, computes
// its sha256, then commits + pushes to the dedicated GitHub repo
// (e.g. 63894696/aihot-nav-papers-archive). The repo acts as a public, version-controlled
// snapshot history — readers who want the full corpus offline can `git clone` once every
// 10 days instead of scraping the live API.
//
// Why a separate repo (not the main babelspan/aihot-nav):
//   1. The main repo's README + .gitignore + tests should not carry 5-15 MB of binary-ish
//      data — its git history would balloon. The archive repo's history is intended to
//      grow linearly (one NDJSON per snapshot × 10 days).
//   2. Public visibility — the archive repo is public so a reader with a GitHub account can
//      browse it without backend credentials. The main repo stays gated as it always was.
//   3. Permission isolation — a fine-grained token scoped to the archive repo cannot
//      push to the main repo. Worst case (token leak) cannot corrupt the source tree.
//
// Status semantics:
//   - success:    file pushed to GitHub + run row with sha256
//   - failed:     DB write or git push threw; run row carries the error_message (truncated 300 chars)
//   - local-only: GH token or repo not configured; file written to dataDir, no push attempted
//
// The schedule uses missed=once so a worker restart after a 12-hour outage still runs the
// missed cycle exactly once — duplicate runs are harmless (the file is overwritten, the
// git diff is empty so no commit fires, and the run row records the dedupe implicitly).
import { runPapersArchive } from "@aihot/backend/operations/papers-archive";

export interface PapersArchiveResult {
  recordCount: number;
  bytes: number;
  status: "success" | "failed" | "local-only";
  pushed: boolean;
}

/** Worker entry point — thin shim that delegates to the backend module. The schedules table
 *  imports this function; the actual work lives in packages/backend so it can be unit-tested
 *  with a fake DB / fake git env. */
export async function archivePapersNDJSON(now: Date = new Date()): Promise<PapersArchiveResult> {
  const ghToken = process.env.PAPERS_ARCHIVE_GH_TOKEN || null;
  const ghRepo = process.env.PAPERS_ARCHIVE_GH_REPO || null;
  const ghBranch = process.env.PAPERS_ARCHIVE_GH_BRANCH || "main";

  const result = await runPapersArchive(now, {
    ghToken,
    ghRepo,
    ghBranch,
  });
  return {
    recordCount: result.recordCount,
    bytes: result.bytes,
    status: result.status,
    pushed: result.pushed,
  };
}