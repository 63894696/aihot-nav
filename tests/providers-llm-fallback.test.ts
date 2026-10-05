// FIX-Q chatJsonWithFallback coverage: primary → fallback chain behaviour, retryable vs not, and
// safety-valve contract. Mirrors tests/default-model.test.ts stub patterns.
import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { MODELS, chatJsonWithFallback, ProviderRejectedError } from "@aihot/backend/providers/llm";

const T = tag();
const seen: Array<{ provider: "primary" | "or"; model: string; status: number }> = [];

// Two stubs: a primary provider (LLM_BASE_URL) and an OpenRouter-shaped fallback (OPENROUTER_BASE_URL).
// They share a recorder so the assertion list is in invocation order.
function buildAnswer(getStatus: () => number, provider: "primary" | "or", modelName: string) {
  return (_hit: number, req: { url: string; body: string }) => {
    const body = JSON.parse(req.body) as { model: string };
    seen.push({ provider, model: body.model, status: getStatus() });
    if (getStatus() !== 200) {
      return new Reply(getStatus(), { error: { message: `stub-${provider}-${getStatus()}`, type: "stub_error" } });
    }
    return {
      id: `stub-${seen.length}`,
      choices: [{ message: { content: JSON.stringify({ attentionScore: 80 }) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
  };
}

let primaryStatus = 200;
let orStatus = 200;
const primary = await stub(buildAnswer(() => primaryStatus, "primary", "MiniMax-M3"));
const or = await stub(buildAnswer(() => orStatus, "or", "openrouter-free-XXX"));

// Enable paid paths and point both env surfaces at our stubs.
Object.assign(process.env, {
  LLM_BASE_URL: `${primary.url}/v1`,
  LLM_API_KEY: "primary-key",
  LLM_MODEL: "MiniMax-M3",
  MODEL_CALLS_ENABLED: "true",
  OPENROUTER_BASE_URL: `${or.url}/v1`,
  OPENROUTER_API_KEY: "or-key",
});

const SCHEMA = { parse: (x: unknown) => x } as never;

before(async () => {
  // seed stub counters
  seen.length = 0;
});

after(async () => {
  await primary.close();
  await or.close();
  await closeDb();
});

async function reset() {
  seen.length = 0;
  primaryStatus = 200;
  orStatus = 200;
}

test("MODELS preset has the three openrouter :free variants", () => {
  assert.ok(MODELS["openrouter-free-gemini"]);
  assert.ok(MODELS["openrouter-free-llama"]);
  assert.ok(MODELS["openrouter-free-qwen"]);
  for (const k of ["openrouter-free-gemini", "openrouter-free-llama", "openrouter-free-qwen"]) {
    assert.equal(MODELS[k].service, "openrouter");
    assert.equal(MODELS[k].apiKeyEnv, "OPENROUTER_API_KEY");
    assert.match(MODELS[k].model, /:free$/);
  }
});

test("primary OK → no fallback", async () => {
  await reset();
  const res = await chatJsonWithFallback({
    model: "default",
    fallbacks: ["openrouter-free-gemini", "openrouter-free-llama", "openrouter-free-qwen"],
    purpose: "test",
    subject: `subj-${T}-1`,
    promptVersion: "test",
    system: "",
    user: "{}",
    schema: SCHEMA,
  });
  assert.equal(res.attempts.length, 1);
  assert.equal(res.attempts[0]!.model, "default");
  assert.equal((res.data as { attentionScore: number }).attentionScore, 80);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.provider, "primary");
});

test("primary 503 → automatically falls back to OR", async () => {
  await reset();
  primaryStatus = 503;
  const res = await chatJsonWithFallback({
    model: "default",
    fallbacks: ["openrouter-free-gemini", "openrouter-free-llama", "openrouter-free-qwen"],
    purpose: "test",
    subject: `subj-${T}-2`,
    promptVersion: "test",
    system: "",
    user: "{}",
    schema: SCHEMA,
  });
  assert.equal(res.attempts.length, 2, "primary failed then one OR tried");
  assert.equal(res.attempts[0]!.model, "default");
  assert.match(res.attempts[0]!.error ?? "", /HTTP 503/);
  assert.match(res.attempts[1]!.model, /^openrouter-free-/);
  assert.equal(res.model, res.attempts[1]!.model);
});

test("primary 'not configured' (safety-valve regex) → falls back", async () => {
  await reset();
  // Override LLM_API_KEY to empty to trigger "not configured" branch in primary chatJson.
  const saved = process.env.LLM_API_KEY;
  process.env.LLM_API_KEY = "";
  try {
    const r = await chatJsonWithFallback({
      model: "default",
      fallbacks: ["openrouter-free-llama"],
      purpose: "test",
      subject: `subj-${T}-3`,
      promptVersion: "test",
      system: "",
      user: "{}",
      schema: SCHEMA,
    });
    assert.equal(r.attempts.length, 2);
    assert.match(r.attempts[0]!.error ?? "", /not configured/);
    assert.equal(r.attempts[1]!.model, "openrouter-free-llama");
  } finally {
    process.env.LLM_API_KEY = saved;
  }
});

test("all candidates fail retryable → throws last ProviderRejectedError(retryable)", async () => {
  await reset();
  primaryStatus = 503;
  orStatus = 503;
  await assert.rejects(
    chatJsonWithFallback({
      model: "default",
      fallbacks: ["openrouter-free-gemini", "openrouter-free-llama", "openrouter-free-qwen"],
      purpose: "test",
      subject: `subj-${T}-4`,
      promptVersion: "test",
      system: "",
      user: "{}",
      schema: SCHEMA,
    }),
    (err: unknown) => err instanceof ProviderRejectedError && err.retryable === true,
  );
  assert.equal(seen.length, 4, "1 primary + 3 OR — every candidate tried");
});

test("OR first two return 429 → the third succeeds (rotation)", async () => {
  await reset();
  primaryStatus = 429;
  // OR-stub returns the same global orStatus. Use a counter-driven answer instead via a per-stub closure.
  // Easier path: rebuild or stub with per-model logic. Instead, just verify that the chosen order produces
  // at least 2 OR attempts and one of them succeeded. Set up: OR first attempts fail, second succeeds.
  let orHits = 0;
  const orRotate = await stub((_h, req) => {
    const body = JSON.parse(req.body) as { model: string };
    orHits += 1;
    seen.push({ provider: "or", model: body.model, status: 200 });
    // First two OR hits = 429, third = 200
    if (orHits <= 2) return new Reply(429, { error: { message: "rate limit" } });
    return { id: `stub-${orHits}`, choices: [{ message: { content: JSON.stringify({ attentionScore: 80 }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
  });
  const savedOrUrl = process.env.OPENROUTER_BASE_URL;
  process.env.OPENROUTER_BASE_URL = `${orRotate.url}/v1`;
  try {
    const r = await chatJsonWithFallback({
      model: "default",
      fallbacks: ["openrouter-free-gemini", "openrouter-free-llama", "openrouter-free-qwen"],
      purpose: "test",
      subject: `subj-${T}-5`,
      promptVersion: "test",
      system: "",
      user: "{}",
      schema: SCHEMA,
    });
    assert.equal(r.attempts.length, 4, "primary + 2 OR fail + 1 OR OK");
    assert.match(r.model, /^openrouter-free-/);
  } finally {
    process.env.OPENROUTER_BASE_URL = savedOrUrl;
    await orRotate.close();
  }
});

test("ModelOutputError (parse / content unusable) is NOT a fallback trigger", async () => {
  await reset();
  // Primary returns 200 but unparseable content — chatJson will throw ModelOutputError after extractJson.
  const badPrimary = await stub(() => {
    seen.push({ provider: "primary", model: "ok", status: 200 });
    return { id: "x", choices: [{ message: { content: "not json at all" } }], usage: {} };
  });
  const savedBase = process.env.LLM_BASE_URL;
  process.env.LLM_BASE_URL = `${badPrimary.url}/v1`;
  try {
    await assert.rejects(
      chatJsonWithFallback({
        model: "default",
        fallbacks: ["openrouter-free-llama"],
        purpose: "test",
        subject: `subj-${T}-6`,
        promptVersion: "test",
        system: "",
        user: "{}",
        schema: SCHEMA,
      }),
      (err: unknown) => err instanceof Error && err.name === "ModelOutputError",
    );
    // Only the primary was tried — OR was NOT called.
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.provider, "primary");
  } finally {
    process.env.LLM_BASE_URL = savedBase;
    await badPrimary.close();
  }
});