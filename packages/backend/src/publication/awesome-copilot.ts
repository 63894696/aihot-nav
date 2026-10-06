// /api/site/awesome-copilot — code-prompt template library read layer.
//
// Reads from the dedicated `copilot_assets` table (migration 0049) populated by the
// dedicated awesome-copilot-fetch worker (apps/worker/src/jobs/awesome-copilot-fetch.ts).
// Three external-awesome-copilot-* sources map to one asset_kind each (agents / instructions
// / skills); the table carries the row per (source_id, slug).
//
// Wire shape: CopilotAssetSummary for the list, CopilotAssetDetail for the detail page.
// Mirrors how papers.ts reads from `papers` and prompts.ts reads from `prompt_items` — a
// dedicated read layer per independent table.
//
// Cursor pagination on (fetched_at, id) — both the `kind`-filtered and the unfiltered lists
// share the same cursor shape (asset_kind is part of the fetch order so the cursor only
// needs fetched_at + id, matching how papers.ts orders by published_at + arxiv_id).
//
// FIX-T (2026-10-06): detail page now carries zh translations from `copilot_translations`
// (migration 0050). The list endpoint deliberately does NOT load translations — they are
// per-card metadata only, and the list query is supposed to stay cheap. Detail endpoint
// joins `copilot_assets` with `copilot_translations` filtered by locale to populate
// `translations.zh`. When no row exists (worker hasn't run yet, or translation failed
// permanently) the field is `null`; the UI shows the English frontmatter.description.
import { sql } from "../db.ts";
import { decodeCursor, encodeCursor, InvalidCursorError, queryBinding } from "../lib/cursor.ts";
import type { CopilotAssetDetail, CopilotAssetKind, CopilotAssetSummary, CopilotAssetsQuery, CopilotAssetsResponse, CopilotTranslation } from "@aihot/contracts/awesome-copilot";
import { COPILOT_ASSET_KINDS } from "@aihot/contracts/awesome-copilot";

const DEFAULT_LIMIT = 30;
const MIN_LIMIT = 1;
const MAX_LIMIT = 60;

interface CopilotAssetRow {
  id: number;
  source_id: string;
  asset_kind: CopilotAssetKind;
  slug: string;
  filename: string;
  frontmatter: Record<string, unknown>;
  body_md: string;
  raw_url: string;
  blob_sha: string | null;
  size_bytes: number | null;
  repo_slug: string;
  default_branch: string;
  status: "fetched" | "analyzing" | "indexed" | "failed";
  fetched_at: Date;
  updated_at: Date;
}

const BODY_PREVIEW_LEN = 240;

function binding(q: CopilotAssetsQuery): string {
  return queryBinding({ k: q.kind ?? null, l: q.limit ?? DEFAULT_LIMIT });
}

function toSummary(r: CopilotAssetRow): CopilotAssetSummary {
  return {
    id: `${r.source_id}::${r.slug}`,
    assetKind: r.asset_kind,
    slug: r.slug,
    filename: r.filename,
    frontmatter: r.frontmatter ?? {},
    bodyPreview: r.body_md.slice(0, BODY_PREVIEW_LEN),
    rawUrl: r.raw_url,
    fetchedAt: r.fetched_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

function toDetail(r: CopilotAssetRow, translations: Partial<Record<"zh" | "en", CopilotTranslation>> = {}): CopilotAssetDetail {
  return {
    ...toSummary(r),
    bodyMd: r.body_md,
    repoSlug: r.repo_slug,
    defaultBranch: r.default_branch,
    blobSha: r.blob_sha,
    sizeBytes: r.size_bytes,
    status: r.status,
    // Translations are optional per-locale; null when the worker hasn't translated yet
    // (or has marked the row 'failed' permanently). The UI falls back to the English
    // frontmatter.description in that case.
    translations,
  };
}

export async function loadCopilotAssets(q: CopilotAssetsQuery = {}): Promise<CopilotAssetsResponse> {
  const now = q.now ?? new Date();
  const limit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, MIN_LIMIT), MAX_LIMIT);
  const bind = binding(q);

  type Cursor = { a: number; i: number; b: string };
  let after: { fetchedAt: number; id: number } | null = null;
  if (q.cursor) {
    const c = decodeCursor<Cursor>("copilot1", q.cursor);
    if (c.b !== bind || typeof c.a !== "number" || typeof c.i !== "number") throw new InvalidCursorError("cursor does not match this query");
    after = { fetchedAt: c.a, id: c.i };
  }

  const kindClause = q.kind && (COPILOT_ASSET_KINDS as readonly string[]).includes(q.kind)
    ? sql`AND asset_kind = ${q.kind}`
    : sql``;
  const cursorClause = after === null
    ? sql``
    : sql`AND (fetched_at, id) < (to_timestamp(${after.fetchedAt} / 1000.0), ${after.id})`;

  const rows = await sql<CopilotAssetRow[]>`
    SELECT id, source_id, asset_kind, slug, filename,
           frontmatter, body_md, raw_url, blob_sha, size_bytes,
           repo_slug, default_branch, status,
           fetched_at, updated_at
    FROM copilot_assets
    WHERE status IN ('fetched', 'indexed')
      ${kindClause}
      ${cursorClause}
    ORDER BY fetched_at DESC, id DESC
    LIMIT ${limit + 1}`;

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = hasMore && last
    ? encodeCursor("copilot1", { a: last.fetched_at.getTime(), i: last.id, b: bind })
    : null;

  // refreshAt: the worker runs every 15 min (Asia/Shanghai). Cache until the next slot so the
  // list stays fresh without an immediate refetch. `nextPapersFetch` mirrors this pattern.
  const refreshAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  return {
    filters: { kind: q.kind ?? null },
    items: page.map(toSummary),
    nextCursor,
    refreshAt,
    generatedAt: now.toISOString(),
  };
}

