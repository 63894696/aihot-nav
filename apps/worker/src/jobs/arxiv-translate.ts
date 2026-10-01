// arxiv-translate — runs the LLM over papers in the papers table whose status is fetched /
// partial / failed and writes the Chinese title + abstract + key_points back. Status transitions:
// translating -> translated (full) | partial (model returned <2/3 fields) | failed (network).
// A paper whose model call fails is bumped to failed and re-tried up to 3 times, then parked.
//
// Pairs with arxiv-fetch.ts: fetch owns rows status and re-fetch, translate owns translation.
import { z } from "zod";
import { sql } from "@aihot/backend/db";
import { chatJson } from "@aihot/backend/providers/llm";
import { modelFor } from "@aihot/backend/editorial/models";
import { promptText, promptVersion } from "@aihot/backend/editorial/prompts";

const TRANSLATE_PROMPT_VERSION = promptVersion("summarize-arxiv");
const SYSTEM = promptText("summarize-arxiv");

const TRANSLATE_LIMIT = 200;
const MAX_RETRIES = 3;

const Output = z.object({
  titleZh: z.string().trim().min(1),
  abstractZh: z.string().trim().min(1),
  keyPoints: z.array(z.string().trim().min(1)).min(3).max(5),
});

export interface TranslateResult {
  arxivId: string;
  status: "translated" | "partial" | "failed" | "skipped";
  reason?: string;
}

export async function translateArxivPending(opts: { limit?: number; budgetMs?: number } = {}): Promise<TranslateResult[]> {
  const deadline = opts.budgetMs ? Date.now() + opts.budgetMs : Number.POSITIVE_INFINITY;
  const limit = opts.limit ?? TRANSLATE_LIMIT;
  const rows = await sql<{ arxiv_id: string; title_en: string; abstract_en: string; authors: string[]; fail_count: number }[]>`
    SELECT arxiv_id, title_en, abstract_en, authors, fail_count FROM papers
    WHERE status IN ('fetched', 'partial', 'failed') AND fail_count < ${MAX_RETRIES}
    ORDER BY published_at DESC LIMIT ${limit}`;
  const model = await modelFor("translate");
  const results: TranslateResult[] = [];
  for (const row of rows) {
    if (Date.now() > deadline) break;
    results.push(await translateOne(row, model));
  }
  return results;
}

async function translateOne(p: { arxiv_id: string; title_en: string; abstract_en: string; authors: string[]; fail_count: number }, model: string): Promise<TranslateResult> {
  // Mark translating so a parallel run doesn't double-call (arxiv-translate schedule is singleton).
  await sql`UPDATE papers SET status = 'translating' WHERE arxiv_id = ${p.arxiv_id} AND status IN ('fetched','partial','failed')`;
  try {
    const res = await chatJson({
      model,
      purpose: "summarize_arxiv",
      subject: `arxiv:${p.arxiv_id}`,
      promptVersion: TRANSLATE_PROMPT_VERSION,
      system: SYSTEM,
      user: JSON.stringify({ title: p.title_en, abstract: p.abstract_en, authors: p.authors }),
      schema: Output,
      temperature: 0.2,
      maxTokens: 4000,
      timeoutMs: 120_000,
    });
    const out = res.data;
    const complete = !!out.titleZh && !!out.abstractZh && out.keyPoints.length >= 3;
    const status = complete ? "translated" : "partial";
    await sql`
      INSERT INTO papers (arxiv_id, title_en, abstract_en, authors, primary_category, categories, pdf_url, abs_url, source_id, published_at, fetched_at,
                          title_zh, abstract_zh, key_points, translated_at, status, fail_count, summary_model, summary_attempt)
      SELECT arxiv_id, title_en, abstract_en, authors, primary_category, categories, pdf_url, abs_url, source_id, published_at, fetched_at,
             ${out.titleZh}, ${out.abstractZh}, ${out.keyPoints}, now(), ${status}, 0, ${res.model}, summary_attempt + 1
      FROM papers WHERE arxiv_id = ${p.arxiv_id}
      ON CONFLICT (arxiv_id) DO UPDATE SET
        title_zh = EXCLUDED.title_zh, abstract_zh = EXCLUDED.abstract_zh, key_points = EXCLUDED.key_points,
        translated_at = EXCLUDED.translated_at, status = EXCLUDED.status, fail_count = 0,
        summary_model = EXCLUDED.summary_model, summary_attempt = EXCLUDED.summary_attempt`;
    return { arxivId: p.arxiv_id, status: complete ? "translated" : "partial" };
  } catch (error) {
    const message = (error as Error).message.slice(0, 300);
    const nextFailCount = p.fail_count + 1;
    const terminal = nextFailCount >= MAX_RETRIES;
    // Disabled model calls or a budget blowup: keep the row pending (don't count a fail), so the next
    // scheduled run retries without burning the 3-strikes budget.
    if (/disabled|not configured|budget/i.test(message)) {
      await sql`UPDATE papers SET status = 'fetched' WHERE arxiv_id = ${p.arxiv_id} AND status = 'translating'`;
      return { arxivId: p.arxiv_id, status: "skipped", reason: message };
    }
    await sql`
      UPDATE papers SET status = ${terminal ? "failed" : "fetched"}, fail_count = ${nextFailCount}
      WHERE arxiv_id = ${p.arxiv_id} AND status = 'translating'`;
    return { arxivId: p.arxiv_id, status: "failed", reason: message };
  }
}