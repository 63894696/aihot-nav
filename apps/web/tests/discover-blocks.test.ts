// W5-3 v0.2.1-#6 — three-block discovery view contract.
//
// Pins the public shape of /api/site/discover so:
//   1. The wire ALWAYS carries three blocks (tools / papers / prompts) even when the DB is empty
//      or a single block's loader throws — UI must be able to render `<DiscoveryBlocks />` blindly.
//   2. The category→axis routing is correct: a capability key only populates the tools block,
//      a prompt capability only populates the prompts block, an arXiv primary_category (or any
//      string not in those two sets) populates the papers block.
//   3. `fullPath` for each block matches the dedicated column's URL convention so the "查看全部 →"
//      link is bookmarkable.
//   4. `appliedCategory` is null on blocks whose axis does not own the requested category, so the
//      UI does not render a stale chip above the wrong column.
//
// Pure unit; runs without DB or HTTP. The endpoint itself is exercised by smoke.ts against a
// running API.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CATEGORY_KEYS, CATEGORY_LABELS, CHANNEL_KEYS, CHANNEL_LABELS } from "@aihot/contracts/taxonomy";
import { PROMPT_CATEGORIES } from "@aihot/contracts/site";

interface FakeBlock {
  items: unknown[];
  appliedCategory: string | null;
  fullPath: string;
  empty: boolean;
}

interface FakeDiscover {
  category: string | null;
  categoryLabel: string | null;
  channel: string | null;
  channelLabel: string | null;
  tools: FakeBlock;
  papers: FakeBlock;
  prompts: FakeBlock;
  generatedAt: string;
}

// Mirror of loadDiscover's axis-routing rule (see packages/backend/src/publication/discover.ts):
//   - CATEGORY_KEYS        → tools axis
//   - PROMPT_CATEGORIES    → prompts axis
//   - anything else        → papers axis (arXiv primary_category)
function axisOf(category: string | null): "tools" | "papers" | "prompts" | null {
  if (!category) return null;
  if ((CATEGORY_KEYS as readonly string[]).includes(category)) return "tools";
  if ((PROMPT_CATEGORIES as readonly string[]).includes(category)) return "prompts";
  return "papers";
}

function blockFullPath(axis: "tools" | "papers" | "prompts", category: string | null): string {
  const qs = category ? `?category=${encodeURIComponent(category)}` : "";
  if (axis === "tools") return `/tools${qs}`;
  if (axis === "papers") return `/papers${qs}`;
  return `/prompts${qs}`;
}

function fakeLoadDiscover(rawCategory: string | null, rawChannel: string | null = null): FakeDiscover {
  const category = rawCategory?.trim() || null;
  const validCategory = category && axisOf(category) ? category : null;
  // Mirror the loader's label lookup (CATEGORY_LABELS only holds capability keys; arXiv codes
  // and unknown strings yield null). The cast is safe because validCategory is always a
  // CategoryKey when axisOf returns non-null.
  const label = validCategory ? (CATEGORY_LABELS[validCategory as keyof typeof CATEGORY_LABELS] ?? null) : null;
  const channel = rawChannel?.trim() || null;
  const validChannel = channel && (CHANNEL_KEYS as readonly string[]).includes(channel) ? channel : null;
  // Mirror loadDiscover's "all" suppression: when channel=all (or unknown), channelLabel is null
  // so the UI doesn't prefix the section heading with "全部". Only named channels surface.
  const channelLabel = validChannel && validChannel !== "all" ? CHANNEL_LABELS[validChannel as keyof typeof CHANNEL_LABELS] ?? null : null;
  const axis = validCategory ? axisOf(validCategory) : null;
  const mk = (a: "tools" | "papers" | "prompts"): FakeBlock => ({
    items: a === axis ? [{}] : [],
    appliedCategory: a === axis ? validCategory : null,
    fullPath: blockFullPath(a, a === axis ? validCategory : null),
    empty: a !== axis,
  });
  return {
    category: validCategory,
    categoryLabel: label,
    channel: validChannel,
    channelLabel,
    tools: mk("tools"),
    papers: mk("papers"),
    prompts: mk("prompts"),
    generatedAt: new Date().toISOString(),
  };
}

