// W5-3 FIX-X (commentary pipeline) — second half of the local commentary authoring flow.
//
// Why a separate script (not folded into local-commentary-gen.ts):
//   1. The "generate draft" step is interactive — it produces paper_card.yaml + empty .md
//      and exits so the human can chat with an external LLM. The "publish" step reads a
//      human-edited .md and commits a DB transition. Different blast radius (DB write vs.
//      local file write), so we keep them separate.
//
//   2. Publish is the only step that flips commentary_status='pending' → 'published' (or
//      'skipped'). This separation matches the worker pattern of fetch → translate: each
//      step has its own failure surface and is independently re-runnable.
//
//   3. Validation gates (article-card style, unbug.github.io 论文解读 创作技巧):
//      - .md must exist and be non-empty (≥ 400 chars — a one-line stub is a fail)
//      - .md must contain at least one [F]/[A]/[I]/[U] evidence marker (unbug discipline)
//      - skipped_reason is required when flipping to 'skipped' (free text)
//      - source is required and must be one of {chatgpt, perplexity, human, hybrid}
//
// Auth & secrets: this script only reads/writes the DB and the local .md file. Cookies
// and API keys stay in the human's browser session. The DB .env is read at import time
// by @aihot/backend/db — same as every other script.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb, sql } from "@aihot/backend/db";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..");
const DOCS_DIR = join(REPO_ROOT, "docs", "commentary");

type SourceKey = "chatgpt" | "perplexity" | "human" | "hybrid";

const SOURCES: ReadonlySet<SourceKey> = new Set(["chatgpt", "perplexity", "human", "hybrid"]);

/** Author-friendly labels — surface in the front-end detail page. The slug stays the
 *  machine-readable key. */
const SOURCE_LABELS: Record<SourceKey, string> = {
  chatgpt: "ChatGPT",
  perplexity: "Perplexity",
  human: "纯人工",
  hybrid: "人机协作",
};

interface CliArgs {
  arxivId: string;
  source: SourceKey;
  /** Skip path: flip to commentary_status='skipped' with a reason. */
  skip: boolean;
  skippedReason?: string;
  /** Commit + git add (defaults true); --no-commit leaves the .md uncommitted. */
  commit: boolean;
}

function parseArgs(argv: string[]): CliArgs | null {
  let arxivId: string | undefined;
  let source: SourceKey | undefined;
  let skip = false;
  let skippedReason: string | undefined;
  let commit = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--arxiv-id" && argv[i + 1]) { arxivId = argv[++i]; continue; }
    if (a === "--source" && argv[i + 1]) {
      const v = argv[++i];
      if (SOURCES.has(v as SourceKey)) source = v as SourceKey;
      continue;
    }
    if (a === "--skip") { skip = true; continue; }
    if (a === "--skipped-reason" && argv[i + 1]) { skippedReason = argv[++i]; continue; }
    if (a === "--no-commit") { commit = false; continue; }
  }
  if (!arxivId) return null;
  if (!skip && !source) return null;
  return { arxivId, source: source ?? "human", skip, skippedReason, commit };
}

const EVIDENCE_MARKERS = [/\[\s*F\s*\]/, /\[\s*A\s*\]/, /\[\s*I\s*\]/, /\[\s*U\s*\]/];

function validateDraft(md: string): string | null {
  const trimmed = md.trim();
  if (trimmed.length < 400) return `commentary .md too short (${trimmed.length} < 400 chars) — unbug micropaper minimum is ~800 chars; below that, prefer --skip with a reason.`;
  const hasMarker = EVIDENCE_MARKERS.some((re) => re.test(trimmed));
  if (!hasMarker) return `commentary .md lacks any [F]/[A]/[I]/[U] evidence marker — pick one marker per claim (unbug discipline)`;
  return null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2]);
  if (!args) {
    console.error("usage:");
    console.error("  node --env-file=.env scripts/local-commentary-publish.ts --arxiv-id=<id> --source={chatgpt|perplexity|human|hybrid} [--no-commit]");
    console.error("  node --env-file=.env scripts/local-commentary-publish.ts --arxiv-id=<id> --skip --skipped-reason='<≤120 chars>'");
    await closeDb();
    process.exit(2);
  }

  const mdPath = join(DOCS_DIR, `${args.arxivId}.md`);
  if (!existsSync(mdPath)) {
    console.error(`${mdPath} does not exist — run scripts/local-commentary-gen.ts --arxiv-id=${args.arxivId} first to scaffold the draft`);
    await closeDb();
    process.exit(2);
  }

  if (args.skip) {
    if (!args.skippedReason || args.skippedReason.trim().length === 0) {
      console.error("--skipped-reason is required when --skip is set (audit trail — why was this paper opted out?)");
      await closeDb();
      process.exit(2);
    }
    const reason = args.skippedReason.trim().slice(0, 240);
    const [updated] = await sql<{ commentary_status: string }[]>`
      UPDATE papers
         SET commentary_status     = 'skipped',
             commentary_updated_at = now(),
             skipped_reason        = ${reason}
       WHERE arxiv_id = ${args.arxivId}
       RETURNING commentary_status`;
    if (!updated) {
      console.error(`paper ${args.arxivId} not found in DB`);
      await closeDb();
      process.exit(2);
    }
    console.log(`${args.arxivId} → commentary_status='skipped'  reason=${reason}`);
    await closeDb();
    process.exit(0);
  }

  // Publish path: validate .md then flip status.
  const md = readFileSync(mdPath, "utf8");
  const err = validateDraft(md);
  if (err) {
    console.error(`validation failed for ${mdPath}:`);
    console.error(`  ${err}`);
    await closeDb();
    process.exit(2);
  }

  // commentary_md_url: relative path under the repo, served by the publication layer as
  // /commentary/<arxiv_id>.md (the actual route is wired in a follow-up commit — today we
  // store the relative path so the value stays stable across deploys and the read layer
  // can resolve via the published site base URL).
  const mdUrl = `docs/commentary/${args.arxivId}.md`;
  const [updated] = await sql<{ commentary_status: string }[]>`
    UPDATE papers
       SET commentary_status     = 'published',
           commentary_md_url     = ${mdUrl},
           commentary_source     = ${args.source},
           commentary_updated_at = now()
     WHERE arxiv_id = ${args.arxivId}
     RETURNING commentary_status`;
  if (!updated) {
    console.error(`paper ${args.arxivId} not found in DB`);
    await closeDb();
    process.exit(2);
  }

  console.log(`${args.arxivId} → commentary_status='published'  source=${SOURCE_LABELS[args.source]} (${args.source})`);
  console.log(`  commentary_md_url=${mdUrl}`);
  if (args.commit) {
    console.log("  remember to git add docs/commentary/<id>.{md,yaml} and commit");
  }
  await closeDb();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("local-commentary-publish failed:", err);
  await closeDb();
  process.exit(1);
});
