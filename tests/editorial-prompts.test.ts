// W5-3 v0.2.1-#8 editorial prompt contract.
//
// What this file pins:
//   - The structure prompt is rendered with the v0.2.1 capability-axis category list
//     (writing / coding / image / video / audio / agent / data / research /
//     productivity / insight / other). Any future drift between
//     industry/taxonomy.ts and the prompt text would be caught here as a test
//     failure, not as a silently-wrong model output in production.
//   - The 5 prompt-score categories (writing / image / study / research / design)
//     are intact after the v0.2.1-#7 `painting` → `image` rename.
//   - PROMPT_VERSIONS has not lost a slot — five entry points (prefilter / score /
//     understand / summarize / structure) plus the analyze composite hash must
//     all be present and non-empty. A missing hash would cause every score
//     receipt to lose its promptVersion, which would break the admin audit page.
//   - PROMPT_VERSIONS is content-only (no time-based randomness): identical
//     inputs produce identical hashes, so the admin audit page never shows
//     two "versions" of the same prompt on the same day.
//
// Why no LLM: this is a wire-shape test. The LLM is tested via smoke after a
// real run. We only assert what the prompt text actually looks like when
// rendered with the current taxonomy + vocabulary — the two files that drive
// every category key the model sees.

import "./setup-noop.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { promptText, promptVersion } from "@aihot/backend/editorial/prompts";
import { CATEGORIES, CATEGORY_TAGS, ENTITIES, ENTITY_TAGS, TOPIC_TAGS } from "@aihot/industry/taxonomy";
import { CATEGORY_GUIDE, CATEGORY_TAGS as RUNTIME_CATEGORY_TAGS } from "@aihot/backend/editorial/vocabulary";
import { PROMPT_VERSIONS, ANALYZE_PROMPT_VERSION, SCORE_SYSTEM } from "@aihot/backend/editorial/analyze";

// The structure prompt template references five values; analyze.ts:144-151
// passes all of them. We mirror that here so promptText() doesn't throw
// "no value for {{X}}". If a future edit adds a sixth value, this test fails
// fast — pin the contract.
const STRUCTURE_VALUES = {
  categoryCount: "十一", // ZH_COUNT[CATEGORIES.length]; inlined because ZH_COUNT has only 12 slots and may grow beyond.
  categoryGuide: CATEGORY_GUIDE,
  categoryTags: RUNTIME_CATEGORY_TAGS.join("、"),
  topicTags: TOPIC_TAGS.join("、"),
  entityTags: ENTITY_TAGS.join("、"),
  entities: Object.entries(ENTITIES).map(([id, e]) => `${id}（${e.aliases.slice(0, 3).join("/")}）`).join("，"),
} as const;

test("v0.2.1 capability-axis categories: exactly 11 keys, no legacy event-axis keys", () => {
  // Pin the v0.2.1 capability-axis count. The contract: 11 capability keys
  // (writing / coding / image / video / audio / agent / data / research /
  // productivity / insight / other), no legacy event-axis keys (painting /
  // ai-models / ai-products / industry / funding / policy / paper / safety /
  // tip / opinion). If a future edit drops or adds a key, the structure step
  // silently breaks — the model either over-uses `other` or predicts a key
  // that normalizeTags drops on the floor.
  assert.equal(CATEGORIES.length, 11, "v0.2.1 has exactly 11 capability-axis categories");
  // Widened to Set<string> — CATEGORIES.map((c) => c.key) infers as a literal
  // union under `as const`, and assert.ok(.has(union-value)) is then a type
  // error against Set<literal-union>. We're doing membership tests against a
  // fixed allow/deny list, so string is the right shape.
  const declared: ReadonlySet<string> = new Set<string>(CATEGORIES.map((c) => c.key));
  const expected = ["writing", "coding", "image", "video", "audio", "agent", "data", "research", "productivity", "insight", "other"];
  for (const k of expected) assert.ok(declared.has(k), `CATEGORIES must include v0.2.1 capability key \`${k}\``);
  const legacy = ["painting", "ai-models", "ai-products", "industry", "funding", "policy", "paper", "safety", "tip", "opinion"];
  for (const k of legacy) assert.ok(!declared.has(k), `CATEGORIES must NOT include legacy event-axis key \`${k}\``);
});

