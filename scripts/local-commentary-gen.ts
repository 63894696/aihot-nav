// W5-3 FIX-X (commentary pipeline) — local CLI for human-driven commentary authoring.
//
// Why this exists as a separate script (not a worker job):
//   1. commentary is *human-authored* in collaboration with an external LLM
//      (chatgpt.com / perplexity.ai via browser_act). Worker jobs run unattended — that
//      would burn budget and pollute the public read layer with unedited drafts.
//   2. The lifecycle is interactive: pick paper → decide mode (micropaper / paradigm-radar
//      / skip) → chat with an LLM → save draft → review → commit → DB update. None of this
//      fits a cron schedule.
//   3. A local CLI keeps the .md drafts under git (audit trail) and lets the human review
//      diff by diff before any row flips to commentary_status='published'.
//
// Wire scope (decided 2026-10-06):
//   - Single paper at a time by --arxiv-id (interactive) OR --batch=N for the top N pending.
//   - Outputs a paper_card.yaml under docs/commentary/<arxiv_id>.yaml (input artifact) and
//     a draft <arxiv_id>.md (the LLM output, uncommitted).
//   - The DB update (commentary_status='pending' → 'published'/'skipped') happens *after*
//     the human runs scripts/local-commentary-publish.ts — keeping "draft" and "publish"
//     as two separate steps mirrors the worker pattern of fetch → translate.
//
// Auth & secrets:
//   - chatgpt.com / perplexity.ai are accessed by *the human* via the existing browser MCPs
//     (Comet / puppeteer-mcp). This script does NOT make outbound HTTP — it just reads
//     papers rows and writes local .md drafts. Any cookies / API keys stay in the human's
//     browser session, never in this process or git.

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb, sql } from "@aihot/backend/db";

// Repo root: scripts/local-commentary-gen.ts lives one level deep, so REPO_ROOT is ../.
// (REPO_ROOT is also exported from @aihot/backend/config but importing it here keeps the
// script runnable from anywhere without re-resolving the workspace.)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..");
const DOCS_DIR = join(REPO_ROOT, "docs", "commentary");

interface PaperRow {
  arxiv_id: string;
  title_en: string;
  title_zh: string | null;
  abstract_en: string;
  abstract_zh: string | null;
  authors: string[];
  primary_category: string;
  published_at: Date;
  abs_url: string;
  status: string;
  commentary_status: string | null;
  commentary_md_url: string | null;
}

interface CliArgs {
  arxivId?: string;
  batch: number;
  mode: "micropaper" | "paradigm-radar" | "innovation-brief" | "auto";
  /** Dry-run: print pending papers without writing drafts. */
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let arxivId: string | undefined;
  let batch = 5;
  let mode: CliArgs["mode"] = "auto";
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--arxiv-id" && argv[i + 1]) { arxivId = argv[++i]; continue; }
    if (a === "--batch" && argv[i + 1]) { batch = Number(argv[++i]) || 5; continue; }
    if (a === "--mode" && argv[i + 1]) {
      const v = argv[++i];
      if (v === "micropaper" || v === "paradigm-radar" || v === "innovation-brief" || v === "auto") {
        mode = v;
      }
      continue;
    }
    if (a === "--dry-run") { dryRun = true; continue; }
  }
  return { arxivId, batch, mode, dryRun };
}

/**
 * Picks the commentary mode for a paper based on heuristics from the unbug.github.io
 * 论文解读 创作技巧. The human can override on the CLI; this is just the auto-default.
 *
 * Heuristic (simplified — see docs/commentary/README.md for the full rationale):
 *   - micropaper (single-paper reading, 800-1500 chars): the default. Always possible.
 *   - paradigm-radar (≥2 independent signals → trend): we have no signal join yet, so this
 *     is rare. Auto-mode stays in micropaper until tool_papers / x_search evidence is in.
 *   - innovation-brief (paper + patent + product): same — no patent/product join yet.
 *   - skip: only when the human picks --mode=skip explicitly (handled by the publish step).
 */
function autoMode(_row: PaperRow): "micropaper" {
  return "micropaper";
}

async function fetchPendingPapers(limit: number): Promise<PaperRow[]> {
  return await sql<PaperRow[]>`
    SELECT arxiv_id, title_en, title_zh, abstract_en, abstract_zh, authors,
           primary_category, published_at, abs_url, status,
           commentary_status, commentary_md_url
    FROM papers
    WHERE commentary_status = 'pending'
      AND translated_at IS NOT NULL
    ORDER BY translated_at DESC
    LIMIT ${limit}`;
}

async function fetchPaperById(arxivId: string): Promise<PaperRow | null> {
  const [row] = await sql<PaperRow[]>`
    SELECT arxiv_id, title_en, title_zh, abstract_en, abstract_zh, authors,
           primary_category, published_at, abs_url, status,
           commentary_status, commentary_md_url
    FROM papers
    WHERE arxiv_id = ${arxivId}`;
  return row ?? null;
}

