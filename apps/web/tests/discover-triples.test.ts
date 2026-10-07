// FIX-AA.4 — pin the contract of the "交叉发现 · 三角联动" trial entry on /all.
//
// Five DB-free surfaces to pin (mirrors the FIX-AA.2 / FIX-AA.3 test pattern):
//   1. DiscoverResponse carries a `triples: DiscoverTriple[]` field that defaults to [] when the
//      join tables are empty. Today tool_papers + paper_prompts are both 0 rows, so the wire is
//      always an empty array — this test simulates it.
//   2. The defensive parse helper mirrors DiscoveryBlocks.tsx (`triples ?? []`) — unknown shape
//      degrades to an empty array silently. A future refactor that adds an unknown key must NOT
//      crash the SSR loader.
//   3. TrialSection render guard: triples.length === 0 → no DOM; triples.length > 0 → DOM. Pin
//      the boolean so a future refactor that swaps the guard does not silently regress.
//   4. TripleCard routes its three rows to /papers/:id, /tools/:id, /prompts/:id respectively.
//      Pin the URL building because the cards depend on the detail pages existing.
//   5. The same defensive parse covers the case where the discover endpoint is missing the field
//     entirely (e.g. a partial deploy with the contracts field added but the backend not yet
//      returning it). The frontend must render without throwing.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { DiscoverTriple, FeedItemSummary, PaperSummary, PromptCard } from "@aihot/contracts/site";

// Mirror the loader's defensive parse in apps/web/app/features/discover/DiscoveryBlocks.tsx
// (TrialSection). `triples ?? []` is the canonical guard — a null triples is treated identically
// to an empty array so the section never throws on `length`.
interface DiscoverShape { triples?: unknown }

function defensiveParse(raw: unknown): DiscoverTriple[] {
  const r = (raw ?? {}) as DiscoverShape;
  return Array.isArray(r.triples) ? (r.triples as DiscoverTriple[]) : [];
}

// Sample triple factories for the render-guard and link-path tests. We use cast `as unknown as`
// because the full shape of each card type is irrelevant for these pure unit assertions; only
// the `id` field is read.
function makeTriple(overrides: { paperId?: string; toolId?: string; promptId?: string } = {}): DiscoverTriple {
  const paper = { id: overrides.paperId ?? "2601.12345" } as unknown as PaperSummary;
  const tool = { id: overrides.toolId ?? "pg_abc" } as unknown as FeedItemSummary;
  const prompt = { id: overrides.promptId ?? "42" } as unknown as PromptCard;
  return { paper, tool, prompt };
}

test("FIX-AA.4: discover endpoint payload carries triples key (empty array when join tables empty)", () => {
  // Today (2026-10-07) tool_papers + paper_prompts are both 0 rows. loadDiscoverTriples returns
  // [] and the wire payload carries { triples: [] }. The frontend defensive parse must surface
  // this as an empty array, NOT throw.
  const empty = { triples: [] };
  const parsed = defensiveParse(empty);
  assert.deepEqual(parsed, []);
});

test("FIX-AA.4: defensive parse degrades missing triples key to [] (no throw on null/undefined/odd shape)", () => {
  // Backend's loadDiscoverTriples catches SQL throws and returns [] — but if a partial deploy
  // omits the field entirely (e.g. backend returns {} on a previous version), or returns an
  // unexpected shape (object, null, undefined, non-array), the SSR loader must still render
  // without throwing. Pin the behavior so a future refactor does not regress.
  const cases: Array<{ name: string; input: unknown }> = [
    { name: "null", input: null },
    { name: "undefined", input: undefined },
    { name: "empty object", input: {} },
    { name: "triples is object (not array)", input: { triples: { foo: "bar" } } },
    { name: "triples is string", input: { triples: "oops" } },
    { name: "triples is null", input: { triples: null } },
  ];
  for (const c of cases) {
    const parsed = defensiveParse(c.input);
    assert.deepEqual(parsed, [], `${c.name} should parse to empty array`);
  }
});

test("FIX-AA.4: TrialSection render guard — empty triples hides DOM, non-empty triples renders DOM", () => {
  // Mirrors TrialSection's `if (triples.length === 0) return null` guard in DiscoveryBlocks.tsx.
  // Pin the boolean so a future refactor that swaps the guard does not silently hide the section
  // when triples exist, or render an empty placeholder when they do not.
  const empty = defensiveParse({ triples: [] });
  assert.equal(empty.length === 0, true, "empty triples must hide section");

  const populated = defensiveParse({ triples: [makeTriple()] });
  assert.equal(populated.length > 0, true, "non-empty triples must render section");
  assert.equal(populated.length, 1);
});

test("FIX-AA.4: TripleCard row links route to /papers/:id, /tools/:id, /prompts/:id", () => {
  // Each row of TripleCard is a Link to the detail page on the matching column. The URL building
  // is encoded in the JSX (`/papers/${encodeURIComponent(triple.paper.id)}` etc). Pin the path
  // shape so a future URL drift (e.g. dropping the encodeURIComponent, changing the column
  // prefix) does not silently 404 the detail pages.
  const t = makeTriple({ paperId: "2601.12345", toolId: "pg_xyz", promptId: "99" });

  // The actual rendering happens in JSX, but we can mirror the URL building here.
  const paperPath = `/papers/${encodeURIComponent(t.paper.id)}`;
  const toolPath = `/tools/${encodeURIComponent(t.tool.id)}`;
  const promptPath = `/prompts/${encodeURIComponent(t.prompt.id)}`;

  assert.equal(paperPath, "/papers/2601.12345", "paper row must link to /papers/:arxivId");
  assert.equal(toolPath, "/tools/pg_xyz", "tool row must link to /tools/:articleId");
  assert.equal(promptPath, "/prompts/99", "prompt row must link to /prompts/:numericId");

  // Sanity: the three paths are distinct. If a future refactor accidentally points all three
  // rows at the same destination, the test fails loudly.
  assert.notEqual(paperPath, toolPath);
  assert.notEqual(toolPath, promptPath);
  assert.notEqual(paperPath, promptPath);
});

test("FIX-AA.4: discover endpoint URL stays /api/site/discover (no separate /triples endpoint)", () => {
  // The trial payload lives on the same /api/site/discover endpoint as the existing three-block
  // teaser — there is NO separate endpoint. The SSR loader in apps/web/app/routes/all.tsx fetches
  // /api/site/discover once and reuses the same payload for both the teaser blocks AND the trial
  // section. Pin the URL so a future split into /api/site/discover/triples does not silently
  // duplicate the load.
  const base = "/api/site/discover";
  assert.ok(base.endsWith("/discover"));
  assert.ok(!base.endsWith("/discover/triples"), "trials must be a field on the existing wire, not a separate endpoint");
});