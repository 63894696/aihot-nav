// First-party site API (/api/site/*). Not public, not versioned, never called /api/v2.
// Reads through the same public read layer as v1; no cookies are read or set.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isCategoryKey, isChannelKey, type CategoryKey, type ChannelKey } from "@aihot/contracts/taxonomy";
import { InvalidCursorError } from "@aihot/backend/lib/cursor";
import { exportMarkdown, loadItemDetail, siteItemDetail } from "@aihot/backend/publication/detail";
import { loadPool, SearchBusyError } from "@aihot/backend/publication/pool";
import { loadTimeline } from "@aihot/backend/publication/timeline";
import { loadDaily } from "@aihot/backend/publication/daily";
import { loadTools, loadToolDetail } from "@aihot/backend/publication/tools";
import { loadChangelog } from "@aihot/backend/publication/changelog";
import { loadPapers, loadPaperDetail, loadPaperSiblings } from "@aihot/backend/publication/papers";
import { loadPrompts, loadPromptDetail } from "@aihot/backend/publication/prompts";
import { loadDiscover } from "@aihot/backend/publication/discover";
import { PROMPT_CATEGORIES, type PromptCategory } from "@aihot/contracts/site";
import { loadStoryFollowups } from "@aihot/backend/publication/followups";
import { loadDevelopments, loadGroupReports } from "@aihot/backend/publication/groups";
import { loadTopicTags } from "@aihot/backend/publication/topics";
import { loadHotStrip } from "@aihot/backend/events/hot-read";
import { loadReleases, siteMeta } from "@aihot/backend/site/meta";
import { loadContact, loadMakerAvatar } from "@aihot/backend/site/contact";
import { loadSiteStats } from "@aihot/backend/site/stats";
import { itemAvailability } from "@aihot/backend/publication/availability";
import { listTopicSummaries, loadTopicPage } from "@aihot/backend/publication/topics";
import { registerFeedback } from "./feedback.ts";

import { loadHot, loadStoryDetail, resolveStory } from "@aihot/backend/publication/stories";
import { listReports, loadReport, reportNavigation, loadReportNavigation, loadReportMonth, type ReportKind } from "@aihot/backend/publication/reports";
import { looseQuery, sendJsonWithEtag, sendProblem } from "../http/respond.ts";

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

class BadRequest extends Error {}

/** Cache until the earliest pending release in scope (an absolute deadline shared with any proxy or CDN in front). */
export function cacheUntil(reply: FastifyReply, defaultSeconds: number, refreshAt: string | null, now = Date.now()) {
  let seconds = defaultSeconds;
  if (refreshAt) seconds = Math.max(0, Math.min(seconds, Math.floor((Date.parse(refreshAt) - now) / 1000)));
  reply.header("Cache-Control", seconds > 0 ? `public, max-age=${seconds}, s-maxage=${seconds}` : "no-cache");
  reply.header("X-Accel-Expires", `@${Math.floor(now / 1000) + seconds}`);
  return `public, max-age=${seconds}, s-maxage=${seconds}`;
}

export function siteHandler(fn: Handler): Handler {
  return async (req, reply) => {
    try {
      return await fn(req, reply);
    } catch (error) {
      if (error instanceof BadRequest) return sendProblem(req, reply, { status: 400, code: "invalid_request", detail: error.message });
      if (error instanceof InvalidCursorError) return sendProblem(req, reply, { status: 400, code: "invalid_cursor", detail: error.message });
      if (error instanceof SearchBusyError) {
        return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "search busy", retryAfter: error.retryAfter });
      }
      req.log.error({ err: error, path: req.url.split("?")[0] }, "site api error");
      return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "temporarily unavailable", retryAfter: 10 });
    }
  };
}

export interface FilterParams {
  channel: ChannelKey;
  category: CategoryKey | null;
  tag: string | null;
  topic: string | null;
  topicTags: string[] | null;
}

