// awesome-copilot-fetch — pulls the three external-awesome-copilot-{kind,source,slug}
// sources from github.com/github/awesome-copilot and upserts the copilot_assets table.
//
// This is a dedicated job, NOT a generic `collect.ts` collector, because:
//   1. Sources with kind=external are explicitly skipped by the standard
//      scheduler (packages/backend/src/sources/collect.ts:88-91).
//   2. The data shape — frontmatter jsonb + body_md + slug-based natural key —
//      is nothing like articles (which carry title/excerpt/url).
//   3. The 5-axis editorial score (selection-score.md) is not applicable:
//      awesome-copilot assets are scaffolding for code-gen agents, not single
//      reusable prompts, so they would fail scorePrompt anyway.
//
// Fetch path per source:
//   1. GitHub Contents API: GET https://api.github.com/repos/github/awesome-copilot/contents/{dir}
//      returns a JSON array of file metadata (name, path, sha, size, download_url, ...).
//   2. For each file: raw fetch from raw.githubusercontent.com/<path> via guardedFetch().
//   3. Hand-roll frontmatter splitter (no YAML parser in the repo).
//   4. INSERT into copilot_assets ON CONFLICT (source_id, slug) DO UPDATE.
//
// Boundaries (kept here so future tweaks do not regress them):
//   - API rate: GitHub Contents API allows 60 unauthenticated requests/hour. Three
//     sources × one tree call each + 100+ raw fetches every 20 min would blow
//     this — so we skip already-fetched assets whose blob_sha matches the tree
//     entry (cheap change-detection hint, see copilot_assets blob_sha comment).
//   - Budget: `opt.budgetMs` (default 60 s) caps wall-clock. Each source is
//     skipped as soon as the deadline is reached.
//   - Failure isolation: one bad file → `failed: ++`, log, continue.
import { sql } from "@aihot/backend/db";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import type { SourceRow } from "@aihot/backend/sources/types";

const GH_API_BASE = "https://api.github.com/repos/github/awesome-copilot/contents";
const GH_RAW_BASE = "https://raw.githubusercontent.com/github/awesome-copilot/main";
const DEFAULT_BUDGET_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_FILES = 250;

interface GhTreeEntry {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: "file" | "dir";
  download_url: string | null;
}

export interface CopilotFetchResult {
  sources: number;
  scanned: number;
  upserted: number;
  skipped: number;
  failed: number;
}

/** Maps source_id suffix (after the `external-awesome-copilot-` prefix) to the
 *  asset kind + directory inside github.com/github/awesome-copilot. Three sources
 *  total; no need to discover at runtime. */
const SOURCE_PLAN: Record<string, { assetKind: "agent" | "instruction" | "skill"; dir: string }> = {
  agents: { assetKind: "agent", dir: "agents" },
  instructions: { assetKind: "instruction", dir: "instructions" },
  skills: { assetKind: "skill", dir: "skills" },
};

export async function fetchAwesomeCopilotAssets(opts: { budgetMs?: number; maxFiles?: number; timeoutMs?: number } = {}): Promise<CopilotFetchResult> {
  const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;

  // Find all external-awesome-copilot-* sources. The standard scheduler skips
  // kind=external entirely (collect.ts:88), so we drive them ourselves.
  const sources = await sql<SourceRow[]>`
    SELECT id, name, kind, config, tier, participation_mode, first_party, interval_minutes, enabled, cursor, fail_count
    FROM sources
    WHERE enabled = true AND kind = 'external' AND id LIKE 'external-awesome-copilot-%'
    ORDER BY id`;
  if (sources.length === 0) return { sources: 0, scanned: 0, upserted: 0, skipped: 0, failed: 0 };

  // Map source_id → plan entry once.
  const planBySource = new Map<string, { assetKind: "agent" | "instruction" | "skill"; dir: string }>();
  for (const s of sources) {
    const suffix = s.id.replace(/^external-awesome-copilot-/, "");
    const plan = SOURCE_PLAN[suffix];
    if (!plan) continue; // unknown suffix: skip silently — fail_count stays 0
    planBySource.set(s.id, plan);
  }
  if (planBySource.size === 0) return { sources: sources.length, scanned: 0, upserted: 0, skipped: 0, failed: 0 };

  let scanned = 0;
  let upserted = 0;
  let skipped = 0;
  let failed = 0;

  for (const src of sources) {
    if (Date.now() > deadline) break;
    const plan = planBySource.get(src.id);
    if (!plan) continue;

    const tree = await fetchTree(plan.dir, timeoutMs);
    if (tree.kind === "err") {
      failed += tree.entries.length; // best-effort; the whole source fails
      await bumpFailCount(src.id, tree.message);
      continue;
    }
    if (tree.entries.length === 0) { skipped += 1; continue; }

    // Limit per-source so a runaway tree doesn't blow the budget on one bad dir.
    const entries = tree.entries.slice(0, maxFiles);

    // Pre-load (source_id, slug) → blob_sha for already-stored rows so we can
    // skip them cheaply without doing a network roundtrip.
    const slugs = new Set(entries.map((e) => e.path));
    const stored = slugs.size > 0 ? await sql<{ slug: string; blob_sha: string | null }[]>`
      SELECT slug, blob_sha FROM copilot_assets WHERE source_id = ${src.id} AND slug = ANY(${Array.from(slugs)})
    ` : [];
    const storedBySha = new Map<string, string>();
    for (const row of stored) if (row.blob_sha) storedBySha.set(row.slug, row.blob_sha);

    for (const entry of entries) {
      if (Date.now() > deadline) break;
      scanned += 1;
      const filename = entry.name;
      const slug = entry.path;

      // Cheap skip: blob_sha unchanged → file content matches our last fetch.
      if (storedBySha.get(slug) === entry.sha) { skipped += 1; continue; }

      const raw = await fetchRaw(slug, timeoutMs);
      if (raw.kind === "err") { failed += 1; continue; }

      const parsed = splitFrontmatter(raw.body);
      if (parsed.kind === "err") { failed += 1; continue; }

      const ok = await upsertAsset({
        sourceId: src.id,
        assetKind: plan.assetKind,
        slug,
        filename,
        frontmatter: parsed.frontmatter,
        bodyMd: parsed.body,
        rawUrl: `${GH_RAW_BASE}/${slug}`,
        commitSha: null, // tree endpoint does not return commit SHA — cheap skip uses blob_sha only
        blobSha: entry.sha,
        sizeBytes: entry.size,
      });
      if (ok) upserted += 1;
      else failed += 1;
    }
  }
  return { sources: sources.length, scanned, upserted, skipped, failed };
}

