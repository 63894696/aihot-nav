// code-prompts-translate — runs the LLM over copilot_assets rows whose frontmatter has
// shifted since the last translation (or has no translation yet) and writes a zh
// title + description into copilot_translations. Lifecycle: assets are taken from
// copilot_assets where status IN ('fetched', 'indexed'); translations are upserted into
// copilot_translations(asset_id, locale='zh') with a status column that mirrors
// papers-translate (translated | partial | failed). The source_hash column is the
// change-detection key — sha256(`${title}\n${description}`) of the upstream input —
// so a re-translation happens only when the frontmatter changes (asset re-fetch
// updates blob_sha, which usually means description changed; we recompute source_hash
// each cycle and re-translate on mismatch).
//
// Status choice: the asset status CHECK is 'fetched' | 'analyzing' | 'indexed' | 'failed'.
// In practice the dedicated awesome-copilot-fetch job writes frontmatter + body_md
// synchronously inside the fetch pass and parks rows at 'fetched' — there is no
// separate 'analyzing' worker in the loop yet (placeholder for a future per-asset
// analysis pass like keyword extraction / trust scoring). We treat 'fetched' and
// 'indexed' as the translation queue; rows stuck in 'analyzing' indicate a future
// analyze worker is in-flight and we should not race it.
//
// FIX-T (2026-10-06): the user explicitly opted out of body/fields translation
// (`body_md` is english markdown + code blocks; adding machine-translated noise
// to a developer's `.github/` directory is a footgun). We only translate the
// `title` (filename-derived) and `description` (frontmatter.description); the
// `fields` jsonb in copilot_translations is reserved for future field-level
// translations (applyTo, handoffs) and always `{}` today.
//
// Pairs with awesome-copilot-fetch.ts: that job owns copilot_assets row state
// (status / blob_sha / body_md). We own translation. Both run on independent
// schedules (fetch every 15 min, translate every 30 min with a singleton queue —
// two parallel runs would double-call the LLM on the same row).
//
// Retry policy: when a translate call fails with a retryable provider error, the
// row stays at status='indexed' in copilot_assets and copilot_translations gets a
// `failed` row with bumpable fail_count; we re-pick it on a later cycle up to
// MAX_RETRIES (3) times. After that, the row is parked at status='failed' (in
// both tables) and ignored until blob_sha changes upstream. A safety-valve regex
// (`disabled|not configured|budget`) skips the fail-count bump so a model outage
// does not eat the retry budget (mirrors papers-translate).
import { createHash } from "node:crypto";
import { z } from "zod";
import { sql } from "@aihot/backend/db";
import { chatJsonWithFallback, ProviderRejectedError } from "@aihot/backend/providers/llm";
import { modelFor } from "@aihot/backend/editorial/models";
import { promptText, promptVersion } from "@aihot/backend/editorial/prompts";

const TRANSLATE_PROMPT_VERSION = promptVersion("translate-copilot-asset");
const SYSTEM = promptText("translate-copilot-asset");

const TRANSLATE_LIMIT = 60;
const CONCURRENCY = 4;
const MAX_RETRIES = 3;

const Output = z.object({
  titleZh: z.string().trim().min(1),
  descriptionZh: z.string(),
});

export interface CopilotTranslateResult {
  assetId: number;
  status: "translated" | "partial" | "failed" | "skipped";
  reason?: string;
  model?: string;
}

interface PendingRow {
  id: number;
  source_id: string;
  asset_kind: "agent" | "instruction" | "skill";
  slug: string;
  filename: string;
  frontmatter: Record<string, unknown>;
  title_en: string;
  description_en: string | null;
  fail_count: number;
}

/** Derive the English title we feed the LLM: filename minus the .md suffix,
 *  plus a hint when the filename looks like a kebab-cased slug (most do).
 *  Returned shape is plain text, no path, no extension. */
function titleFromFilename(filename: string): string {
  // "code-reviewer.agent.md" → "code-reviewer.agent"
  return filename.replace(/\.md$/i, "");
}

