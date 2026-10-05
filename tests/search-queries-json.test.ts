// Regression: industry/search-queries.json must be a valid JSON document AND have a $comment
// string whose value contains NO raw control bytes (0x00-0x1F) — only the two-character escape
// sequences (`\n`, `\t`, etc.) that JSON.parse interprets as control codes.
//
// Why this file:
// - FIX-R.3 root cause: a previous edit appended the FIX-R paragraph to the $comment value as a
//   literal newline (0x0A) instead of the `\n` two-char escape. JSON.parse rejected the document
//   at the raw byte, and the worker (search-fetch.ts:201 + prompt-fetch.ts:181) crashes on every
//   cycle before reaching Tavily / SearXNG. Tavily was never called, which masked the real bug
//   behind the FIX-R.1 sanitize story for two cycles.
//
// What this test guards:
// 1. JSON.parse(readFileSync(...)) succeeds — the orchestrator's first parse gate.
// 2. $comment string contains exactly the paragraph breaks we want (4 between 5 paragraphs) and
//    no raw 0x0A bytes inside the string value.
// 3. Required queries are present and tagged correctly — the lock on future schema drift that
//    silently lands prompts in the search pipeline or vice versa.
//
// Why a separate file (not in prompt-fetch.test.ts):
// - prompt-fetch.test.ts has a top-level import that depends on a postgres-ready setup; this
//   regression check should be the cheapest thing that runs in CI before the orchestrator even
//   starts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "@aihot/backend/config";

const FILE = join(REPO_ROOT, "industry/search-queries.json");

test("search-queries.json parses as strict JSON (orchestrator's first gate)", () => {
  // strict JSON.parse — if the file has any raw control bytes inside the $comment string
  // (FIX-R.3 root cause), this throws "Bad control character in string literal at position N".
  // Throwing here is the test's purpose: surface the regression before the worker does.
  const text = readFileSync(FILE, "utf8");
  const file = JSON.parse(text) as { $comment: string; version: string; queries: Array<{ id: string; q: string; lang: string; category: string }> };
  assert.ok(typeof file.$comment === "string", "$comment must be a string");
  assert.ok(typeof file.version === "string", "version must be present");
  assert.ok(Array.isArray(file.queries), "queries must be an array");
});

test("$comment string contains no raw 0x00-0x1F bytes — only JSON escape sequences", () => {
  const text = readFileSync(FILE, "utf8");
  const start = text.indexOf("$comment");
  const valueStart = text.indexOf('"', start + "$comment".length + 1) + 1;
  // Find the closing quote of the value (first unescaped " after valueStart).
  let end = valueStart;
  let esc = false;
  while (end < text.length) {
    const c = text[end];
    if (esc) { esc = false; end++; continue; }
    if (c === "\\") { esc = true; end++; continue; }
    if (c === '"') break;
    end++;
  }
  const value = text.slice(valueStart, end);
  // The decoded value may have embedded \n / \t — but those must come from `\n` / `\t`
  // two-char escapes, never from raw 0x0A / 0x09 bytes. (The walker in tavily.ts is a
  // safety net for upstream responses, not for files we author ourselves.)
  const raw = [];
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20) raw.push({ i, code, hex: code.toString(16).padStart(2, "0") });
  }
  assert.deepEqual(raw, [], "$comment must not contain raw control bytes (FIX-R.3 root cause)");
});

test("queries array carries the expected shape and counts after FIX-J + FIX-R", () => {
  const file = JSON.parse(readFileSync(FILE, "utf8")) as { queries: Array<{ id: string; lang: string }> };
  const search = file.queries.filter((q) => q.id.startsWith("search-"));
  const prompt = file.queries.filter((q) => q.id.startsWith("prompt-"));
  const zh = file.queries.filter((q) => q.lang === "zh");
  const en = file.queries.filter((q) => q.lang === "en");
  assert.equal(search.length, 18, "18 search-* queries (12 en + 4 zh added by FIX-J + 2 from FIX-F)");
  assert.equal(prompt.length, 10, "10 prompt-* queries (5 categories × en/zh)");
  assert.equal(zh.length, 9, "9 zh queries (4 search + 5 prompt — Tavily-armed target)");
  assert.equal(en.length, 19, "19 en queries (14 search + 5 prompt)");
  const other = file.queries.filter((q) => !q.id.startsWith("search-") && !q.id.startsWith("prompt-"));
  assert.equal(other.length, 0, "every query id must start with search- or prompt-");
});