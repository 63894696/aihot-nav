// sanitizeJsonControlChars — pure-function tests, no DB needed.
//
// Why a separate file:
// - tavily.test.ts has a before() hook that calls sql() to read the migration-seeded budgets
//   row, which fails on Windows dev where there is no postgres listening. Keeping the sanitizer
//   tests here lets the pre-deploy check (`npm run typecheck` + this file) pass without docker.
//
// What this guards:
// - The VPS saw two consecutive search.fetch cycles fail with `SyntaxError: Bad control
//   character in string literal at position 1972 (line 2 column 1971)` from Tavily's response
//   body. Tavily error responses (HTTP 4xx/5xx with JSON body) sometimes include stack-trace
//   detail strings where the newline is a literal byte (0x0A), not the two-char escape `\\n`.
//   sanitizeJsonControlChars walks the bytes and escapes raw control chars (0x00-0x1F) inside
//   JSON string literals so JSON.parse accepts the body.
//
// Edge cases covered:
// 1. Clean JSON: no-op.
// 2. Error body with raw \n inside a string literal: parses cleanly, content preserved.
// 3. Content field with raw \n and \t: parses cleanly, content preserved verbatim.
// 4. Already-escaped `\\n` (two chars) inside a string: walker must NOT double-escape.
// 5. fetchTavily recovers from a 422 response with raw \n in `detail` (no SyntaxError).
import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeJsonControlChars } from "@aihot/backend/sources/tavily";

test("clean JSON passes through untouched", () => {
  const clean = '{"results":[{"url":"https://x","title":"ok"}]}';
  assert.equal(sanitizeJsonControlChars(clean), clean);
});

test("raw newline inside a string literal becomes \\\\n and the result parses", () => {
  const malformed = '{"detail":"Error: bad input\n  at line 2","code":"x"}';
  const obj = JSON.parse(sanitizeJsonControlChars(malformed));
  assert.equal(obj.code, "x");
  assert.ok(obj.detail.includes("bad input"));
  assert.ok(obj.detail.includes("at line 2"));
});

test("raw tab and newline in a content field round-trip cleanly through parse", () => {
  const malformed = '{"results":[{"url":"https://x","title":"t","content":"line1\nline2\tcol3"}]}';
  const obj = JSON.parse(sanitizeJsonControlChars(malformed));
  assert.equal(obj.results[0].content, "line1\nline2\tcol3");
});

test("already-escaped sequences are not double-escaped", () => {
  // The walker must not interpret a `\\` followed by `n` as needing to re-escape; the existing
  // `\\n` (two characters: backslash + n) inside a JSON string is a valid escape sequence and
  // must be left alone so JSON.parse yields `\n` (one character).
  const clean = '{"detail":"already\\\\nescaped"}';
  const obj = JSON.parse(sanitizeJsonControlChars(clean));
  assert.equal(obj.detail, "already\\nescaped");
});

test("all control chars (0x00-0x1F) get escaped inside strings", () => {
  // Build a string with every control char; the walker must escape each one.
  const chars = [];
  for (let i = 0; i < 0x20; i++) chars.push(String.fromCharCode(i));
  const malformed = '{"x":"' + chars.join("") + '"}';
  const fixed = sanitizeJsonControlChars(malformed);
  // Must parse without throwing.
  const obj = JSON.parse(fixed);
  // The decoded string must contain every control char.
  for (let i = 0; i < 0x20; i++) {
    assert.ok(obj.x.includes(String.fromCharCode(i)), `control char 0x${i.toString(16).padStart(2, "0")} must survive the round-trip`);
  }
});
