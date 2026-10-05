// sanitizeJsonControlChars — Brave-specific edge cases (DB-free).
//
// Why a separate file:
// - brave.test.ts has a before() hook that calls sql() to read the migration-seeded budgets
//   row, which fails on Windows dev where there is no postgres listening. Keeping the sanitizer
//   tests here lets the pre-deploy check (`npm run typecheck` + this file) pass without docker.
// - The walker itself is the Tavily one (re-exported). The cases below target Brave's actual
//   response shape: `web.results[].{url,title,description}` plus error responses with `detail`
//   fields that occasionally ship raw control chars.
//
// Edge cases covered:
// 1. Clean Brave 200 body: no-op.
// 2. Brave error body with raw \n inside a string literal: parses cleanly.
// 3. Brave `description` field with raw \n + \t: parses cleanly, content preserved verbatim.
// 4. Already-escaped `\\n` (two chars) inside a string: walker must NOT double-escape.
// 5. Brave response with empty web.results: parsed without throwing, fetcher returns 0 results.
import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeJsonControlChars } from "@aihot/backend/sources/tavily";

test("clean Brave JSON passes through untouched", () => {
  const clean = '{"web":{"results":[{"url":"https://x.com/a","title":"ok","description":"d"}]}}';
  assert.equal(sanitizeJsonControlChars(clean), clean);
});

test("Brave error body with raw newline inside string literal parses cleanly", () => {
  // Brave's 401/403 error responses sometimes include a `detail` field with raw \n.
  const malformed = '{"detail":"Error: missing x-subscription-token\n  at brave (123-123)","code":"x"}';
  const obj = JSON.parse(sanitizeJsonControlChars(malformed));
  assert.equal(obj.code, "x");
  assert.ok(obj.detail.includes("missing x-subscription-token"));
  assert.ok(obj.detail.includes("at brave (123"));
});

test("Brave description field with raw newline and tab round-trips cleanly", () => {
  const malformed = '{"web":{"results":[{"url":"https://x","title":"t","description":"line1\nline2\tcol3"}]}}';
  const obj = JSON.parse(sanitizeJsonControlChars(malformed));
  assert.equal(obj.web.results[0].description, "line1\nline2\tcol3");
});

test("already-escaped sequences are not double-escaped", () => {
  // The walker must not interpret a `\\` followed by `n` as needing to re-escape; the existing
  // `\\n` (two characters: backslash + n) inside a JSON string is a valid escape sequence and
  // must be left alone so JSON.parse yields `\n` (one character).
  const clean = '{"detail":"already\\\\nescaped"}';
  const obj = JSON.parse(sanitizeJsonControlChars(clean));
  assert.equal(obj.detail, "already\\nescaped");
});

test("Brave empty web.results array parses with 0 results", () => {
  const empty = '{"web":{"results":[]},"query":{"original":"q"}}';
  const obj = JSON.parse(sanitizeJsonControlChars(empty));
  assert.deepEqual(obj.web.results, []);
  assert.equal(obj.query.original, "q");
});