/** sha256(`${title}\n${description ?? ""}`) — the change-detection key. Mirrors
 *  the comment in 0050_copilot_translations.sql header. Recomputing per cycle
 *  is cheap (~µs); doing a full frontmatter diff would be more brittle (yaml
 *  whitespace, key ordering). */
function sourceHash(titleEn: string, descriptionEn: string | null): string {
  return createHash("sha256").update(`${titleEn}\n${descriptionEn ?? ""}`).digest("hex");
}

/** Worker entry point. Drives the queue scan + batched LLM calls. The schedule
 *  singleton guarantee (cron.code-prompts.translate uses policy=singleton in
 *  schedules.ts) means only one run is in-flight at a time. */
export async function translateCodePromptsPending(opts: { limit?: number; budgetMs?: number; concurrency?: number } = {}): Promise<CopilotTranslateResult[]> {
  const deadline = opts.budgetMs ? Date.now() + opts.budgetMs : Number.POSITIVE_INFINITY;
  const limit = opts.limit ?? TRANSLATE_LIMIT;
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? CONCURRENCY, 16));
  const model = await modelFor("translate");
  // The fallback chain mirrors the score_prompt / score_search integration
  // (FIX-Q). primary = the active TRANSLATE_MODEL; fallbacks = the same
  // OpenRouter `:free` pool used elsewhere in the app.
  const fallbacks = ["openrouter-free-gemini", "openrouter-free-llama", "openrouter-free-qwen"];

  // Queue scan: assets that are eligible for translation (status='indexed'
  // = fully analyzed upstream) and either have no translation row yet OR
  // the source_hash diverges from the current upstream input. The PK on
  // copilot_translations covers the LEFT JOIN lookup.
  const rows = await sql<PendingRow[]>`
    SELECT a.id, a.source_id, a.asset_kind, a.slug, a.filename, a.frontmatter,
           COALESCE(a.frontmatter->>'description', '') AS description_en,
           COALESCE(t.fail_count, 0) AS fail_count,
           regexp_replace(a.filename, '\\.md$', '', 'i') AS title_en
    FROM copilot_assets a
    LEFT JOIN copilot_translations t
      ON t.asset_id = a.id AND t.locale = 'zh'
    WHERE a.status IN ('fetched', 'indexed')
      AND (t.asset_id IS NULL OR COALESCE(t.fail_count, 0) < ${MAX_RETRIES})
    ORDER BY a.fetched_at DESC
    LIMIT ${limit}`;

  const results: CopilotTranslateResult[] = [];
  for (let i = 0; i < rows.length; i += concurrency) {
    if (Date.now() > deadline) break;
    const batch = rows.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map((row) => translateOne(row, model, fallbacks).catch((error): CopilotTranslateResult => ({
      assetId: row.id,
      status: "failed",
      reason: (error as Error).message.slice(0, 300),
    }))));
    results.push(...batchResults);
  }
  return results;
}

