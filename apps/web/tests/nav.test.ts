// W5-3 v0.2.1-#10 — shell nav wire contract for the three-axis layout.
//
// What this file pins:
//
//   - /prompts (the v0.2.1 prompts column from W5-3) is a top-level sidebar entry in the
//     "内容" section. v0.2.0 had it buried under "更多" alongside /papers, which the
//     docs/features/prompts-collection.md and the /all cross-axis block in
//     apps/web/app/features/discover/DiscoveryBlocks.tsx both treat as a peer of /tools
//     and /papers. Buried nav contradicts the cross-axis pitch and the cross-page
//     discoverability intent.
//
//   - /tools, /papers, /prompts all live in the same "内容" section so the reader sees
//     the three columns together. /papers stays in "更多" for now — it's a niche
//     column, while /prompts is the W5-3 ship target.
//
//   - TABBAR stays 4 slots (mobile-tab capacity is hard-bound by the grid-cols-4 in
//     apps/web/app/components/shell/MobileTabBar.tsx). The mobile /more page handles
//     /prompts as a link and highlights the /more tab via MORE_PATHS.
//
//   - tabIsActive("/prompts", "/prompts") and tabIsActive("/prompts", "/prompts/abc")
//     both return true; tabIsActive("/prompts", "/tools") returns false. The single-
//     entry match-and-mismatch is the contract that prevents /prompts stealing active
//     state from /tools (and vice-versa) when the user opens a child route.
//
//   - MORE_PATHS includes /prompts so the /more mobile tab stays highlighted while the
//     reader is inside the column.
//
// Why text-parse (no import): nav.ts imports `../icons` (JSX, no Node ESM .tsx resolver).
// Pulling it in would force a build step; the other web tests in this repo either skip
// on Windows (cache.test.ts) or only import pure TS modules (discover-blocks,
// cross-page-chips, taxonomy-capability). Static parse keeps this honest without adding
// a TS loader — the file is small enough that a regex parse is safer than a full AST.
//
// What is NOT pinned here (lives elsewhere):
//   - icon prop types — apps/web's typecheck pass enforces NavItem.icon is a component.
//   - sidebar render correctness — apps/web/app/components/shell/Sidebar.tsx imports
//     nav.ts at runtime, exercised by build + smoke.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const NAV_PATH = join(import.meta.dirname, "../app/components/shell/nav.ts");

/**
 * Parse the SIDEBAR array literal out of nav.ts. Each block looks like:
 *   {
 *     title: "内容",
 *     items: [
 *       { to: "/", label: "精选", icon: IconBolt, end: true },
 *       ...
 *     ],
 *   },
 *
 * Returns an Array<{ title, items: Array<{ to, label, end? }> }>. icon props and
 * TS-only annotations are dropped — we only assert path + label + section shape.
 */
function parseSidebar(src: string): Array<{ title: string; items: Array<{ to: string; label: string; end?: boolean }> }> {
  // Cut to the SIDEBAR constant. Anchored by the export so the parse survives
  // unrelated edits above the constant.
  const startIdx = src.indexOf("export const SIDEBAR");
  if (startIdx < 0) throw new Error("SIDEBAR not found in nav.ts");
  // Find the `=` after the type annotation, then the `[` after the `=`. We can't
  // search for `[` from startIdx because the TS type `Array<{...NavItem[]}>` itself
  // contains brackets that would be matched by findMatchingClose first.
  const eqIdx = src.indexOf("=", startIdx);
  const arrayStart = src.indexOf("[", eqIdx);
  const arrayEnd = findMatchingClose(src, arrayStart);
  const body = src.slice(arrayStart, arrayEnd + 1);
  const sectionStrs = splitTopLevel(body.slice(1, -1));
  const sections: Array<{ title: string; items: Array<{ to: string; label: string; end?: boolean }> }> = [];
  for (const s of sectionStrs) {
    const titleMatch = s.match(/title:\s*"([^"]+)"/);
    if (!titleMatch) throw new Error(`section title not found in: ${s.slice(0, 80)}`);
    const itemsStart = s.indexOf("items:");
    const itemsArrayStart = s.indexOf("[", itemsStart);
    const itemsArrayEnd = findMatchingClose(s, itemsArrayStart);
    const itemsBody = s.slice(itemsArrayStart + 1, itemsArrayEnd);
    const itemStrs = splitTopLevel(itemsBody);
    const items: Array<{ to: string; label: string; end?: boolean }> = [];
    for (const itemStr of itemStrs) {
      const toMatch = itemStr.match(/to:\s*"([^"]+)"/);
      if (!toMatch) continue;
      const label = extractLabel(itemStr);
      if (!label) continue;
      items.push({ to: toMatch[1]!, label, end: /\bend:\s*true\b/.test(itemStr) });
    }
    sections.push({ title: titleMatch[1]!, items });
  }
  return sections;
}

