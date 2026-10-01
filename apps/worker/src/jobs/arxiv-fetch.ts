// arxiv-fetch — pulls every enabled rss-arxiv-* source and upserts the papers table.
// Calls the existing fetchRss() helper (no rewrite) to read the feed, then parses each item's
// link for the arxiv_id and the description for the abstract. Status is left alone — the
// arxiv-translate worker owns status transitions.
//
// We bypass the editorial pipeline (publications/selected_state/scoring) entirely because:
//   1. arXiv is high volume and churns out a lot of preprints the editorial 5-axis model
//      was not designed to score.
//   2. Papers have a long-lived lifecycle (no 7-day window), which publications doesn't support.
//   3. The papers table already carries the translation lifecycle we need.
import { sql } from "@aihot/backend/db";
import type { Candidate, SourceRow } from "@aihot/backend/sources/types";
import { fetchRss } from "@aihot/backend/sources/rss";

/** Matches the canonical arXiv id in an abs URL or guid: YYMM.NNNNN. */
const ARXIV_ID = /(\d{4}\.\d{4,5})(v\d+)?/;

const FETCH_LIMIT = 200; // per source per run; arXiv RSS returns ~30 items but cap for safety.

/** Maps our source id suffix to the actual arXiv category string. arXiv RSS feeds don't always
 *  carry categories in a uniform place, so we keep a stable fallback for the 5 we configured. */
const KNOWN_CATEGORIES: Record<string, string> = {
  "rss-arxiv-csai": "cs.AI",
  "rss-arxiv-cscl": "cs.CL",
  "rss-arxiv-cslg": "cs.LG",
  "rss-arxiv-cscv": "cs.CV",
  "rss-arxiv-csro": "cs.RO",
};

export interface ArxivFetchResult {
  sources: number;
  scanned: number;
  upserted: number;
  skipped: number;
}

export async function fetchArxivFeeds(opts: { limit?: number; budgetMs?: number } = {}): Promise<ArxivFetchResult> {
  const deadline = opts.budgetMs ? Date.now() + opts.budgetMs : Number.POSITIVE_INFINITY;
  const limit = opts.limit ?? FETCH_LIMIT;
  const sources = await sql<SourceRow[]>`
    SELECT id, name, kind, config, tier, participation_mode, first_party, interval_minutes, enabled, cursor, fail_count
    FROM sources
    WHERE enabled = true AND kind = 'rss' AND id LIKE 'rss-arxiv-%'
    ORDER BY id`;
  let scanned = 0;
  let upserted = 0;
  let skipped = 0;
  for (const src of sources) {
    if (Date.now() > deadline) break;
    let read;
    try {
      read = await fetchRss(src, { force: false });
    } catch {
      skipped += 1;
      continue;
    }
    if (read.notModified) continue;
    for (const c of read.candidates.slice(0, limit)) {
      if (Date.now() > deadline) break;
      scanned += 1;
      const parsed = parseArxivItem(src, c);
      if (!parsed) { skipped += 1; continue; }
      const ok = await upsertPaper(src.id, parsed);
      if (ok) upserted += 1;
      else skipped += 1;
    }
  }
  return { sources: sources.length, scanned, upserted, skipped };
}

interface ParsedArxivItem {
  arxivId: string;
  titleEn: string;
  abstractEn: string;
  authors: string[];
  primaryCategory: string;
  categories: string[];
  pdfUrl: string;
  absUrl: string;
  publishedAt: Date;
}

function parseArxivItem(source: SourceRow, c: Candidate): ParsedArxivItem | null {
  const absUrl = c.url;
  const m = ARXIV_ID.exec(absUrl);
  if (!m) return null;
  const arxivId = m[1]!;
  const titleEn = (c.title ?? "").trim();
  const abstractEn = ((c.excerpt ?? c.bodyText) ?? "").trim();
  if (!titleEn || !abstractEn) return null;
  // arXiv RSS packs all authors into one dc:creator string with comma separators.
  const authorStr = (c.author ?? "").trim();
  const authors = authorStr ? authorStr.split(/,\s*/).filter(Boolean) : ["arXiv"];
  // Categories in arXiv RSS are like "cs.AI" or "cs.LG". Filter to the structured shape and fall
  // back to the configured primary if the feed omitted them.
  const categories = (c.categories ?? []).filter((x) => /^[a-z]+\.[A-Z]+$/.test(x));
  if (categories.length === 0 && KNOWN_CATEGORIES[source.id]) categories.push(KNOWN_CATEGORIES[source.id]!);
  const primaryCategory = categories[0] ?? KNOWN_CATEGORIES[source.id] ?? "cs.AI";
  const pdfUrl = `https://arxiv.org/pdf/${arxivId}.pdf`;
  const publishedAt = c.publishedAt instanceof Date ? c.publishedAt : new Date();
  return { arxivId, titleEn, abstractEn, authors, primaryCategory, categories, pdfUrl, absUrl, publishedAt };
}

async function upsertPaper(sourceId: string, p: ParsedArxivItem): Promise<boolean> {
  // Skip if already translated — the user wants the LLM output preserved across re-fetches.
  // Otherwise ON CONFLICT refresh fetched_at and basic fields but leave translated_* untouched.
  const result = await sql`
    INSERT INTO papers (arxiv_id, title_en, abstract_en, authors, primary_category, categories, pdf_url, abs_url, source_id, published_at, fetched_at)
    VALUES (${p.arxivId}, ${p.titleEn}, ${p.abstractEn}, ${p.authors}, ${p.primaryCategory}, ${p.categories}, ${p.pdfUrl}, ${p.absUrl}, ${sourceId}, ${p.publishedAt}, now())
    ON CONFLICT (arxiv_id) DO UPDATE SET
      title_en = EXCLUDED.title_en,
      abstract_en = EXCLUDED.abstract_en,
      authors = EXCLUDED.authors,
      primary_category = EXCLUDED.primary_category,
      categories = EXCLUDED.categories,
      pdf_url = EXCLUDED.pdf_url,
      abs_url = EXCLUDED.abs_url,
      fetched_at = now()
    WHERE papers.status IN ('fetched', 'failed', 'partial')`;
  return result.count > 0;
}