function toPaperCard(row: PaperRow, mode: string): string {
  // Input artifact consumed by the LLM (via clipboard / chat paste). YAML keeps the
  // boundary stable: any column we add to papers later surfaces here without a rewrite.
  // No secrets, no full body — just the structured signals an LLM needs to start writing.
  const header = [
    `# paper_card.yaml for ${row.arxiv_id}`,
    `# generated by scripts/local-commentary-gen.ts — review before sending to LLM`,
    `mode: ${mode}`,
    `arxiv_id: ${row.arxiv_id}`,
    `title_en: ${yamlScalar(row.title_en)}`,
    `title_zh: ${row.title_zh ? yamlScalar(row.title_zh) : "null"}`,
    `primary_category: ${row.primary_category}`,
    `authors: [${row.authors.map(yamlScalar).join(", ")}]`,
    `abs_url: ${row.abs_url}`,
    `published_at: ${row.published_at.toISOString().slice(0, 10)}`,
    `status: ${row.status}`,
    `commentary_status: ${row.commentary_status ?? "null"}`,
    "abstract_en: |",
    ...row.abstract_en.split(/\r?\n/).map((l) => `  ${l}`),
    "abstract_zh: |",
    ...(row.abstract_zh ?? "(未翻译)").split(/\r?\n/).map((l) => `  ${l}`),
  ].join("\n");
  return header;
}

function yamlScalar(s: string): string {
  // Quote aggressively — titles contain colons, em-dashes, numbers that look like YAML
  // keys, etc. Single-quoted YAML scalars escape ' as ''.
  const escaped = s.replace(/'/g, "''");
  return `'${escaped}'`;
}

async function writeDraft(row: PaperRow, mode: string, dryRun: boolean): Promise<{ cardPath: string; mdPath: string }> {
  const cardPath = join(DOCS_DIR, `${row.arxiv_id}.yaml`);
  const mdPath = join(DOCS_DIR, `${row.arxiv_id}.md`);
  if (dryRun) {
    return { cardPath, mdPath };
  }
  mkdirSync(DOCS_DIR, { recursive: true });
  if (!existsSync(cardPath)) {
    writeFileSync(cardPath, toPaperCard(row, mode), "utf8");
  }
  if (!existsSync(mdPath)) {
    // Empty draft — the human pastes the LLM's reply into this file, then runs
    // scripts/local-commentary-publish.ts which validates & flips commentary_status.
    const header = [
      `<!-- commentary draft for ${row.arxiv_id} — mode=${mode} — paste LLM reply below -->`,
      `<!-- paper title (en): ${row.title_en} -->`,
      "",
    ].join("\n");
    writeFileSync(mdPath, header, "utf8");
  }
  return { cardPath, mdPath };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(DOCS_DIR, { recursive: true });

  let papers: PaperRow[] = [];
  if (args.arxivId) {
    const row = await fetchPaperById(args.arxivId);
    if (!row) {
      console.error(`paper ${args.arxivId} not found in DB (or not yet translated)`);
      await closeDb();
      process.exit(2);
    }
    papers = [row];
  } else {
    papers = await fetchPendingPapers(args.batch);
  }

  if (papers.length === 0) {
    console.log("no papers in commentary_status='pending' queue — run scripts/local-commentary-publish.ts to mark a draft published, or wait for arxiv-translate to translate more papers.");
    await closeDb();
    process.exit(0);
  }

  console.log(`picked ${papers.length} paper(s):`);
  for (const p of papers) {
    const mode = args.mode === "auto" ? autoMode(p) : args.mode;
    const { cardPath, mdPath } = await writeDraft(p, mode, args.dryRun);
    console.log(`  - ${p.arxiv_id}  mode=${mode}  status=${p.status}`);
    console.log(`    card: ${args.dryRun ? "(dry-run)" : cardPath}`);
    console.log(`    draft: ${args.dryRun ? "(dry-run)" : mdPath}`);
    console.log(`    abs: ${p.abs_url}`);
  }
  console.log("");
  console.log("next steps (human):");
  console.log("  1. open each <arxiv_id>.yaml in docs/commentary/ — review paper_card");
  console.log("  2. copy paper_card content into a new chat at chatgpt.com/new (already logged in)");
  console.log("     OR at comet.perplexity.ai (already logged in) — discuss mode + ask for draft");
  console.log("  3. paste the LLM reply into <arxiv_id>.md");
  console.log("  4. run scripts/local-commentary-publish.ts --arxiv-id=<id> to validate + flip commentary_status='published'");

  await closeDb();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("local-commentary-gen failed:", err);
  await closeDb();
  process.exit(1);
});