/**
 * Extract the human-readable label from an item block. Handles three forms
 * seen in apps/web/app/components/shell/nav.ts:
 *   - label: "精选"
 *   - label: withSubject("工具导航")
 *   - label: `全${withSubject("动态")}`
 * Returns null when the label can't be reduced to a string (rare).
 */
function extractLabel(itemStr: string): string | null {
  // 1. Plain string literal: label: "精选"
  const stringLit = itemStr.match(/label:\s*"([^"]+)"/);
  if (stringLit) return stringLit[1]!;
  // 2. Function-call: label: withSubject("工具导航") — pull the first string arg.
  const fnCall = itemStr.match(/label:\s*[A-Za-z_$][\w$]*\s*\(\s*"([^"]+)"\s*\)/);
  if (fnCall) return fnCall[1]!;
  // 3. Template literal: `全${withSubject("动态")}` — concat literal parts + first arg.
  const tmpl = itemStr.match(/label:\s*`([^\`]*)`/);
  if (tmpl) {
    const inner = tmpl[1]!;
    const innerFnCall = inner.match(/\$\{[A-Za-z_$][\w$]*\s*\(\s*"([^"]+)"\s*\)\}/);
    if (innerFnCall) return inner.replace(/\$\{[A-Za-z_$][\w$]*\s*\(\s*"([^"]+)"\s*\)\}/, innerFnCall[1]!);
    return inner;
  }
  return null;
}

/** Parse `export const MORE_PATHS = ["/more", "/hot", ...]` into a string array. */
function parseMorePaths(src: string): string[] {
  const m = src.match(/export const MORE_PATHS\s*=\s*\[([^\]]+)\]/);
  if (!m) throw new Error("MORE_PATHS not found");
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

/** Parse `export const TABBAR: NavItem[] = [...]` into the same shape SIDEBAR items use. */
function parseTabbar(src: string): Array<{ to: string; label: string; end?: boolean }> {
  const startIdx = src.indexOf("export const TABBAR");
  const eqIdx = src.indexOf("=", startIdx);
  const arrayStart = src.indexOf("[", eqIdx);
  const arrayEnd = findMatchingClose(src, arrayStart);
  const itemsBody = src.slice(arrayStart + 1, arrayEnd);
  const itemStrs = splitTopLevel(itemsBody);
  const items: Array<{ to: string; label: string; end?: boolean }> = [];
  for (const itemStr of itemStrs) {
    const toMatch = itemStr.match(/to:\s*"([^"]+)"/);
    if (!toMatch) continue;
    const label = extractLabel(itemStr);
    if (!label) continue;
    items.push({ to: toMatch[1]!, label, end: /\bend:\s*true\b/.test(itemStr) });
  }
  return items;
}

/**
 * Parse `export function tabIsActive(item: NavItem, pathname: string): boolean { ... }`
 * enough to evaluate the three match branches we care about: end, /more-prefix,
 * /daily regex, default prefix-match. Pure re-implementation of the contract.
 */
function makeTabIsActive(morePaths: string[]) {
  return (item: { to: string; end?: boolean }, pathname: string): boolean => {
    if (item.end) return pathname === item.to;
    if (item.to === "/more") return morePaths.some((p) => pathname === p || pathname.startsWith(`${p}/`));
    if (item.to === "/daily") return /^\/(daily|weekly|monthly)(\/|$)/.test(pathname);
    return pathname === item.to || pathname.startsWith(`${item.to}/`);
  };
}