/**
 * Parses the composite id `{source_id}::{slug}` into its parts. Pure helper exposed for
 * unit testing without DB. Returns null when the composite id is malformed (no separator,
 * empty segments, or the source_id does not belong to the awesome-copilot family). Slug
 * is also validated against the github-path regex; control chars / path traversal attempts
 * are refused so they cannot reach the SQL query.
 */
export function parseCopilotAssetId(compositeId: string): { sourceId: string; slug: string } | null {
  const sepIdx = compositeId.indexOf("::");
  if (sepIdx <= 0 || sepIdx >= compositeId.length - 2) return null;
  const sourceId = compositeId.slice(0, sepIdx);
  const slug = compositeId.slice(sepIdx + 2);
  if (!sourceId.startsWith("external-awesome-copilot-")) return null;
  if (slug.length === 0 || slug.length > 500) return null;
  // Reject any control characters or path-traversal-y characters; slug is appended into the
  // public URL so it should look like a github path.
  if (!/^[A-Za-z0-9._/-]+$/.test(slug)) return null;
  return { sourceId, slug };
}

/**
 * Detail view by composite id `{source_id}::{slug}`. The source_id segment must match one of
 * the configured external-awesome-copilot-{agents,instructions,skills} sources — unknown
 * source_ids return null so the API 404s rather than serving a row from a misnamed source.
 *
 * FIX-T: loads zh translation from `copilot_translations` in the same query path so the
 * detail page has title_zh + description_zh ready. List endpoint deliberately skips this
 * join — translations are detail-page metadata only.
 */
export async function loadCopilotAssetDetail(compositeId: string): Promise<CopilotAssetDetail | null> {
  const parsed = parseCopilotAssetId(compositeId);
  if (!parsed) return null;
  const { sourceId, slug } = parsed;

  const rows = await sql<CopilotAssetRow[]>`
    SELECT id, source_id, asset_kind, slug, filename,
           frontmatter, body_md, raw_url, blob_sha, size_bytes,
           repo_slug, default_branch, status,
           fetched_at, updated_at
    FROM copilot_assets
    WHERE source_id = ${sourceId} AND slug = ${slug}
    LIMIT 1`;
  const row = rows[0];
  if (!row) return null;

  // Load both zh + en translations (zh is the one we render; en is the no-op pass-through
  // copy and may be useful for debug). PK lookup is O(1) on (asset_id, locale).
  const tRows = await sql<CopilotTranslationRow[]>`
    SELECT locale, title, description, fields, model, status
    FROM copilot_translations
    WHERE asset_id = ${row.id}`;
  const translations: Partial<Record<"zh" | "en", CopilotTranslation>> = {};
  for (const t of tRows) {
    translations[t.locale] = {
      locale: t.locale,
      title: t.title,
      description: t.description,
      fields: t.fields ?? {},
      model: t.model,
      status: t.status,
    };
  }
  return toDetail(row, translations);
}

interface CopilotTranslationRow {
  locale: "zh" | "en";
  title: string;
  description: string | null;
  fields: Record<string, unknown> | null;
  model: string | null;
  status: "translated" | "partial" | "failed";
}