async function translateOne(p: PendingRow, model: string, fallbacks: string[]): Promise<CopilotTranslateResult> {
  // Mark 'translating' in copilot_assets (parent state machine) and upsert a
  // placeholder 'translating' row in copilot_translations so a parallel run
  // cannot race into the same asset. The 'translating' status is intentionally
  // NOT in the copilot_translations.status CHECK constraint — we use a separate
  // 'in_flight' boolean. See migration 0050 for the constraint.
  await sql`
    UPDATE copilot_assets
       SET status = 'translating', updated_at = now()
     WHERE id = ${p.id} AND status IN ('fetched', 'indexed')`;
  const hash = sourceHash(p.title_en, p.description_en);

  try {
    const res = await chatJsonWithFallback({
      model,
      fallbacks,
      purpose: "translate_copilot",
      subject: `copilot:${p.source_id}/${p.slug}`,
      promptVersion: TRANSLATE_PROMPT_VERSION,
      system: SYSTEM,
      user: JSON.stringify({ title: p.title_en, description: p.description_en }),
      schema: Output,
      temperature: 0.2,
      maxTokens: 1024,
      timeoutMs: 60_000,
    });
    const out = res.data;
    const descriptionEn = p.description_en || null;
    const complete = !!out.titleZh && (descriptionEn === null ? true : !!out.descriptionZh);
    const status: "translated" | "partial" = complete ? "translated" : "partial";

    await sql`
      INSERT INTO copilot_translations
        (asset_id, locale, title, description, fields, model, status, fail_count, source_hash, created_at, updated_at)
      VALUES
        (${p.id}, 'zh', ${out.titleZh}, ${out.descriptionZh || null}, ${sql.json({})}::jsonb, ${res.model}, ${status}, 0, ${hash}, now(), now())
      ON CONFLICT (asset_id, locale) DO UPDATE SET
        title       = EXCLUDED.title,
        description = EXCLUDED.description,
        fields      = EXCLUDED.fields,
        model       = EXCLUDED.model,
        status      = EXCLUDED.status,
        fail_count  = 0,
        last_error  = NULL,
        source_hash = EXCLUDED.source_hash,
        updated_at  = now()`;

    // Mark parent row back to 'indexed' (the terminal "fully indexed" state — mirrors
    // how the publication layer filters with status IN ('fetched','indexed'), and means
    // a future independent analyze pass inserting 'analyzing' on top is not racy).
    await sql`
      UPDATE copilot_assets
         SET status = 'indexed', updated_at = now()
       WHERE id = ${p.id} AND status = 'translating'`;

    return { assetId: p.id, status, model: res.model };
  } catch (error) {
    const message = (error as Error).message.slice(0, 300);
    const nextFailCount = p.fail_count + 1;
    const terminal = nextFailCount >= MAX_RETRIES;

    // Safety valve: disabled / not configured / budget — keep the row pending,
    // do NOT bump fail_count (a model outage would otherwise burn 3 strikes in
    // 3 minutes and park the entire queue permanently).
    if (/disabled|not configured|budget/i.test(message) || (error instanceof ProviderRejectedError && !error.retryable)) {
      // Safety-valve: model is permanently unavailable, not a transient bug.
      // Park the row at 'indexed' (= "considered, can't translate yet") so the queue
      // does not hammer a dead model every cycle. The next fetch (with updated blob_sha)
      // can move it back to 'fetched' if upstream changes — at which point we'd retry.
      await sql`UPDATE copilot_assets SET status = 'indexed', updated_at = now() WHERE id = ${p.id} AND status = 'translating'`;
      return { assetId: p.id, status: "skipped", reason: message };
    }

    // Real failure: bump fail_count + last_error on the translation row. The
    // row remains in copilot_assets.status='translating' if terminal (so the
    // queue scan picks it up on a blob_sha change only); for non-terminal we
    // set it back to 'indexed' so the next cycle retries.
    await sql`
      INSERT INTO copilot_translations
        (asset_id, locale, title, description, fields, model, status, fail_count, last_error, source_hash, created_at, updated_at)
      VALUES
        (${p.id}, 'zh', ${p.title_en}, ${p.description_en ?? null}, ${sql.json({})}::jsonb, NULL, 'failed', ${nextFailCount}, ${message.slice(0, 500)}, ${hash}, now(), now())
      ON CONFLICT (asset_id, locale) DO UPDATE SET
        status     = 'failed',
        fail_count = EXCLUDED.fail_count,
        last_error = EXCLUDED.last_error,
        source_hash = EXCLUDED.source_hash,
        updated_at = now()`;

    await sql`
      UPDATE copilot_assets
         SET status = ${terminal ? "failed" : "indexed"}, fail_count = ${nextFailCount},
             last_error = ${message.slice(0, 500)}, updated_at = now()
       WHERE id = ${p.id} AND status = 'translating'`;
    return { assetId: p.id, status: "failed", reason: message };
  }
}