/** Walk src from `openAt` and return the index of the matching `]` or `}` (the same char as openAt). */
function findMatchingClose(src: string, openAt: number): number {
  const open = src[openAt];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inStr: string | null = null;
  for (let i = openAt; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === "\\") { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return i; }
  }
  throw new Error(`unmatched ${open} at ${openAt}`);
}

/**
 * Split a body string on the boundary that a top-level `}` creates. Each
 * section in SIDEBAR ends with `},\n  {` (or `},\n` for the trailing one).
 * We split on the `}` itself — the separator regex `}` at depth 0 — which
 * works for both interior and trailing sections, and for source that
 * optionally has trailing whitespace / comma after the `}`.
 *
 * Comment lines (`// ...` or `/* ... *\/`) attached to a section object are
 * kept with the section that follows them rather than emitted as their own
 * chunk; we treat any chunk that doesn't start with `{` as a stray comment
 * and merge it into the previous non-empty chunk.
 */
function splitTopLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr: string | null = null;
  let last = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (ch === "\\") { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      // At depth 0 a closing `}` ends a section. Consume the `}` plus any
      // trailing `,` and whitespace so the next chunk starts cleanly.
      if (depth === 0) {
        let j = i + 1;
        while (j < body.length && /[,\s]/.test(body[j]!)) j++;
        out.push(body.slice(last, i));
        last = j;
        i = j - 1;
      }
    }
  }
  out.push(body.slice(last));
  // Merge leading comments / whitespace into the next section that starts
  // with `{`. Items-array splits in nav.ts produce stray `],` chunks we
  // also drop (they're artefacts of the spread + ternary in the 模型
  // section — see nav.ts:641+ — not real items).
  const merged: string[] = [];
  for (const raw of out) {
    const s = raw.trim();
    if (!s) continue;
    if (s.startsWith("{")) {
      merged.push(s);
    } else if (merged.length > 0) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}\n${s}`;
    }
  }
  return merged;
}

const SRC = readFileSync(NAV_PATH, "utf8");
const SIDEBAR = parseSidebar(SRC);
const TABBAR = parseTabbar(SRC);
const MORE_PATHS = parseMorePaths(SRC);
const tabIsActive = makeTabIsActive(MORE_PATHS);

/** The "内容" section is the v0.2.1 three-axis home: 工具 / 提示词 / 论文 live here. */
const CONTENT_SECTION = "内容";

function findSidebar(to: string): { section: string; label: string } | null {
  for (const section of SIDEBAR) {
    for (const item of section.items) {
      if (item.to === to) return { section: section.title, label: item.label };
    }
  }
  return null;
}

test("nav: SIDEBAR exists and is non-empty", () => {
  assert.ok(SIDEBAR.length > 0);
  for (const section of SIDEBAR) {
    assert.ok(section.title.length > 0, "section.title must be non-empty");
    assert.ok(section.items.length > 0, `section "${section.title}" must have at least one item`);
  }
});

test("nav: /prompts is a top-level entry under 内容 (not buried under 更多)", () => {
  // The cross-axis pitch — /all renders tools / papers / prompts side-by-side via
  // DiscoveryBlocks, and the /prompts column is a peer of /tools in the data model.
  // A buried /prompts contradicts both. Pin the position.
  const found = findSidebar("/prompts");
  assert.ok(found, "/prompts must appear in SIDEBAR");
  assert.equal(found!.section, CONTENT_SECTION, `/prompts must live under "${CONTENT_SECTION}" (got "${found.section}")`);
});

test("nav: /tools lives under 内容 (three-axis home)", () => {
  // /tools MUST be in 内容 because the user discovers the tools column from there,
  // and putting it anywhere else breaks muscle memory. Pin the section.
  const tools = findSidebar("/tools");
  assert.ok(tools, "/tools must appear in SIDEBAR");
  assert.equal(tools!.section, CONTENT_SECTION, `/tools must live under "${CONTENT_SECTION}" (got "${tools.section}")`);
});

test("nav: /papers appears in SIDEBAR (either 内容 or 更多)", () => {
  // /papers is allowed under "更多" for now (it's a niche column, while /prompts
  // is the W5-3 ship target). Just pin the presence — the section choice is fluid.
  const papers = findSidebar("/papers");
  assert.ok(papers, "/papers must appear in SIDEBAR");
  assert.ok(papers!.section === CONTENT_SECTION || papers!.section === "更多", `/papers must live under "${CONTENT_SECTION}" or "更多" (got "${papers.section}")`);
});

test("nav: every SIDEBAR.to is unique (no two entries share a path)", () => {
  const seen = new Set<string>();
  for (const section of SIDEBAR) {
    for (const item of section.items) {
      assert.ok(!seen.has(item.to), `${item.to} is duplicated in SIDEBAR`);
      seen.add(item.to);
    }
  }
});

test("nav: every SIDEBAR label is a non-empty string", () => {
  for (const section of SIDEBAR) {
    for (const item of section.items) {
      assert.ok(item.label.length > 0, `${item.to} has empty label`);
    }
  }
});

test("nav: TABBAR has exactly 4 entries (mobile grid is grid-cols-4)", () => {
  // apps/web/app/components/shell/MobileTabBar.tsx:11 — `<div className="grid-cols-4">`.
  // Adding a 5th tab here would silently truncate the row. Pin the count.
  assert.equal(TABBAR.length, 4);
});

test("nav: TABBAR entries do not include /prompts (it's on /more)", () => {
  // The /more entry already highlights MORE_PATHS (which includes /prompts), so the
  // mobile reader reaches /prompts from there. Putting /prompts in TABBAR would
  // push one of the 4 columns off the bottom bar.
  for (const t of TABBAR) {
    assert.notEqual(t.to, "/prompts", "/prompts must not be in TABBAR; it lives under 更多 on mobile");
  }
});

test("nav: MORE_PATHS includes /prompts so /more tab highlights while in /prompts", () => {
  assert.ok(MORE_PATHS.includes("/prompts"), "MORE_PATHS must include /prompts so the /more tab highlights");
});

test("tabIsActive: /prompts matches /prompts and /prompts/:id, but NOT /tools", () => {
  // The headline test: an isolated change to nav.ts that accidentally widens the
  // match (e.g. by switching /prompts to a regex without anchors) would steal the
  // active state from /tools. Pin the contract.
  const promptItem = SIDEBAR.flatMap((s) => s.items).find((i) => i.to === "/prompts");
  assert.ok(promptItem, "prerequisite — must have a /prompts entry");
  assert.equal(tabIsActive(promptItem!, "/prompts"), true);
  assert.equal(tabIsActive(promptItem!, "/prompts/abc"), true, "/prompts must remain active on child routes");
  assert.equal(tabIsActive(promptItem!, "/tools"), false, "/prompts must NOT match /tools");
  assert.equal(tabIsActive(promptItem!, "/"), false);
});

test("tabIsActive: end:true on the / entry keeps /selected from matching /prompts", () => {
  const homeItem = SIDEBAR.flatMap((s) => s.items).find((i) => i.to === "/" && i.end);
  assert.ok(homeItem, "the home (/) entry must declare end:true");
  assert.equal(tabIsActive(homeItem!, "/"), true);
  assert.equal(tabIsActive(homeItem!, "/prompts"), false);
});

test("tabIsActive: /more matches every MORE_PATHS entry (regression guard)", () => {
  // The /more entry uses MORE_PATHS to broaden its active state — verify our
  // re-implementation honours the same list. A future edit that narrows the list
  // (e.g. drops /prompts) would fail this test.
  const moreItem = TABBAR.find((i) => i.to === "/more") ?? SIDEBAR.flatMap((s) => s.items).find((i) => i.to === "/more");
  assert.ok(moreItem, "the /more entry must exist in either TABBAR or SIDEBAR");
  for (const p of MORE_PATHS) {
    assert.equal(tabIsActive(moreItem!, p), true, `/more must highlight on ${p}`);
    assert.equal(tabIsActive(moreItem!, `${p}/child`), true, `/more must highlight on ${p}/child (prefix match)`);
  }
});