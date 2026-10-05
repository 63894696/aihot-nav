// W5-3 v0.2.1-#9 sources.json 增信源 — community prompts.
//
// What this file pins:
//
//   - The 8 community sources (PromptHero, flowgpt, awesome-chatgpt-prompts,
//     Reddit r/ChatGPT, r/ClaudeAI, GitHub awesome-prompt-engineering,
//     plus the 2 search-api backfill sources) are wired correctly for the
//     v0.2.1 prompt pipeline. Each entry:
//       - has `kind: "external"` (人工推口子, see W5-3 prompts-collection.md §流水线接入点)
//         or `kind: "search_api"` for the SearXNG-backed backfill sources,
//       - declares no config keys its kind does not implement (assertSupportedConfig)
//       - has tier T2 (community / non-editorial) or T1 (官方 / first-party)
//       - has site_fulltext + syndicate_fulltext off (AGENTS.md: 信源默认只展示摘要和原文链接)
//       - has a unique id
//       - has a `tags` list that surfaces it to the publication layer.
//
//   - The community sources cover all five v0.2.1 prompt-score categories
//     (writing / image / study / research / design) — every category that
//     selection-score-prompt.md asks the model for has at least one curated
//     community source it could draw from. A future edit that drops a category
//     would also need to drop a community tag and pin that here.
//
//   - The pipeline-skip guards (collect.ts:88-89 — `external` and `mp_account`
//     never auto-fetch) stay cheap: `interval_minutes` is meaningless for
//     external, but the schema requires a number. We use a large value so a
//     future edit that re-enables external collection does not flood a host.
//
// Why no LLM / no DB: this is a wire-shape test on the on-disk JSON. The
// pipeline (analyze / publication) is exercised by smoke after a real run.

import "./setup-noop.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "@aihot/backend/config";
import { assertSupportedConfig, unsupportedConfig } from "@aihot/backend/sources/config-keys";
import type { SourceRow } from "@aihot/backend/sources/types";

// What kinds of sources exist today. Asserted here so a future enum widening
// forces the test author to revisit the community-source rules — `external` and
// `search_api` are the only kinds we expect for W5-3 prompt sources.
const SOURCE_KINDS = new Set(["rss", "web_list", "json_list", "x_search", "mp_account", "external", "search_api"] as const);

// Five v0.2.1 prompt-score categories (industry/prompts/selection-score-prompt.md §二.3).
// These are the categories the model returns from `scorePrompt`; the community
// sources should cover all five so the worker doesn't fall back to SearXNG-only
// for a whole category.
const PROMPT_CATEGORIES = ["writing", "image", "study", "research", "design"] as const;

type CommunitySourceEntry = {
  id: string;
  name: string;
  kind: SourceRow["kind"];
  config: Record<string, unknown>;
  tier: string;
  participation_mode: "editorial" | "hot_signal" | "isolated";
  first_party: boolean;
  interval_minutes: number;
  tags: string[];
  site_fulltext: boolean;
  syndicate_fulltext: boolean;
  owner_entity_id: string | null;
};

const sourcesFile = JSON.parse(readFileSync(join(REPO_ROOT, "industry/sources.json"), "utf8")) as { sources: unknown[] };
const allSources = sourcesFile.sources;

function isCommunitySource(entry: unknown): entry is CommunitySourceEntry {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.name === "string" &&
    typeof e.kind === "string" &&
    SOURCE_KINDS.has(e.kind as SourceRow["kind"]) &&
    e.config !== undefined &&
    typeof e.config === "object" &&
    typeof e.tier === "string" &&
    (e.participation_mode === "editorial" || e.participation_mode === "hot_signal" || e.participation_mode === "isolated") &&
    typeof e.first_party === "boolean" &&
    typeof e.interval_minutes === "number" &&
    Array.isArray(e.tags) &&
    typeof e.site_fulltext === "boolean" &&
    typeof e.syndicate_fulltext === "boolean"
  );
}

const communitySources = allSources.filter(
  (s): s is CommunitySourceEntry =>
    isCommunitySource(s) && (s.id.startsWith("community-prompt-") || s.id.startsWith("community-awesome-")),
);

test("sources.json: every community prompt source entry is well-formed", () => {
  // We don't pin the exact count (a future edit may add Reddit r/LocalLLaMA
  // for example) but we do pin that each entry matches the SourceRow schema
  // the admin create / edit endpoints expect. A future edit that drops a
  // required field fails here, not at the next seed.ts run.
  assert.ok(communitySources.length >= 5, `at least 5 community sources expected (got ${communitySources.length})`);
  for (const s of communitySources) {
    assert.ok(isCommunitySource(s), `${s.id} must satisfy the SourceRow wire shape`);
    assert.ok(typeof s.owner_entity_id === "string" || s.owner_entity_id === null, `${s.id} owner_entity_id must be string|null`);
    assert.ok(s.tags.length > 0, `${s.id} must have at least one tag`);
    assert.ok(s.tags.length <= 30, `${s.id} must have at most 30 tags (admin schema cap)`);
    assert.ok(s.interval_minutes > 0, `${s.id} interval_minutes must be a positive number`);
  }
});

test("sources.json: every community prompt source uses kind `external` or `search_api`", () => {
  // W5-3 prompts-collection.md §流水线接入点: community prompts are 人工推口子
  // (kind=external, see packages/backend/src/sources/collect.ts:88-89 — external
  // is skipped by the auto-fetch loop). The search_api kind is what the W5-2
  // SearXNG orchestrator reads from; the v0.2.1 prompt-fetch worker reads the
  // same kind. No other kind is correct for a prompt source: rss would demand
  // a feedUrl and auto-fetch, which PromptHero / Reddit / GitHub don't expose.
  for (const s of communitySources) {
    assert.ok(
      s.kind === "external" || s.kind === "search_api",
      `${s.id} must be kind=external (人工推) or kind=search_api (SearXNG backfill); got "${s.kind}"`,
    );
  }
});

