// W5-3 prompt-score gate: a single LLM call per candidate, uses selection-score-prompt.md to
// extract {promptText, useCase, category}. Mirrors search-score.ts:1-94 so both gates share the
// same safety-valve contract and budget handling — when MODEL_CALLS_ENABLED=false / the model is
// not configured / budget is exhausted, the gate returns null instead of throwing and the worker
// skips the candidate.
//
// Why a dedicated gate (not a branch on scoreSearch):
// - The two prompts return different JSON shapes (scoreSearch → attentionScore; prompt-score → a
//   triple with three nullable fields). Folding both into one function would force a discriminated
//   union and a wider surface for a test that's already split into two test files.
// - Receipts / budget counters use `purpose` as the cost tag; we keep `score_search` for the
//   article path and use `score_prompt` for the prompt path so a budget report can attribute the
//   spend to the right column.
//
// Safety valve contract (matches search-score.ts:8-14):
// - score_prompt returns null on a model outage and the worker skips rather than retries.
// - Other errors (network, parse) DO throw — they are real failures that the worker should log.

import { z } from "zod";
import { chatJson } from "../providers/llm.ts";
import { modelFor } from "../editorial/models.ts";
import { promptText, promptVersion } from "../editorial/prompts.ts";
import type { Candidate } from "../sources/types.ts";

const PROMPT = "selection-score-prompt";
const PROMPT_VERSION = promptVersion(PROMPT);
const SYSTEM = promptText(PROMPT);

/**
 * The prompt's output contract — three nullable fields. All three null means "this material does
 * not contain a reusable prompt" (the LLM returned a 3×null verdict); we still count it as
 * `extracted: false` so the worker can log the noise ratio. The schema matches the prompt's own
 * last instruction: `{"promptText": "...", "useCase": "...", "category": "writing"}` or all null.
 */
const PROMPT_EXTRACT_SCHEMA = z.object({
  promptText: z.string().nullable(),
  useCase: z.string().nullable(),
  category: z.enum(["writing", "image", "study", "research", "design"]).nullable(),
});

export interface PromptExtracted {
  /** The prompt body as the LLM extracted it (verbatim from the material). */
  promptText: string;
  /** A one-line description (≤ 80 chars) of when to use the prompt. */
  useCase: string | null;
  /** One of the five v0.2.1 capability categories; null when the LLM abstained. */
  category: "writing" | "image" | "study" | "research" | "design";
}

export interface ScorePromptResult {
  /** True only when the LLM returned a real, non-empty promptText and a valid category. */
  extracted: boolean;
  /** Set when extracted=true; null otherwise (the worker skips writing such a row). */
  result: PromptExtracted | null;
  /** Diagnostic reason — surfaced in worker logs and skipped_model counters. */
  reason: string;
}

interface ExtractInput {
  title: string;
  url: string;
  excerpt: string | null;
  bodyText: string | null;
  provider: string;
  queryId: string;
  queryText: string;
}

/**
 * Single-call extract gate. Mirrors scoreSearch's safety valve. The prompt forbids the model from
 * rating the material or producing a confidence — it only emits the triple or nulls.
 */
export async function scorePrompt(c: Candidate): Promise<ScorePromptResult> {
  const title = (c.title ?? "").trim();
  if (!title) return { extracted: false, result: null, reason: "no title" };
  const meta = c.searchMeta;
  const input: ExtractInput = {
    title,
    url: c.url,
    excerpt: c.excerpt ?? null,
    bodyText: c.bodyText ?? null,
    provider: meta?.provider ?? "unknown",
    queryId: meta?.queryId ?? "",
    queryText: meta?.queryText ?? "",
  };
  let model: string;
  try {
    model = await modelFor("score");
  } catch (err) {
    return { extracted: false, result: null, reason: `modelFor(score) failed: ${(err as Error).message.slice(0, 120)}` };
  }
  try {
    const res = await chatJson({
      model,
      purpose: "score_prompt",
      subject: `prompt:${input.provider}:${input.url}`,
      promptVersion: PROMPT_VERSION,
      system: SYSTEM,
      user: buildUserPrompt(input),
      schema: PROMPT_EXTRACT_SCHEMA,
      temperature: 0.2,
      maxTokens: 1024,
      timeoutMs: 120_000,
    });
    const data = res.data;
    if (!data.promptText || data.promptText.trim().length === 0) {
      return { extracted: false, result: null, reason: "no promptText" };
    }
    if (!data.category) {
      return { extracted: false, result: null, reason: "no category" };
    }
    return {
      extracted: true,
      result: {
        promptText: data.promptText,
        useCase: data.useCase?.trim() ? data.useCase.trim() : null,
        category: data.category,
      },
      reason: "ok",
    };
  } catch (err) {
    const msg = (err as Error).message;
    if (/disabled|not configured|budget/i.test(msg)) {
      return { extracted: false, result: null, reason: msg.slice(0, 160) };
    }
    throw err;
  }
}

function buildUserPrompt(input: ExtractInput): string {
  const lines: string[] = [
    "请按系统规则从以下搜索结果中抽取结构化提示词字段。只输出 JSON。",
    `【搜索意图】\n${input.queryText || "(unspecified)"}`,
    `【来源 provider】\n${input.provider}`,
    `【标题】\n${input.title}`,
  ];
  if (input.excerpt) lines.push(`【摘要/上下文】\n${input.excerpt.slice(0, 1500)}`);
  if (input.bodyText) lines.push(`【正文】\n${input.bodyText.slice(0, 4000)}`);
  return lines.join("\n\n");
}