interface TreeOk { kind: "ok"; entries: GhTreeEntry[] }
interface TreeErr { kind: "err"; entries: []; message: string }

async function fetchTree(dir: string, timeoutMs: number): Promise<TreeOk | TreeErr> {
  try {
    const res = await guardedFetch(`${GH_API_BASE}/${dir}`, {
      timeoutMs,
      maxBytes: 4 * 1024 * 1024,
      headers: { accept: "application/vnd.github+json" },
    });
    if (res.status !== 200) return { kind: "err", entries: [], message: `tree ${dir} HTTP ${res.status}` };
    let parsed: unknown;
    try { parsed = JSON.parse(res.text()); } catch { return { kind: "err", entries: [], message: `tree ${dir} invalid JSON` }; }
    if (!Array.isArray(parsed)) return { kind: "err", entries: [], message: `tree ${dir} non-array` };
    const entries: GhTreeEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const e = item as Record<string, unknown>;
      if (e.type !== "file") continue;
      const name = typeof e.name === "string" ? e.name : "";
      const path = typeof e.path === "string" ? e.path : "";
      const sha = typeof e.sha === "string" ? e.sha : "";
      const size = typeof e.size === "number" ? e.size : 0;
      if (!name || !path || !sha) continue;
      entries.push({ name, path, sha, size, type: "file", download_url: typeof e.download_url === "string" ? e.download_url : null });
    }
    return { kind: "ok", entries };
  } catch (err) {
    return { kind: "err", entries: [], message: (err as Error).message.slice(0, 200) };
  }
}

interface RawOk { kind: "ok"; body: string }
interface RawErr { kind: "err"; message: string }

async function fetchRaw(slug: string, timeoutMs: number): Promise<RawOk | RawErr> {
  try {
    const res = await guardedFetch(`${GH_RAW_BASE}/${slug}`, {
      timeoutMs,
      maxBytes: 1 * 1024 * 1024, // 1 MB per asset is plenty; giant files are misconfig'd
      headers: { accept: "text/plain" },
    });
    if (res.status !== 200) return { kind: "err", message: `raw ${slug} HTTP ${res.status}` };
    return { kind: "ok", body: res.text() };
  } catch (err) {
    return { kind: "err", message: (err as Error).message.slice(0, 200) };
  }
}

interface ParsedOk { kind: "ok"; frontmatter: Record<string, unknown>; body: string }
interface ParsedErr { kind: "err"; message: string }

