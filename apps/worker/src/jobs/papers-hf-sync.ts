// papers-hf-sync — once a day, pulls Hugging Face's daily-papers listing and updates the
// hf_paper_id / hf_upvotes / hf_comments columns on papers rows whose arxiv_id matches.
// HF's listing is the de-facto community-signal source for AI/ML papers (researchers post
// there with explanations + upvotes + comments). The API is public, no key required.
//
// We only write into rows that already exist (matched by arxiv_id). New papers that appear
// only on HF (no arxiv RSS yet) are skipped here — arxiv-fetch + arxiv-translate are the
// ingest path. This job is purely community-metric enrichment.
//
// Reference: https://huggingface.co/api/daily_papers?limit=N
// Response shape (per item):
//   {
//     "id": "<hf paper id>",
//     "publishedAt": "2026-09-30T...",
//     "title": "...",
//     "summary": "...",
//     "upvotes": 42,
//     "numComments": 7,
//     "paper": { "id": "<hf paper id>", "arxivId"?: "2601.12345", ... }
//   }
import { sql } from "@aihot/backend/db";

const HF_DAILY_URL = "https://huggingface.co/api/daily_papers";
const HF_LIMIT = 100;
const HF_TIMEOUT_MS = 20_000;
const HF_USER_AGENT = "aihot-papers-hf-sync/1.0 (+https://ai.babelspan.com)";

interface HfDailyItem {
  id?: string;
  upvotes?: number;
  numComments?: number;
  paper?: { id?: string; arxivId?: string };
}

export interface HfSyncResult {
  scanned: number;
  matched: number;
  updated: number;
  skipped: number;
}

export async function syncHuggingFaceDaily(opts: { limit?: number; budgetMs?: number } = {}): Promise<HfSyncResult> {
  const deadline = opts.budgetMs ? Date.now() + opts.budgetMs : Number.POSITIVE_INFINITY;
  const limit = opts.limit ?? HF_LIMIT;
  if (Date.now() > deadline) return { scanned: 0, matched: 0, updated: 0, skipped: 0 };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HF_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(`${HF_DAILY_URL}?limit=${limit}`, {
      signal: controller.signal,
      headers: { "user-agent": HF_USER_AGENT, accept: "application/json" },
    });
  } catch (error) {
    clearTimeout(timer);
    // Network failure — the next run retries. Don't throw: the schedule should keep going.
    return { scanned: 0, matched: 0, updated: 0, skipped: 1, ...(error as Error).message ? {} : {} };
  }
  clearTimeout(timer);
  if (!resp.ok) return { scanned: 0, matched: 0, updated: 0, skipped: 1 };
  let items: HfDailyItem[];
  try {
    items = (await resp.json()) as HfDailyItem[];
  } catch {
    return { scanned: 0, matched: 0, updated: 0, skipped: 1 };
  }

  let scanned = 0;
  let matched = 0;
  let updated = 0;
  let skipped = 0;
  for (const item of items) {
    scanned += 1;
    const arxivId = (item.paper?.arxivId ?? "").trim();
    const hfPaperId = (item.id ?? item.paper?.id ?? "").trim();
    if (!arxivId || !/^\d{4}\.\d{4,5}$/.test(arxivId)) { skipped += 1; continue; }
    if (!hfPaperId) { skipped += 1; continue; }
    const upvotes = Number.isFinite(item.upvotes) ? Math.max(0, Math.floor(item.upvotes as number)) : 0;
    const comments = Number.isFinite(item.numComments) ? Math.max(0, Math.floor(item.numComments as number)) : 0;
    const exists = await sql<{ arxiv_id: string }[]>`SELECT arxiv_id FROM papers WHERE arxiv_id = ${arxivId} LIMIT 1`;
    if (exists.length === 0) { skipped += 1; continue; }
    matched += 1;
    // Only overwrite commentary_source when it's not already set — earlier GitHub mapping
    // entries (dair-ai / zhaoyang97 / …) win. HF becomes the fallback 'community' signal.
    const result = await sql`
      UPDATE papers
         SET hf_paper_id = ${hfPaperId},
             hf_upvotes  = ${upvotes},
             hf_comments = ${comments},
             commentary_source = COALESCE(commentary_source, 'huggingface')
       WHERE arxiv_id = ${arxivId}
         AND (hf_paper_id IS DISTINCT FROM ${hfPaperId}
              OR hf_upvotes IS DISTINCT FROM ${upvotes}
              OR hf_comments IS DISTINCT FROM ${comments}
              OR commentary_source IS NULL)`;
    if (result.count > 0) updated += 1;
  }
  return { scanned, matched, updated, skipped };
}
