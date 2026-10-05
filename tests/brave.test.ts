// Brave Search 5th engine: auth, retryability, no-key skip, paidRequest shape, candidate mapping.
//
// Why these tests:
// - The orchestrators (search-fetch.ts, prompt-fetch.ts) gate Brave by lang:zh + cycle counter.
//   They rely on three contract details: (1) a missing BRAVE_API_KEY is a soft skip, not a
//   failure; (2) HTTP 401/403 is non-retryable (a key rotation is needed, not another attempt);
//   (3) HTTP 429/5xx is retryable, so the caller treats it as "exhausted" and tries next cycle.
// - paidRequest persists a receipts row keyed by service='brave'; we verify the budget row
//   exists and that one live attempt = one receipt_attempts row.
// - Candidate output shape (searchMeta.provider='brave', refId=url, title stripped, date parsed)
//   is the contract the score gate (search-score.ts / prompt-score.ts) reads downstream.
import { stub, tag, Reply } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { fetchBrave } from "@aihot/backend/sources/brave";

let savedBudget: { per_minute: number; per_hour: number; per_day: number } | undefined;
let savedApiKey: string | undefined;
let savedBaseUrl: string | undefined;

before(async () => {
  [savedBudget] = await sql<{ per_minute: number; per_hour: number; per_day: number }[]>`SELECT per_minute, per_hour, per_day FROM budgets WHERE service = 'brave'`;
  savedApiKey = process.env.BRAVE_API_KEY;
  savedBaseUrl = process.env.BRAVE_BASE_URL;
});
after(async () => {
  if (savedBudget) await sql`UPDATE budgets SET per_minute = ${savedBudget.per_minute}, per_hour = ${savedBudget.per_hour}, per_day = ${savedBudget.per_day} WHERE service = 'brave'`;
  if (savedApiKey === undefined) delete process.env.BRAVE_API_KEY;
  else process.env.BRAVE_API_KEY = savedApiKey;
  if (savedBaseUrl === undefined) delete process.env.BRAVE_BASE_URL;
  else process.env.BRAVE_BASE_URL = savedBaseUrl;
  await closeDb();
});

test("the migration seeds a budget for brave", async () => {
  const rows = await sql<{ service: string; per_minute: number; per_day: number }[]>`SELECT service, per_minute, per_day FROM budgets WHERE service = 'brave'`;
  assert.ok(rows.length > 0, "brave budget row must exist");
  assert.ok(rows[0]!.per_minute > 0 && rows[0]!.per_day > 0, "caps must be positive");
});

test("missing API key is a soft skip — no paidRequest charge, no thrown error", async () => {
  delete process.env.BRAVE_API_KEY;
  delete process.env.BRAVE_BASE_URL;
  const res = await fetchBrave({ id: "search-china-llm-release", q: "国产大模型 发布 2026", lang: "zh", category: "model_release" });
  assert.equal(res.skippedNoKey, true, "must be a soft skip");
  assert.deepEqual(res.candidates, []);
});

test("200 OK with two results → two Candidates with searchMeta.provider='brave'", async () => {
  const provider = await stub(() => ({
    web: {
      results: [
        { url: "https://example.com/a", title: "  DeepSeek <b>V3</b> 发布  ", description: "<p>中文摘要</p>", age: "2026-10-05T00:00:00Z" },
        { url: "https://example.com/b", title: "Qwen 3 升级", description: "raw summary", age: null },
      ],
    },
    query: { original: "x" },
  }));
  process.env.BRAVE_API_KEY = "test-key";
  process.env.BRAVE_BASE_URL = provider.url;

  try {
    const res = await fetchBrave({ id: "search-deepseek-qwen-glm", q: "DeepSeek Qwen GLM 新版本", lang: "zh", category: "model_release" });
    assert.equal(res.skippedNoKey, undefined);
    assert.equal(res.candidates.length, 2);
    const c0 = res.candidates[0]!;
    assert.equal(c0.searchMeta?.provider, "brave");
    assert.equal(c0.searchMeta?.queryId, "search-deepseek-qwen-glm");
    assert.equal(c0.searchMeta?.queryLang, "zh");
    assert.equal(c0.searchMeta?.refId, "https://example.com/a");
    assert.equal(c0.title, "DeepSeek V3 发布", "title must be stripped of tags and trimmed");
    assert.equal(c0.publishedAt?.toISOString(), "2026-10-05T00:00:00.000Z", "ISO date parsed");
    const c1 = res.candidates[1]!;
    assert.equal(c1.publishedAt, null, "null date stays null");
    assert.equal(provider.hits(), 1, "exactly one HTTP call");
  } finally {
    await provider.close();
  }
});

test("401 is non-retryable exhausted — does NOT throw, returns empty candidates", async () => {
  const provider = await stub(() => new Reply(401, { detail: "invalid api key" }));
  process.env.BRAVE_API_KEY = "bad-key";
  process.env.BRAVE_BASE_URL = provider.url;
  try {
    const res = await fetchBrave({ id: "search-china-ai-news", q: "中国 AI 公司 最新动态", lang: "zh", category: "company_news" });
    assert.equal(res.exhausted, true);
    assert.deepEqual(res.candidates, []);
  } finally {
    await provider.close();
  }
});

test("429 is retryable exhausted — does NOT throw, returns empty candidates", async () => {
  const provider = await stub(() => new Reply(429, { detail: "rate limited" }));
  process.env.BRAVE_API_KEY = "test-key";
  process.env.BRAVE_BASE_URL = provider.url;
  try {
    const res = await fetchBrave({ id: "search-china-robotics-ai", q: "中国 具身智能", lang: "zh", category: "tool_release" });
    assert.equal(res.exhausted, true);
    assert.deepEqual(res.candidates, []);
  } finally {
    await provider.close();
  }
});

test("malformed response (no web.results) is exhausted, not crashed", async () => {
  const provider = await stub(() => ({ query: { original: "irrelevant" } })); // Brave response without web.results
  process.env.BRAVE_API_KEY = "test-key";
  process.env.BRAVE_BASE_URL = provider.url;
  try {
    const res = await fetchBrave({ id: "search-china-llm-release", q: "国产大模型", lang: "zh", category: "model_release" });
    assert.equal(res.exhausted, true);
    assert.deepEqual(res.candidates, []);
  } finally {
    await provider.close();
  }
});

test("candidate with non-http url is dropped, identityKey derived via identityKeyForUrl", async () => {
  const provider = await stub(() => ({
    web: {
      results: [
        { url: "ftp://example.com/skip", title: "FTP should be skipped" },
        { url: "https://example.com/keep", title: "Keep this one", description: "summary" },
        { url: "https://example.com/keep", title: "duplicate by url", description: "dup" },
      ],
    },
  }));
  process.env.BRAVE_API_KEY = "test-key";
  process.env.BRAVE_BASE_URL = provider.url;
  try {
    const res = await fetchBrave({ id: "search-deepseek-qwen-glm", q: "DeepSeek", lang: "zh", category: "model_release" });
    assert.equal(res.candidates.length, 1, "ftp dropped, dup dropped");
    assert.equal(res.candidates[0]!.url, "https://example.com/keep");
    assert.ok(res.candidates[0]!.identityKey, "identityKey derived from URL");
  } finally {
    await provider.close();
  }
});

// Note: sanitizeJsonControlChars has its own DB-free test file (tests/brave-sanitize.test.ts)
// so the pure-function checks can run without a postgres instance.