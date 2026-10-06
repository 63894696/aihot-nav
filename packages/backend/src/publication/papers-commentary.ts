// /papers/:id "解读" — published commentary markdown → sanitised HTML.
//
// Why this lives in the publication layer (not a route file or the web app):
//   1. The .md draft is part of the repo, but the *published* version is gated on the DB
//      state — papers.commentary_status='published' + commentary_md_url set. The publication
//      layer already owns that join.
//   2. We render server-side so the HTML can be cached behind the same CDN rules as the
//      detail page, and so the front-end never ships a third-party markdown parser.
//   3. The renderer is intentionally small (mirrors apps/web/lib/markdown.ts — that's the
//      design choice already in the repo: hand-rolled, no extra deps). The unbug 论文解读
//      drafts use a constrained subset (h2/h3, paragraph, bold, inline-code, links, plain
//      lists, evidence markers) — we cover that and nothing else.
//
// Auth & secrets: this file only reads the repo .md file by arxiv id. No HTTP, no DB writes.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root resolution — same pattern as scripts/local-commentary-{gen,publish}.ts:
 *  /workspace/packages/backend/src/publication/<this-file>.ts → 4 levels up. */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const DOCS_DIR = join(REPO_ROOT, "docs", "commentary");

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Highlight [F]/[A]/[I]/[U] evidence markers into <span class="ev-F|A|I|U"> so the front-end
 *  CSS can colour them per unbug discipline. Markers must be surrounded by whitespace or
 *  line boundaries to avoid matching arbitrary bracket runs. */
const MARKER_RX = /(^|\s)(\[(F|A|I|U)\])(?=[\s.,;:!?)\]]|$)/g;
function highlightMarkers(escaped: string): string {
  return escaped.replace(MARKER_RX, (_m, pre, marker) => `${pre}<span class="ev ev-${marker[1]}">${marker}</span>`);
}

function renderInline(s: string): string {
  let out = escape(s);
  out = out.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, bold) => `<strong>${bold}</strong>`);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, href) => {
    const safeHref = /^https?:\/\//.test(href) || href.startsWith("/") ? href : "#";
    const external = /^https?:\/\//.test(safeHref);
    return `<a href="${safeHref}"${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${text}</a>`;
  });
  out = highlightMarkers(out);
  return out;
}

/** Strip the LLM-collaboration header lines we inject at gen time so the public render
 *  doesn't show them. They look like:
 *    <!-- commentary draft for 2601.12345 — mode=micropaper — paste LLM reply below -->
 *    <!-- paper title (en): ... -->
 */
function stripGenHeader(md: string): string {
  return md
    .replace(/^<!--[\s\S]*?-->\s*\n/gm, "")
    .replace(/^<!--[\s\S]*?-->\s*$/gm, "")
    .trim();
}

export function renderCommentaryMarkdown(md: string): string {
  const body = stripGenHeader(md);
  if (!body) return "";
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    const heading = /^(#{2,4})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      out.push(`<h${level}>${renderInline(heading[2]!.trim())}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) {
        items.push(`<li>${renderInline(lines[i]!.replace(/^\s*[-*]\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        items.push(`<li>${renderInline(lines[i]!.replace(/^\s*\d+\.\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    // paragraph: gather until blank
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{2,4})\s+/.test(lines[i]!) && !/^\s*[-*]\s+/.test(lines[i]!) && !/^\s*\d+\.\s+/.test(lines[i]!)) {
      para.push(lines[i]!);
      i++;
    }
    out.push(`<p>${renderInline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}

export interface CommentaryPayload {
  /** Sanitised HTML ready for dangerouslySetInnerHTML. Empty when the .md file is missing
   *  on disk (the DB says published but the repo file vanished — the front-end shows the
   *  source label but a "draft missing" note). */
  html: string;
  /** True when the file existed but was empty after stripping the gen header. */
  empty: boolean;
}

/** Read + render the commentary for a paper. Returns null when commentary_md_url is not set
 *  or the path doesn't resolve under docs/commentary/. Caller (the API route) decides how
 *  to surface this — for a paper with commentaryStatus='published' but missing file, we
 *  return a non-null payload with empty=true so the front-end can show a graceful message
 *  instead of pretending the commentary exists. */
export function loadPaperCommentaryHtml(commentaryMdUrl: string | null): CommentaryPayload | null {
  if (!commentaryMdUrl) return null;
  // Whitelist: only allow repo-relative paths under docs/commentary/. Defensive against a
  // tampered DB value pointing at an arbitrary file.
  if (commentaryMdUrl.includes("..") || !commentaryMdUrl.startsWith("docs/commentary/")) return null;
  const filePath = join(REPO_ROOT, commentaryMdUrl);
  if (!existsSync(filePath)) return { html: "", empty: true };
  const raw = readFileSync(filePath, "utf8");
  const html = renderCommentaryMarkdown(raw);
  if (!html) return { html: "", empty: true };
  return { html, empty: false };
}

export { DOCS_DIR as _DOCS_DIR };