/**
 * Hand-rolled frontmatter splitter.
 *
 * Why not a YAML lib: the repo has no js-yaml / yaml / gray-matter in any
 * package.json. Awesome-copilot frontmatter is shallow (one level of
 * `key: value` with a few special cases like `tools: [a, b, c]` and
 * `mcp-servers:` block). We don't need full YAML — we need a best-effort capture
 * so the publication layer can render `description->>'model'` etc.
 *
 * Strategy:
 *   - File MUST start with `---\n`.
 *   - Split on the second `---\n` line; everything between is frontmatter,
 *     everything after is body.
 *   - Per line: trim; skip blank / `# comment`; key = chars before first `:`;
 *     value = the rest, trimmed.
 *   - Values starting with `[`/`]` are parsed as a comma-separated list
 *     (the only nested shape used in awesome-copilot frontmatter: `tools`,
 *     `mcp-servers.tools`, `handoffs`).
 *   - Everything else is stored as string. Unknown nested shapes (rare in
 *     awesome-copilot) are preserved as a single string — the publication
 *     layer renders frontmatter verbatim anyway.
 *
 * Failure modes tolerated:
 *   - No frontmatter (legacy assets): we return `{}` + the whole file as body.
 *   - Unterminated frontmatter: caught and tagged as failed (the asset is
 *     skipped, not silently inserted with empty frontmatter).
 */
function splitFrontmatter(content: string): ParsedOk | ParsedErr {
  if (!content.startsWith("---")) {
    return { kind: "ok", frontmatter: {}, body: content };
  }
  // Skip the opening `---` line, then find the next `---` on its own line.
  const rest = content.slice(3);
  const endMatch = /(^|\n)---(\r?\n|$)/.exec(rest);
  if (!endMatch) return { kind: "err", message: "frontmatter not terminated" };
  const fmEnd = endMatch.index ?? 0;
  const fmBlock = rest.slice(0, fmEnd).replace(/^\r?\n/, "");
  const body = rest.slice(fmEnd).replace(/^---(\r?\n|$)/, "").replace(/^\r?\n/, "");
  return { kind: "ok", frontmatter: parseFrontmatterLines(fmBlock), body };
}

function parseFrontmatterLines(block: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = block.split(/\r?\n/);
  let currentListKey: string | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    if (currentListKey && /^\s+-\s/.test(line)) {
      const arr = out[currentListKey];
      if (Array.isArray(arr)) arr.push(parseListValue(line.replace(/^\s+-\s/, "")));
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (!key) continue;
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      out[key] = inner ? inner.split(",").map((x) => unquote(x.trim())).filter(Boolean) : [];
      currentListKey = null;
      continue;
    }
    if (value === "") {
      // Multi-line list starts on next indented `-` rows.
      out[key] = [];
      currentListKey = key;
      continue;
    }
    out[key] = unquote(value);
    currentListKey = null;
  }
  return out;
}

function parseListValue(s: string): string {
  return unquote(s.replace(/,\s*$/, ""));
}

function unquote(s: string): string {
  if ((s.startsWith("\"") && s.endsWith("\"")) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

interface UpsertInput {
  sourceId: string;
  assetKind: "agent" | "instruction" | "skill";
  slug: string;
  filename: string;
  frontmatter: Record<string, unknown>;
  bodyMd: string;
  rawUrl: string;
  commitSha: string | null;
  blobSha: string;
  sizeBytes: number;
}

async function upsertAsset(input: UpsertInput): Promise<boolean> {
  try {
    const result = await sql`
      INSERT INTO copilot_assets (
        source_id, asset_kind, slug, filename,
        frontmatter, body_md,
        raw_url, commit_sha, blob_sha, size_bytes,
        repo_slug, default_branch, status,
        fetched_at, updated_at
      )
      VALUES (
        ${input.sourceId}, ${input.assetKind}, ${input.slug}, ${input.filename},
        ${sql.json(JSON.parse(JSON.stringify(input.frontmatter)))}, ${input.bodyMd},
        ${input.rawUrl}, ${input.commitSha}, ${input.blobSha}, ${input.sizeBytes},
        'github/awesome-copilot', 'main', 'fetched',
        now(), now()
      )
      ON CONFLICT (source_id, slug) DO UPDATE SET
        filename        = EXCLUDED.filename,
        frontmatter     = EXCLUDED.frontmatter,
        body_md         = EXCLUDED.body_md,
        raw_url         = EXCLUDED.raw_url,
        blob_sha        = EXCLUDED.blob_sha,
        size_bytes      = EXCLUDED.size_bytes,
        status          = 'fetched',
        fail_count      = 0,
        last_error      = NULL,
        fetched_at      = now(),
        updated_at      = now()
      WHERE copilot_assets.source_id = EXCLUDED.source_id
        AND copilot_assets.slug = EXCLUDED.slug`;
    return result.count > 0;
  } catch (err) {
    await bumpFailCount(input.sourceId, (err as Error).message.slice(0, 200));
    return false;
  }
}

async function bumpFailCount(sourceId: string, message: string): Promise<void> {
  try {
    await sql`
      UPDATE sources
         SET fail_count = fail_count + 1,
             cursor = jsonb_set(COALESCE(cursor, '{}'::jsonb), '{lastError}', to_jsonb(${message.slice(0, 200)}::text), true)
       WHERE id = ${sourceId}`;
  } catch {
    // best-effort; do not cascade failure on the counter itself
  }
}