export async function parseFilters(q: Record<string, string>): Promise<FilterParams> {
  const channel = q.channel ?? "all";
  if (!isChannelKey(channel)) throw new BadRequest("invalid channel");
  const category = q.category ?? null;
  if (category !== null && !isCategoryKey(category)) throw new BadRequest("invalid category");
  const tag = q.tag?.trim() ? q.tag.trim().slice(0, 60) : null;
  const topic = q.topic?.trim() || null;
  let topicTags: string[] | null = null;
  if (topic) {
    topicTags = await loadTopicTags(topic);
    if (!topicTags) throw new BadRequest("unknown topic");
  }
  return { channel, category: category as CategoryKey | null, tag, topic, topicTags };
}

export function registerSite(app: FastifyInstance) {
  app.get("/api/site/meta", siteHandler(async (req, reply) => {
    return sendJsonWithEtag(req, reply, siteMeta(), { etagPrefix: "meta", cacheControl: "public, max-age=60, s-maxage=60" });
  }));

  app.get("/api/site/timeline", siteHandler(async (req, reply) => {
    const q = looseQuery(req);
    const filters = await parseFilters(q);
    const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 40);
    const unfiltered = filters.channel === "all" && !filters.category && !filters.tag && !filters.topic && !q.cursor;
    const [data, hot] = await Promise.all([
      loadTimeline({ ...filters, cursor: q.cursor || null, limit }),
      unfiltered ? loadHotStrip() : null,
    ]);
    const body = { ...data, hot, generatedAt: new Date().toISOString() };
    const cc = cacheUntil(reply, 60, data.refreshAt);
    return sendJsonWithEtag(req, reply, body, { etagPrefix: "tl", cacheControl: cc, etagOf: { ...data, hot } });
  }));

  // Daily fresh-tools window: top N tool_release items from the last sinceHours, score ≥ minScore.
  // Used by the homepage ("/new") — the navigation layer's first-paint card list.
  app.get("/api/site/daily", siteHandler(async (req, reply) => {
    const q = looseQuery(req);
    const sinceHours = Number(q.since) || 24;
    const minScore = Number(q.minScore) || 70;
    const limit = Number(q.limit) || 30;
    const data = await loadDaily({ sinceHours, minScore, limit });
    const cc = cacheUntil(reply, 60, data.refreshAt);
    return sendJsonWithEtag(req, reply, data, { etagPrefix: "daily", cacheControl: cc, etagOf: data.items });
  }));

  // Tools catalog: tool_release items over a longer window with category/tag/channel filters and
  // cursor pagination. Used by /tools — the navigation layer's main grid (complement to /new).
  app.get("/api/site/tools", siteHandler(async (req, reply) => {
    const q = looseQuery(req);
    const channel = q.channel ?? "all";
    if (!isChannelKey(channel)) return sendProblem(req, reply, { status: 400, code: "invalid_request", detail: "invalid channel" });
    const category = q.category ?? null;
    if (category !== null && !isCategoryKey(category)) return sendProblem(req, reply, { status: 400, code: "invalid_request", detail: "invalid category" });
    const tag = q.tag?.trim() ? q.tag.trim().slice(0, 60) : null;
    const sort: "recent" | "score" = q.sort === "score" ? "score" : "recent";
    const windowDays = Number(q.windowDays) || 30;
    const limit = Number(q.limit) || 24;
    const cursor = q.cursor || null;
    const data = await loadTools({ channel, category: category as CategoryKey | null, tag, sort, windowDays, limit, cursor });
    const cc = cacheUntil(reply, 60, data.refreshAt);
    const { generatedAt: _, ...content } = data;
    return sendJsonWithEtag(req, reply, data, { etagPrefix: "tools", cacheControl: cc, etagOf: content });
  }));

  app.get("/api/site/pool", siteHandler(async (req, reply) => {
    const q = looseQuery(req);
    const filters = await parseFilters(q);
    const page = Math.min(Math.max(Number(q.page) || 1, 1), 50);
    const search = q.q?.trim() ? q.q.trim().slice(0, 200) : null;
    const tab = q.tab === "relevance" ? "relevance" : "time";
    const data = await loadPool({ ...filters, q: search, tab, page });
    const { generatedAt: _, ...content } = data;
    return sendJsonWithEtag(req, reply, data, { etagPrefix: "pool", cacheControl: "public, max-age=60, s-maxage=60", etagOf: content });
  }));

  // v0.2.1-#6 — three-block cross-axis discovery slice for /all's side-by-side teaser. The
  // category filter is intentionally NOT routed through parseFilters: that helper only accepts
  // CATEGORY_KEYS, but the discover view needs to route any axis category (capability /
  // arXiv primary / prompt capability). loadDiscover validates + assigns per-block and silently
  // drops unknown keys rather than 4xx'ing the whole page.
  app.get("/api/site/discover", siteHandler(async (req, reply) => {
    const q = looseQuery(req);
    const category = q.category?.trim() ? q.category.trim().slice(0, 60) : null;
    const data = await loadDiscover({ category });
    const { generatedAt: _, ...content } = data;
    return sendJsonWithEtag(req, reply, data, { etagPrefix: "discover", cacheControl: "public, max-age=60, s-maxage=60", etagOf: content });
  }));

  app.get("/api/site/items/:id", siteHandler(async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "item not found" });
    const result = await loadItemDetail(id);
    if (result.kind === "not_found") return sendProblem(req, reply, { status: 404, code: "not_found", detail: "item not found", cacheControl: "public, max-age=60" });
    return sendJsonWithEtag(req, reply, siteItemDetail(result.detail), { etagPrefix: "item", cacheControl: "public, max-age=60, s-maxage=60" });
  }));

  app.get("/api/site/items/:id/original", siteHandler(async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "item not found" });
    const result = await loadItemDetail(id);
    if (result.kind === "not_found") return sendProblem(req, reply, { status: 404, code: "not_found", detail: "item not found", cacheControl: "public, max-age=60" });
    return sendJsonWithEtag(req, reply, siteItemDetail(result.detail, true), { etagPrefix: "item-original", cacheControl: "public, max-age=60, s-maxage=60" });
  }));

  // /tools/:id — same body as /items/:id, plus two narrow rail pieces (last 7d updates +
  // tag-overlap ≥ 2 related). The plan's tool-detail page renders all three in one column.
  app.get("/api/site/tool/:id", siteHandler(async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "tool not found" });
    const result = await loadToolDetail(id);
    if (result.kind === "not_found") return sendProblem(req, reply, { status: 404, code: "not_found", detail: "tool not found", cacheControl: "public, max-age=60" });
    return sendJsonWithEtag(req, reply, result.detail, { etagPrefix: "tool", cacheControl: "public, max-age=60, s-maxage=60" });
  }));

  // /tools/:id/original — same as /tools/:id but with body language pinned to the source language
  // (matches the /items/:id/original projection used by the language toggle in tool.$id.tsx).
  app.get("/api/site/tool/:id/original", siteHandler(async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "tool not found" });
    const result = await loadToolDetail(id, undefined, true);
    if (result.kind === "not_found") return sendProblem(req, reply, { status: 404, code: "not_found", detail: "tool not found", cacheControl: "public, max-age=60" });
    return sendJsonWithEtag(req, reply, result.detail, { etagPrefix: "tool-original", cacheControl: "public, max-age=60, s-maxage=60" });
  }));

  app.get("/api/site/stories/:publicId/followups", siteHandler(async (req, reply) => {
    const result = await loadStoryFollowups((req.params as { publicId: string }).publicId);
    if (!result) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "story not found" });
    return reply.header("Cache-Control", "no-store").send(result);
  }));

  app.get("/api/site/groups/:factId/reports", siteHandler(async (req, reply) => {
    const q = looseQuery(req);
    const filters = await parseFilters(q);
    const take = Math.min(Math.max(Number(q.take) || 20, 1), 40);
    const data = await loadGroupReports({ factPublicId: (req.params as { factId: string }).factId, ...filters, cursor: q.cursor || null, take, revision: q.revision || null });
    if (data.kind === "not_found") return sendProblem(req, reply, { status: 404, code: "not_found", detail: "reading group unavailable" });
    if (data.kind === "changed") return sendProblem(req, reply, { status: 409, code: "group_changed", detail: "reading group changed; reload it" });
    reply.header("Cache-Control", "no-store");
    return reply.send(data.body);
  }));

  app.get("/api/site/stories/:publicId/developments", siteHandler(async (req, reply) => {
    const q = looseQuery(req);
    const filters = await parseFilters(q);
    const take = Math.min(Math.max(Number(q.take) || 10, 1), 20);
    const data = await loadDevelopments({ storyPublicId: (req.params as { publicId: string }).publicId, ...filters, cursor: q.cursor || null, take, revision: q.revision || null });
    if (data.kind === "not_found") return sendProblem(req, reply, { status: 404, code: "not_found", detail: "reading group unavailable" });
    if (data.kind === "changed") return sendProblem(req, reply, { status: 409, code: "group_changed", detail: "reading group changed; reload it" });
    reply.header("Cache-Control", "no-store");
    return reply.send(data.body);
  }));

  app.get("/api/site/contact", siteHandler(async (req, reply) => {
    const [contact, makerAvatar] = await Promise.all([loadContact(), loadMakerAvatar()]);
    return sendJsonWithEtag(req, reply, { ...contact, makerAvatar }, { etagPrefix: "contact", cacheControl: "public, max-age=300, s-maxage=300" });
  }));

  app.get("/api/site/stats", siteHandler(async (req, reply) => {
    return sendJsonWithEtag(req, reply, await loadSiteStats(), { etagPrefix: "stats", cacheControl: "public, max-age=300, s-maxage=300" });
  }));

  app.get("/api/site/releases", siteHandler(async (req, reply) => {
    return sendJsonWithEtag(req, reply, loadReleases(), { etagPrefix: "releases", cacheControl: "public, max-age=300, s-maxage=300" });
  }));

  // W4a — tool/model/platform update aggregation (path migrated from /changelog on 2026-10-01;
  // the legacy /changelog endpoint served industry/changelog.json which is now industry/releases.json).
  app.get("/api/site/changelog", siteHandler(async (req, reply) => {
    const q = looseQuery(req);
    const channel = q.channel ?? "all";
    if (!isChannelKey(channel)) return sendProblem(req, reply, { status: 400, code: "invalid_request", detail: "invalid channel" });
    const category = q.category ?? null;
    if (category !== null && !isCategoryKey(category)) return sendProblem(req, reply, { status: 400, code: "invalid_request", detail: "invalid category" });
    const tag = q.tag?.trim() ? q.tag.trim().slice(0, 60) : null;
    const windowDays = Number(q.windowDays) || 30;
    const limit = Number(q.limit) || 60;
    const cursor = q.cursor || null;
    const data = await loadChangelog({ channel, category: category as CategoryKey | null, tag, windowDays, limit, cursor });
    const cc = cacheUntil(reply, 60, data.refreshAt);
    const { generatedAt: _, ...content } = data;
    return sendJsonWithEtag(req, reply, data, { etagPrefix: "changelog", cacheControl: cc, etagOf: content });
  }));

  // W4b — arXiv paper translation-officer feed. Independent of publications; cursor on (published_at, arxiv_id).
  app.get("/api/site/papers", siteHandler(async (req, reply) => {
    const q = looseQuery(req);
    const category = q.category?.trim() ? q.category.trim().slice(0, 20) : null;
    const tag = q.tag?.trim() ? q.tag.trim().slice(0, 60) : null;
    const windowDays = Number(q.windowDays) || 30;
    const limit = Number(q.limit) || 24;
    const cursor = q.cursor || null;
    const data = await loadPapers({ category, tag, windowDays, limit, cursor });
    const cc = cacheUntil(reply, 60, data.refreshAt);
    return sendJsonWithEtag(req, reply, data, { etagPrefix: "papers", cacheControl: cc });
  }));

  app.get("/api/site/papers/:id", siteHandler(async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const d = await loadPaperDetail(id);
    if (!d) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "paper not found" });
    return sendJsonWithEtag(req, reply, d, { etagPrefix: "paper", cacheControl: "public, max-age=300, s-maxage=300" });
  }));

  // W5-3 v0.2.1-#4 — sibling papers in the same arXiv primary_category. The detail page renders
  // this as a horizontal row beneath the abstract so a reader can navigate sideways without
  // bouncing back to /papers. Empty array means the paper is unknown or no other paper shares the
  // category in the table — the UI degrades by hiding the section, not by 404'ing.
  app.get("/api/site/papers/:id/siblings", siteHandler(async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const items = await loadPaperSiblings(id, 6);
    return sendJsonWithEtag(req, reply, { items }, { etagPrefix: "paper-siblings", cacheControl: "public, max-age=300, s-maxage=300" });
  }));

  // W5-3 — prompt column. Public read layer for reusable prompts collected from public posts.
  app.get("/api/site/prompts", siteHandler(async (req, reply) => {
    const q = looseQuery(req);
    const categoryParam = q.category?.trim() || null;
    const category = categoryParam && (PROMPT_CATEGORIES as readonly string[]).includes(categoryParam)
      ? (categoryParam as PromptCategory)
      : null;
    if (categoryParam && category === null) {
      return sendProblem(req, reply, { status: 400, code: "invalid_request", detail: "invalid category" });
    }
    const windowDays = Number(q.windowDays) || 90;
    const limit = Number(q.limit) || 24;
    const cursor = q.cursor || null;
    let data;
    try {
      data = await loadPrompts({ category, windowDays, limit, cursor });
    } catch (e) {
      if (e instanceof InvalidCursorError) {
        return sendProblem(req, reply, { status: 400, code: "invalid_cursor", detail: "cursor does not match this query" });
      }
      throw e;
    }
    const cc = cacheUntil(reply, 60, data.refreshAt);
    return sendJsonWithEtag(req, reply, data, { etagPrefix: "prompts", cacheControl: cc });
  }));

  app.get("/api/site/prompts/:id", siteHandler(async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!/^\d+$/.test(id)) {
      return sendProblem(req, reply, { status: 400, code: "invalid_request", detail: "invalid prompt id" });
    }
    const d = await loadPromptDetail(id);
    if (!d) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "prompt not found" });
    return sendJsonWithEtag(req, reply, d, { etagPrefix: "prompt", cacheControl: "public, max-age=300, s-maxage=300" });
  }));

  app.get("/api/site/items/availability", siteHandler(async (req, reply) => {
    const ids = (looseQuery(req).ids ?? "").split(",").filter(Boolean);
    reply.header("Cache-Control", "no-store");
    return reply.send(await itemAvailability(ids));
  }));

  app.get("/api/site/topics", siteHandler(async (req, reply) => {
    return sendJsonWithEtag(req, reply, { topics: await listTopicSummaries() }, { etagPrefix: "topics", cacheControl: "public, max-age=300, s-maxage=300" });
  }));

  app.get("/api/site/topics/:slug", siteHandler(async (req, reply) => {
    const slug = (req.params as { slug: string }).slug;
    const page = Number(looseQuery(req).page ?? 1);
    const data = Number.isInteger(page) ? await loadTopicPage(slug, page) : null;
    if (!data) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "topic page not found", cacheControl: "public, max-age=60" });
    return sendJsonWithEtag(req, reply, data, { etagPrefix: "topic", cacheControl: "public, max-age=60, s-maxage=60" });
  }));

  registerFeedback(app);


  app.get("/api/site/hot", siteHandler(async (req, reply) => {
    const data = await loadHot();
    return sendJsonWithEtag(req, reply, data, { etagPrefix: "hot", cacheControl: "public, max-age=30, s-maxage=30" });
  }));

  app.get("/api/site/stories/:publicId", siteHandler(async (req, reply) => {
    const publicId = (req.params as { publicId: string }).publicId;
    const found = await resolveStory(publicId);
    if (found.kind === "merged") {
      return reply.code(308).header("Location", `/api/site/stories/${found.target}`).header("Cache-Control", "public, max-age=300").send({ mergedInto: found.target });
    }
    if (found.kind === "not_found") return sendProblem(req, reply, { status: 404, code: "not_found", detail: "story not found", cacheControl: "public, max-age=60" });
    const data = await loadStoryDetail(found.storyId);
    if (!data) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "story not public", cacheControl: "public, max-age=60" });
    return sendJsonWithEtag(req, reply, data, { etagPrefix: "story", cacheControl: "public, max-age=60, s-maxage=60" });
  }));

  app.get("/api/site/reports/:kind", siteHandler(async (req, reply) => {
    const kind = (req.params as { kind: string }).kind;
    if (!["daily", "weekly", "monthly"].includes(kind)) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "unknown report kind" });
    const data = await listReports(kind as ReportKind);
    return sendJsonWithEtag(req, reply, { kind, items: data }, { etagPrefix: "reports", cacheControl: "public, max-age=60, s-maxage=60" });
  }));

  // The latest report page needs its archive selector and the report in one HTTP request.
  app.get("/api/site/reports/:kind/latest-page", siteHandler(async (req, reply) => {
    const kind = (req.params as { kind: string }).kind;
    if (!["daily", "weekly", "monthly"].includes(kind)) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "unknown report kind" });
    const index = await listReports(kind as ReportKind);
    const report = index[0] ? await loadReport(kind as ReportKind, index[0].key) : null;
    return sendJsonWithEtag(req, reply, { index: reportNavigation(kind as ReportKind, index, report?.key ?? ""), report }, { etagPrefix: "report-latest", cacheControl: "public, max-age=60, s-maxage=60" });
  }));

  app.get("/api/site/reports/:kind/navigation/:key", siteHandler(async (req, reply) => {
    const { kind, key } = req.params as { kind: string; key: string };
    if (!["daily", "weekly", "monthly"].includes(kind) || !/^\d{4}-(\d{2}(-\d{2})?|W\d{2})$/.test(key)) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "report not found" });
    return sendJsonWithEtag(req, reply, { items: await loadReportNavigation(kind as ReportKind, key) }, { etagPrefix: "report-navigation", cacheControl: "public, max-age=60, s-maxage=60" });
  }));

  app.get("/api/site/reports/daily/months/:month", siteHandler(async (req, reply) => {
    const { month } = req.params as { month: string };
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "month not found" });
    return sendJsonWithEtag(req, reply, { items: await loadReportMonth("daily", month) }, { etagPrefix: "report-month", cacheControl: "public, max-age=60, s-maxage=60" });
  }));

  app.get("/api/site/reports/:kind/:key", siteHandler(async (req, reply) => {
    const { kind, key } = req.params as { kind: string; key: string };
    if (!["daily", "weekly", "monthly"].includes(kind) || !/^\d{4}-(\d{2}(-\d{2})?|W\d{2})$/.test(key)) {
      return sendProblem(req, reply, { status: 404, code: "not_found", detail: "report not found" });
    }
    const data = await loadReport(kind as ReportKind, key);
    if (!data) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "report not found", cacheControl: "public, max-age=60" });
    return sendJsonWithEtag(req, reply, data, { etagPrefix: "report", cacheControl: "public, max-age=120, s-maxage=120" });
  }));

  // Markdown export: attachment, 404 when there is nothing to export (same predicate as the button).
  app.get("/items/:id/markdown", siteHandler(async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
    const md = await exportMarkdown(id);
    if (!md) return reply.code(404).header("Cache-Control", "public, max-age=60").type("text/plain; charset=utf-8").send("Not found");
    return reply
      .header("Content-Type", "text/markdown; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${md.filename}"`)
      .header("Cache-Control", "public, max-age=300, s-maxage=300")
      .header("X-Robots-Tag", "noindex")
      .send(md.body);
  }));
}