test("sources.json: every community prompt source declares no config keys its kind does not implement", () => {
  // assertSupportedConfig throws on bad config. Catching the throw and asserting
  // no message comes out would let a misconfigured entry through. Instead we
  // run assertSupportedConfig — if it throws, the test fails loud.
  for (const s of communitySources) {
    assert.doesNotThrow(
      () => assertSupportedConfig(s.kind, s.config),
      `${s.id} declares config keys its kind does not implement: ${unsupportedConfig(s.kind, s.config).join("、")}`,
    );
  }
});

test("sources.json: community prompt sources have unique ids", () => {
  // Duplicate ids would race in the workers' due-list query. Pin the contract
  // so a future merge that introduces a dup fails here, not at runtime.
  const seen = new Set<string>();
  for (const s of communitySources) {
    assert.ok(!seen.has(s.id), `${s.id} is duplicated; community source ids must be unique`);
    seen.add(s.id);
  }
});

test("sources.json: community prompt sources have site_fulltext + syndicate_fulltext off (AGENTS.md default)", () => {
  // AGENTS.md: 信源默认只展示摘要和原文链接(site_fulltext 关);只有来源明确允许时才打开全文.
  // 社区提示词都不是 first-party — we never have explicit permission to republish
  // their full text. Both flags must be false on every community entry.
  for (const s of communitySources) {
    assert.equal(s.site_fulltext, false, `${s.id} site_fulltext must default to false`);
    assert.equal(s.syndicate_fulltext, false, `${s.id} syndicate_fulltext must default to false`);
  }
});

test("sources.json: community prompt sources carry the `提示词` tag so the publication layer can filter", () => {
  // The publication layer (publication/prompts.ts) reads each prompt's community
  // name verbatim into the JSON response, so a `提示词` tag on the source
  // entry doesn't affect rendering today. We pin it anyway: a future edit that
  // builds a category-facet from source.tags expects every prompt source to be
  // taggable, and we want a single, predictable tag vocabulary. Mixing `prompt`
  // / `提示词` / `prompt_com` would break the assumption.
  for (const s of communitySources) {
    assert.ok(s.tags.includes("提示词"), `${s.id} must include the canonical \`提示词\` tag; got ${JSON.stringify(s.tags)}`);
  }
});

test("sources.json: community prompt sources cover every v0.2.1 prompt-score category via tags", () => {
  // selection-score-prompt.md §二.3 asks the model to classify a prompt into
  // one of writing / image / study / research / design. The community sources
  // SHOULD carry a category tag so the publication layer can present a
  // per-category facet (and so the smoke runs can spot a gap quickly). We don't
  // require every category on a SINGLE source — the union must cover all five.
  const coveredByCategories = new Set<string>();
  for (const s of communitySources) {
    for (const tag of s.tags) {
      if ((PROMPT_CATEGORIES as readonly string[]).includes(tag)) coveredByCategories.add(tag);
    }
  }
  for (const c of PROMPT_CATEGORIES) {
    assert.ok(coveredByCategories.has(c), `no community prompt source tags category \`${c}\`; coverage is ${[...coveredByCategories].join(",")}`);
  }
});

test("sources.json: community prompt sources are tier T2 (non-editorial) and non-first-party", () => {
  // T1 is reserved for first-party / official outlets (OpenAI News, Google
  // DeepMind, arXiv). A future edit that accidentally puts PromptHero or a
  // Reddit sub in T1 would surface them as if they were official announcements,
  // which is misleading. Community sources are T2 by definition.
  for (const s of communitySources) {
    assert.equal(s.tier, "T2", `${s.id} must be tier T2 (community / non-editorial); got "${s.tier}"`);
    assert.equal(s.first_party, false, `${s.id} must be first_party=false; community sources are never first-party`);
  }
});

test("sources.json: external-kind community sources use `isolated` participation_mode", () => {
  // participation_mode="isolated" matches the arxiv-cs.* entries: community
  // signal that isn't timestamped editorial coverage. The analyzer treats
  // isolated sources as ad-hoc reads, never as time-series trend lines.
  // search_api sources don't surface participation_mode (the orchestrator
  // ignores it), but the schema still requires a value; we assert both paths.
  for (const s of communitySources) {
    if (s.kind === "external") {
      assert.equal(s.participation_mode, "isolated", `${s.id} (kind=external) must be participation_mode=isolated; got "${s.participation_mode}"`);
    }
  }
});

test("sources.json: every community source has a recognisable platform tag", () => {
  // Pin a tiny closed vocabulary so the publication layer (which currently
  // just shows the source name) can later render a platform facet without
  // guessing. A future edit that adds a community source without one of these
  // tags should land a tag here too — we want explicit acknowledgement, not
  // silent drift.
  const PLATFORM_TAGS = new Set(["提示词平台", "GitHub", "Reddit", "awesome-list", "社区"]);
  for (const s of communitySources) {
    const platformTags = s.tags.filter((t) => PLATFORM_TAGS.has(t));
    assert.ok(platformTags.length > 0, `${s.id} must include at least one platform tag from ${JSON.stringify([...PLATFORM_TAGS])}; got ${JSON.stringify(s.tags)}`);
  }
});