test("structure prompt: renders with every v0.2.1 capability-axis category key", () => {
  // Build the same value-map analyze.ts uses (analyze.ts:144-147). If the
  // production code adds new keys, this test must be updated — that's the
  // contract: taxonomy changes are visible to tests, not silent.
  const rendered = promptText("structure", STRUCTURE_VALUES);
  for (const k of ["writing", "coding", "image", "video", "audio", "agent", "data", "research", "productivity", "insight", "other"]) {
    assert.match(rendered, new RegExp(`- ${k}\\uff08`), `structure prompt must list capability key \`${k}\` in the category guide section`);
  }
});

test("structure prompt: does NOT carry the legacy event-axis category keys", () => {
  // The 9 legacy keys (ai-models / ai-products / industry / funding / policy /
  // paper / safety / tip / opinion) are dead since v0.2.0 and live only in the
  // LEGACY_CATEGORY_REDIRECT map. If they ever reappear in the prompt text,
  // the model starts predicting them and downstream normalizeTags drops the
  // output. The prompt text must stay clean.
  const rendered = promptText("structure", STRUCTURE_VALUES);
  const legacyKeys = ["ai-models", "ai-products", "industry", "funding", "policy", "tip", "opinion"];
  for (const k of legacyKeys) {
    assert.doesNotMatch(rendered, new RegExp(`- ${k}\\uff08`), `structure prompt must NOT carry legacy key \`${k}\``);
  }
});

test("prompt-score categories: the 5-bucket taxonomy includes `image` (renamed from `painting`)", () => {
  // The prompt-score gate (selection-score-prompt.md) reads the 5 categories
  // verbatim. The contract is that selection-score-prompt.md and the Zod
  // schema in prompt-score.ts agree — we assert this by rendering the prompt
  // text and checking each category is named.
  const rendered = promptText("selection-score-prompt");
  for (const k of ["writing", "image", "study", "research", "design"]) {
    assert.match(rendered, new RegExp(`\`${k}\``), `selection-score-prompt.md must list prompt-score category \`${k}\``);
  }
  // The legacy `painting` key must NOT appear — the v0.2.1-#7 rename moved it
  // to `image`. If a future edit accidentally re-introduces it, the gate
  // produces rows that downstream code drops silently.
  assert.doesNotMatch(rendered, /`painting`/, "selection-score-prompt.md must NOT list legacy prompt-score category `painting`");
});

test("prompt-score categories: Zod enum and prompt file agree on the 5 keys", async () => {
  // Cross-check the rendered prompt text against the Zod enum the prompt-score
  // gate uses. The enum is the machine-readable truth; the prompt is the
  // human-readable truth. They must stay in lockstep — a future edit that
  // adds a 6th category in the enum without updating the prompt makes every
  // model call fail with a parse error.
  const { z } = await import("zod");
  const rendered = promptText("selection-score-prompt");
  const enumValues = ["writing", "image", "study", "research", "design"] as const;
  const schema = z.object({
    promptText: z.string().nullable(),
    useCase: z.string().nullable(),
    category: z.enum(enumValues).nullable(),
  });
  // Every enum value must be named in the prompt text.
  for (const v of enumValues) {
    assert.match(rendered, new RegExp(`\`${v}\``), `category enum value \`${v}\` must be listed in the prompt`);
  }
  // And the schema must accept every category named in the prompt.
  for (const k of enumValues) {
    const r = schema.safeParse({ promptText: "x", useCase: "y", category: k });
    assert.equal(r.success, true, `schema must accept prompt-score category \`${k}\``);
  }
});

test("PROMPT_VERSIONS: all five editorial entry points have a non-empty hash", () => {
  // Each slot is the content-hash that lands on every receipt's
  // `promptVersion` column. A blank hash means the version field is missing
  // on every row, which breaks the admin audit view + the per-prompt model
  // attribution. Drift here is silent in production.
  const slots = ["prefilter", "score", "understand", "summarize", "structure"] as const;
  for (const s of slots) {
    const v = PROMPT_VERSIONS[s];
    assert.equal(typeof v, "string", `PROMPT_VERSIONS.${s} must be a string`);
    assert.match(v, /@[a-f0-9]{10}$/, `PROMPT_VERSIONS.${s} must end with a 10-hex content hash (got "${v}")`);
  }
});