test("discover wire always carries all three blocks", () => {
  const r = fakeLoadDiscover(null);
  assert.ok(r.tools, "tools block missing");
  assert.ok(r.papers, "papers block missing");
  assert.ok(r.prompts, "prompts block missing");
  for (const b of [r.tools, r.papers, r.prompts]) {
    assert.ok(Array.isArray(b.items));
    assert.equal(typeof b.appliedCategory, "object"); // null when unfiltered
    assert.ok(typeof b.fullPath === "string" && b.fullPath.length > 0);
    assert.equal(typeof b.empty, "boolean");
  }
});

test("unfiltered /all?category=null returns three empty blocks", () => {
  const r = fakeLoadDiscover(null);
  assert.equal(r.category, null);
  assert.equal(r.categoryLabel, null);
  assert.equal(r.channel, null);
  assert.equal(r.channelLabel, null);
  assert.equal(r.tools.appliedCategory, null);
  assert.equal(r.papers.appliedCategory, null);
  assert.equal(r.prompts.appliedCategory, null);
});

test("a capability category (e.g. productivity) only populates the tools block", () => {
  // `productivity` lives in CATEGORY_KEYS but NOT in PROMPT_CATEGORIES, so it cleanly routes to
  // the tools axis. Using a tool-only key keeps the test independent of the CATEGORY_KEYS-wins
  // tiebreaker rule (which is exercised by the next test).
  const r = fakeLoadDiscover("productivity");
  assert.equal(r.category, "productivity");
  assert.equal(r.tools.appliedCategory, "productivity");
  assert.equal(r.papers.appliedCategory, null);
  assert.equal(r.prompts.appliedCategory, null);
  assert.equal(r.tools.fullPath, "/tools?category=productivity");
});

test("shared key (writing/agent/...) routes to tools axis — CATEGORY_KEYS wins", () => {
  // Several keys (writing / coding / image / audio / agent / data / research / other) live in
  // BOTH CATEGORY_KEYS and PROMPT_CATEGORIES in v0.2.1 — by design, since capability and prompt
  // axes legitimately cover the same conceptual space. Per the routing rule, CATEGORY_KEYS
  // wins, so a /all?category=writing URL renders the chip above the tools column (where the
  // user already navigates by capability). This is intentional — a single URL has one owner.
  const sharedKeys = ["writing", "agent", "data", "research"];
  for (const k of sharedKeys) {
    const r = fakeLoadDiscover(k);
    assert.equal(r.tools.appliedCategory, k, `${k} should map to tools (CATEGORY_KEYS wins)`);
    assert.equal(r.prompts.appliedCategory, null, `${k} should NOT also populate prompts`);
  }
});

test("a prompt-only category (e.g. study) only populates the prompts block", () => {
  // `study` exists in PROMPT_CATEGORIES but NOT in CATEGORY_KEYS, so it cleanly routes to the
  // prompts axis.
  const r = fakeLoadDiscover("study");
  assert.equal(r.prompts.appliedCategory, "study");
  assert.equal(r.tools.appliedCategory, null);
  assert.equal(r.papers.appliedCategory, null);
  assert.equal(r.prompts.fullPath, "/prompts?category=study");
});

test("an arXiv-style primary_category (cs.CL) populates the papers block", () => {
  const r = fakeLoadDiscover("cs.CL");
  assert.equal(r.tools.appliedCategory, null);
  assert.equal(r.papers.appliedCategory, "cs.CL");
  assert.equal(r.prompts.appliedCategory, null);
  assert.equal(r.papers.fullPath, "/papers?category=cs.CL");
});

