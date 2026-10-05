// W5-2 search-score gate: a single LLM call per candidate, ≥70 enters `publications`.
//
// Why this exists:
// - Search engine candidates (SearXNG, HN Algolia, GitHub Trending) are noisy; the editorial score
//   system calls the LLM twice per article for confidence, but at 12 queries × ~25 hits × 3 sources
//   that's ~900 calls per cycle — too many for our budget.
// - The score gate here is a single pass with a high floor (70). It's lighter than editorial score
//   (one call, not two), and is reused as a hard filter before `upsertMaterial`.
//
// Safety valve contract (matches arxiv-translate.ts:95-98):
// - When MODEL_CALLS_ENABLED=false / SCORE_MODEL not configured / budget exhausted, scoreSearch
//   returns null instead of throwing, so the worker can skip the candidate and continue.
// - Other errors (network, parse) DO throw — they are real failures that the worker should log.

import { z } from "zod";
import { chatJsonWithFallback, ProviderRejectedError } from "../providers/llm.ts";
import { modelFor } from "../editorial/models.ts";
import { promptText, promptVersion } from "../editorial/prompts.ts";
import type { Candidate } from "../sources/types.ts";

const PROMPT = "selection-score";
const PROMPT_VERSION = promptVersion(PROMPT);
const SYSTEM = promptText(PROMPT);

const SCORE_SCHEMA = z.object({ attentionScore: z.coerce.number().int().min(0).max(100) });

/** Threshold above which a search candidate is allowed into `publications`. Tuned high so the editor still filters. */
export const SEARCH_SCORE_THRESHOLD = 70;

export interface ScoreSearchResult {
  passed: boolean;
  score: number | null;
  reason: string;
}

interface ScoreInput {
  title: string;
  url: string;
  excerpt: string | null;
  publishedAt: Date | null;
  provider: string;
  queryId: string;
  queryText: string;
  category: string | null;
}

/**
 * Single-call score gate. Returns `passed=true` when the LLM scores ≥ SEARCH_SCORE_THRESHOLD.
 * Returns `passed=false, score=null, reason=<message>` when the model is unavailable — the worker
 * must skip the candidate rather than treat it as a failure (so the next schedule can retry).
 */
export async function scoreSearch(c: Candidate): Promise<ScoreSearchResult> {
  const title = (c.title ?? "").trim();
  if (!title) return { passed: false, score: null, reason: "no title" };
  const meta = c.searchMeta;
  const input: ScoreInput = {
    title,
    url: c.url,
    excerpt: c.excerpt ?? null,
    publishedAt: c.publishedAt ?? null,
    provider: meta?.provider ?? "unknown",
    queryId: meta?.queryId ?? "",
    queryText: meta?.queryText ?? "",
    category: meta?.queryCategory ?? c.categories?.[0] ?? null,
  };
  let model: string;
  try {
    model = await modelFor("score");
  } catch (err) {
    return { passed: false, score: null, reason: `modelFor(score) failed: ${(err as Error).message.slice(0, 120)}` };
  }
  try {
    const res = await chatJsonWithFallback({
      model,
      fallbacks: ["openrouter-free-gemini", "openrouter-free-llama", "openrouter-free-qwen"],
      purpose: "score_search",
      subject: `search:${input.provider}:${input.url}`,
      promptVersion: PROMPT_VERSION,
      system: SYSTEM,
      user: buildUserPrompt(input),
      schema: SCORE_SCHEMA,
      temperature: 0.2,
      maxTokens: 1024,
      timeoutMs: 120_000,
    });
    const score = res.data.attentionScore;
    return {
      passed: score >= SEARCH_SCORE_THRESHOLD,
      score,
      reason: score >= SEARCH_SCORE_THRESHOLD
        ? (res.attempts.length === 1 ? "ok" : `ok (fallback: ${res.model}, ${res.attempts.length} tried)`)
        : `below ${SEARCH_SCORE_THRESHOLD}`,
    };
  } catch (err) {
    const msg = (err as Error).message;
    if (/disabled|not configured|budget/i.test(msg)) {
      return { passed: false, score: null, reason: msg.slice(0, 160) };
    }
    // chatJsonWithFallback rethrows the last ProviderRejectedError(retryable=true) when every
    // candidate (primary + fallbacks) is unavailable — same safety-valve contract as scorePrompt.
    if (err instanceof ProviderRejectedError && err.retryable) {
      return { passed: false, score: null, reason: `all models rejected (retryable): ${msg.slice(0, 120)}` };
    }
    throw err;
  }
}

/** Score input is short by design — search candidates rarely have full body, and the prompt forbids guessing. */
function buildUserPrompt(input: ScoreInput): string {
  const lines: string[] = [
    "请按系统规则评估以下搜索结果候选所代表的事件。只输出 attentionScore。",
    `【搜索意图】\n${input.queryText || "(unspecified)"}`,
    `【来源 provider】\n${input.provider}`,
  ];
  if (input.publishedAt) {
    const t = input.publishedAt instanceof Date ? input.publishedAt.toISOString() : String(input.publishedAt);
    lines.push(`【发布时间】\n${t}`);
  }
  lines.push(`【标题】\n${input.title}`);
  if (input.excerpt) lines.push(`【摘要/上下文】\n${input.excerpt.slice(0, 1500)}`);
  return lines.join("\n\n");
}