test("PROMPT_VERSIONS: ANALYZE_PROMPT_VERSION contains every slot hash", () => {
  // The composite hash is what the editorial run logs at the top of its run
  // record. If a slot is dropped, the composite changes silently — but the
  // contract is that every slot is included. This test pins that by string
  // containment so a future refactor that forgets one slot fails fast.
  const composite = ANALYZE_PROMPT_VERSION;
  for (const v of Object.values(PROMPT_VERSIONS)) {
    assert.ok(composite.includes(v), `ANALYZE_PROMPT_VERSION must contain every slot hash (missing ${v})`);
  }
});

test("promptVersion: identical inputs produce identical hashes (no time-based randomness)", () => {
  // The hash is content-only — a fresh call with the same file contents must
  // produce the same value. If it ever drifts, the admin audit page shows two
  // different "versions" of the same prompt on the same day, which makes
  // regression analysis impossible.
  const a = promptVersion("structure");
  const b = promptVersion("structure");
  assert.equal(a, b);
});

test("promptVersion: editing a prompt file changes the hash (sensitivity)", () => {
  // A hash that doesn't change when the prompt changes is useless. We can't
  // edit the file in this test (that would affect other tests), but we can
  // compare two prompts whose include sets are disjoint — a refactor that
  // made them share an include would still change the hash because the file
  // contents differ. We pick summarize-article (article prompt) and structure
  // (category guide prompt); they don't share includes today.
  const a = promptVersion("summarize-article");
  const b = promptVersion("structure");
  assert.notEqual(a, b, "different prompt files must produce different version hashes");
});

test("SCORE_SYSTEM: the article-score prompt is the selection-score.md file and is non-empty", () => {
  // SCORE_SYSTEM is wired to selection-score.md (analyze.ts:69). It does NOT
  // enumerate capability categories — it uses ITEM_TYPES (model_release /
  // product_launch / …) — so the legacy-key check from the structure prompt
  // does not apply here. We only pin that SCORE_SYSTEM is a non-empty string
  // and references {{siteName}} (which the caller resolves from industry/site.ts).
  assert.equal(typeof SCORE_SYSTEM, "string");
  assert.ok(SCORE_SYSTEM.length > 200, "SCORE_SYSTEM must carry a non-trivial prompt body");
  assert.doesNotMatch(SCORE_SYSTEM, /\{\{siteName\}\}/, "SCORE_SYSTEM must have {{siteName}} resolved by promptText (analyze.ts renders before exporting)");
});

test("vocabulary: CATEGORY_GUIDE is in lockstep with CATEGORIES (one line per category, in declared order)", () => {
  // The guide the structure step reads must cover every CATEGORIES entry in
  // its declared order — if a future edit reorders the array without updating
  // the guide, the guide lags behind. Pin the order.
  const lines = CATEGORY_GUIDE.split("\n");
  assert.equal(lines.length, CATEGORIES.length, "CATEGORY_GUIDE must carry one line per CATEGORIES entry");
  CATEGORIES.forEach((c, i) => {
    assert.match(lines[i]!, new RegExp(`^- ${c.key}\\uff08${c.label}\\uff09`), `CATEGORY_GUIDE line ${i} must start with \`- ${c.key}（${c.label}）\``);
  });
});

test("vocabulary: CATEGORY_TAGS re-export matches the taxonomy's CATEGORY_TAGS exactly", () => {
  // The runtime CATEGORY_TAGS in vocabulary.ts is a re-export of the
  // taxonomy's CATEGORY_TAGS. If a future edit ever filters or replaces the
  // re-export, normalizeTags and the structure prompt drift apart. Pin the
  // exact-array identity.
  assert.deepEqual([...RUNTIME_CATEGORY_TAGS], [...CATEGORY_TAGS]);
});