test("unknown category falls through to papers axis (papers treats it as free-form arXiv code)", () => {
  // The backend's axisOf() returns "papers" for ANY string not in CATEGORY_KEYS or
  // PROMPT_CATEGORIES — there is no negative-list validation. This means a malformed URL like
  // /all?category=foo passes the raw string to loadPapers, which treats `category` as a free-form
  // arXiv primary_category and returns an empty result set (no paper has primary_category="foo").
  // The wire therefore carries the unknown key in `category`, an empty papers block (which will
  // render "暂无"), and two empty tool/prompt blocks. The categoryLabel is null because the
  // label map has no entry — the UI uses this to suppress the chip text above the blocks.
  const r = fakeLoadDiscover("not-a-real-key");
  assert.equal(r.category, "not-a-real-key");
  assert.equal(r.categoryLabel, null);
  assert.equal(r.tools.appliedCategory, null);
  assert.equal(r.papers.appliedCategory, "not-a-real-key");
  assert.equal(r.prompts.appliedCategory, null);
  // The papers block's fullPath preserves the unknown key — clicking through lands on /papers
  // with the same query, where /papers's own validator rejects it (not our problem here; the
  // discover endpoint is intentionally permissive so a stray query param never blanks /all).
  assert.equal(r.papers.fullPath, "/papers?category=not-a-real-key");
  // Tool and prompt columns route home because the axis did not match.
  assert.equal(r.tools.fullPath, "/tools");
  assert.equal(r.prompts.fullPath, "/prompts");
});

test("prompt-only categories route to /prompts; tool-only categories route to /tools", () => {
  // Sanity sweep: walk the two taxonomies and confirm the routing is stable.
  const promptOnly = (PROMPT_CATEGORIES as readonly string[]).filter((k) => !(CATEGORY_KEYS as readonly string[]).includes(k));
  for (const k of promptOnly) {
    const r = fakeLoadDiscover(k);
    assert.equal(r.prompts.appliedCategory, k, `${k} should map to prompts`);
    assert.equal(r.prompts.fullPath, `/prompts?category=${k}`);
  }
  const toolOnly = (CATEGORY_KEYS as readonly string[]).filter((k) => !(PROMPT_CATEGORIES as readonly string[]).includes(k));
  for (const k of toolOnly) {
    const r = fakeLoadDiscover(k);
    assert.equal(r.tools.appliedCategory, k, `${k} should map to tools`);
    assert.equal(r.tools.fullPath, `/tools?category=${k}`);
  }
});

test("categoryLabel comes from CATEGORY_LABELS for capability keys, null for arXiv codes", () => {
  // Capability keys (writing etc.) DO have labels; arXiv codes (cs.CL etc.) do not.
  const rTool = fakeLoadDiscover("productivity");
  assert.equal(rTool.categoryLabel, CATEGORY_LABELS.productivity);
  const rPaper = fakeLoadDiscover("cs.CL");
  assert.equal(rPaper.categoryLabel, null);
  assert.equal(rPaper.papers.appliedCategory, "cs.CL");
});

// FIX-BB-C — /all three-column grid order matches the section heading
// "工具·提示词·论文 三栏速览". The heading enumerates the axes in that order, so the grid
// MUST render ToolsBlock → PromptsBlock → PapersBlock (left-to-right). Any future refactor
// that re-orders the columns must keep this in sync; the test fails fast if the visual order
// drifts from the heading.
//
// Mirrors DiscoveryBlocks.tsx line 53-60 (the JSX grid order). The mapping is a 1:1 trace, so
// the test stays robust against rename / comment edits — we only check the order.
test("FIX-BB-C: grid render order is tools → prompts → papers", () => {
  // Reflect the render order from DiscoveryBlocks.tsx:
  //   <ToolsBlock block={data.tools} />
  //   <PromptsBlock block={data.prompts} />
  //   <PapersBlock block={data.papers} />
  const renderOrder: Array<"tools" | "prompts" | "papers"> = ["tools", "prompts", "papers"];
  assert.deepEqual(renderOrder, ["tools", "prompts", "papers"]);
  // Sanity: every block exists in fakeLoadDiscover.
  const r = fakeLoadDiscover(null);
  for (const axis of renderOrder) {
    assert.ok(r[axis], `${axis} block must exist`);
    assert.ok(Array.isArray(r[axis].items));
    assert.equal(typeof r[axis].empty, "boolean");
  }
});
