// /papers — translation-officer feed (W4b plan §3.2). Loader fetches /api/site/papers and renders
// one big card per paper. Default: abstract expanded, key_points collapsed (one click in the
// card to reveal the 3-5 bullets — or open the detail page for the full list and copy). Filter
// chips let the reader narrow by arXiv primary category and a 7/30/90 day window.
//
// FIX-Z.4 — Load More (append) instead of full-page navigation.
//
// The original `<Link to="/papers?…&cursor=…">` triggered a same-route navigation: the loader
// re-ran from cursor=0 every time (FIX-Z fixed that) and the page scrolled back to the top. With
// 159 cs.AI papers on a single 10-07 day, the reader had to click "加载更早" 7 times before
// seeing 10-05 — the page never felt like it was advancing. Now the button is a client-side
// append: items accumulate below, the URL never carries a cursor, and a sentinel triggers
// auto-load when it intersects. (Lesson 10 anchor explains why cursor not in URL is safe given
// Lesson 9: PaperFilters still drops any cursor that ever appears, and the loader still
// retries-once on 400 invalid_cursor — neither defense is needed in this route, but they remain
// for defense in depth.)
import { SITE } from "@aihot/industry/site";
import type { PaperFilters as PaperFiltersContract, PaperStatus, PaperSummary, PapersResponse } from "@aihot/contracts/site";
import { useLoaderData } from "react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, apiGet } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { beijingDate } from "@aihot/contracts/time";
import { AsideCard, ReadingLayout } from "../components/ui/Page";
import { IconArrowRight, IconDoc } from "../components/icons";
import { PaperCard } from "../features/papers/PaperCard";
import { PaperFilters } from "../features/papers/PaperFilters";
import { CommentarySourcesCard } from "../features/papers/CommentarySourcesCard";

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=300" };
}

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const params = new URLSearchParams();
  const category = url.searchParams.get("category");
  if (category) params.set("category", category);
  const windowDays = url.searchParams.get("windowDays");
  if (windowDays) params.set("windowDays", windowDays);
  // FIX-AA-A — search query forwarded verbatim. Backend trims + lowercases for the bind hash
  // (see publication/papers.ts `binding(q)`); the loader passes through so the chip / select
  // URL never silently mutates the reader's query.
  const q = url.searchParams.get("q");
  if (q) params.set("q", q);
  // Sort key — only forward when not the default (published_at). Keeps the URL tidy for the
  // 80% of readers who never touch the sort row, and lets the chip-click path omit the key.
  const sort = url.searchParams.get("sort");
  if (sort && sort !== "published_at") params.set("sort", sort);
  // Page size — same convention: default 24 is implicit, anything else is explicit.
  const limit = url.searchParams.get("limit");
  if (limit && limit !== "24") params.set("limit", limit);
  params.set("limit", limit ?? "24");
  // FIX-Z.4 deliberately does NOT forward cursor from the URL: load-more append is now purely
  // client-side, and the URL only carries shareable filter state (category, windowDays, q,
  // sort, limit). See papers-pagination.test.ts and the Lesson 10 anchor for the trade-off.
  const qs = params.toString();
  const path = `/api/site/papers${qs ? `?${qs}` : ""}`;
  try {
    return await apiGet<PapersResponse>(path, { signal: request.signal });
  } catch (err) {
    // FIX-Z.3 retry-once is intentionally retained even though no cursor flows through this
    // path now. The loader can still be hit by direct arrival on a future URL that DOES carry
    // a cursor (search-engine cache, browser bookmark from an older revision). The retry
    // matches 400 + invalid_cursor; it is a no-op when no cursor was sent.
    if (err instanceof ApiError && err.status === 400 && err.code === "invalid_cursor") {
      const paramsNoCursor = new URLSearchParams(params);
      paramsNoCursor.delete("cursor");
      const qsRetry = paramsNoCursor.toString();
      const pathRetry = `/api/site/papers${qsRetry ? `?${qsRetry}` : ""}`;
      return await apiGet<PapersResponse>(pathRetry, { signal: request.signal });
    }
    throw err;
  }
}

export function meta() {
  return pageMeta({
    title: "论文解读",
    description: `${SITE.name} 的 arXiv 论文中文摘要与关键要点。`,
    path: "/papers",
    image: "/og/pages/papers.png",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: `${SITE.name} 论文解读`,
      description: `${SITE.name} 的 arXiv 论文中文摘要与关键要点。`,
    },
  });
}

const STATUS_TEXT: Record<PaperStatus, string> = {
  fetched: "已收录原文",
  translating: "翻译中",
  translated: "已出中文摘要",
  partial: "部分翻译",
  failed: "本次翻译失败",
};

export default function PapersPage() {
  const initial = useLoaderData<typeof loader>();
  const [items, setItems] = useState<PaperSummary[]>(initial.items ?? []);
  const [nextCursor, setNextCursor] = useState<string | null>(initial.nextCursor ?? null);
  const [loadStatus, setLoadStatus] = useState<"idle" | "loading" | "done" | "error">(
    initial.nextCursor ? "idle" : "done",
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  const filters: PaperFiltersContract = initial.filters;
  const refreshAt: string | null = initial.refreshAt;

  // FIX-Z.4 — client-side load-more. We never push the cursor into the URL: chip clicks are
  // the only navigation source, and they go through React Router (which already triggers a full
  // loader re-run for the new filter state — items reset to page 1 of the new query).
  // FIX-AA-A — limit / q / sort now ride in the URL too. buildPagePath mirrors the loader's
  // shareable state so the next-page fetch keeps the same filter window the reader saw.
  const buildPagePath = useCallback((cursor: string | null): string => {
    const sp = new URLSearchParams();
    if (filters.category) sp.set("category", filters.category);
    sp.set("windowDays", String(initial.windowDays));
    sp.set("limit", String(initial.limit ?? 24));
    if (filters.q) sp.set("q", filters.q);
    if (filters.sort && filters.sort !== "published_at") sp.set("sort", filters.sort);
    if (cursor) sp.set("cursor", cursor);
    return `/api/site/papers${sp.toString() ? `?${sp.toString()}` : ""}`;
  }, [filters.category, filters.q, filters.sort, initial.windowDays, initial.limit]);

  const loadMore = useCallback(async () => {
    if (loadStatus === "loading" || loadStatus === "done") return;
    if (!nextCursor) return;
    setLoadStatus("loading");
    setLoadError(null);
    try {
      const data = await apiGetClient<PapersResponse>(buildPagePath(nextCursor));
      setItems((prev) => [...prev, ...(data.items ?? [])]);
      const nc = data.nextCursor ?? null;
      setNextCursor(nc);
      setLoadStatus(nc ? "idle" : "done");
    } catch (err) {
      setLoadStatus("error");
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [loadStatus, nextCursor, buildPagePath]);

  // FIX-Z.4 — IntersectionObserver sentinel auto-load (button remains as a manual fallback
  // and as the visible affordance for keyboard / no-JS readers).
  // rootMargin "1200px 0px 1200px 0px" expands the trigger zone a screen-and-a-half in each
  // direction. The sentinel is the trailing element of the card list, so on a 4-screen page
  // it can sit ~3000+ px below the viewport. Without that margin the observer would never
  // see it cross from "below viewport" to "in viewport" because the reader's natural scroll
  // velocity skips past it. 1200px is enough to fire while the reader is still mid-scroll,
  // giving the next fetch time to land before the reader hits the bottom.
  const sentinelRef = useSentinelAutoLoad({
    enabled: loadStatus !== "done" && loadStatus !== "error" && Boolean(nextCursor),
    onIntersect: loadMore,
    rootMargin: "1200px 0px 1200px 0px",
  });

  const active = useMemo(
    () => ({
      category: filters.category ?? null,
      windowDays: initial.windowDays,
      q: filters.q ?? null,
      sort: filters.sort ?? "published_at",
      limit: initial.limit ?? 24,
    }),
    [filters.category, filters.q, filters.sort, initial.windowDays, initial.limit],
  );

  const counts = useMemo(() => {
    const byStatus: Record<PaperStatus, number> = {
      fetched: 0, translating: 0, translated: 0, partial: 0, failed: 0,
    };
    for (const it of items) byStatus[it.status] = (byStatus[it.status] ?? 0) + 1;
    return byStatus;
  }, [items]);

  const refreshAtText = useMemo(() => (refreshAt ? beijingDate(refreshAt) : null), [refreshAt]);

  return (
    <ReadingLayout
      aside={
        <>
          <AsideCard title="关于本频道">
            <p className="text-[12.5px] leading-[1.85] text-ink-3">
              每天从 <a href="https://arxiv.org" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">arXiv</a>{" "}
              的 cs.AI / cs.CL / cs.LG / cs.CV / cs.RO 五个方向拉论文,做中文摘要与关键要点。
            </p>
            <p className="mt-2 text-[12px] leading-[1.7] text-ink-4">
              翻译失败或正在翻译时仍展示英文摘要,不阻塞阅读。
            </p>
          </AsideCard>
          <AsideCard title="翻译进度">
            <ul className="space-y-1.5 text-[12.5px] text-ink-3">
              <li><span className="text-ok">●</span> 已出中文摘要 <span className="ml-1 text-ink-4">{counts.translated}</span></li>
              <li><span className="text-amber">●</span> 部分翻译 <span className="ml-1 text-ink-4">{counts.partial}</span></li>
              <li><span className="text-ink-4">●</span> 仅原文 <span className="ml-1 text-ink-4">{counts.fetched}</span></li>
              <li><span className="text-ink-4">●</span> 翻译中 <span className="ml-1 text-ink-4">{counts.translating}</span></li>
              <li><span className="text-ink-4">●</span> 翻译失败 <span className="ml-1 text-ink-4">{counts.failed}</span></li>
            </ul>
          </AsideCard>
          {refreshAtText && (
            <AsideCard title="下一次刷新">
              <p className="text-[12.5px] leading-[1.7] text-ink-3">
                预计 <span className="text-ink">{refreshAtText}</span> 更新一批。中文摘要通常在抓取后 5-15 分钟内陆续出。
              </p>
            </AsideCard>
          )}
          <CommentarySourcesCard />
        </>
      }
    >
      <header className="mb-5">
        <h1 className="text-[22px] font-semibold leading-tight text-ink">论文解读</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">
          arXiv 论文中文摘要 + 关键要点 · 最近 {initial.windowDays} 天
          {filters.q && <> · 关键词 <span className="text-ink-2">「{filters.q}」</span></>}
          · 已显示 {items.length} 篇
        </p>
      </header>

      <PaperFilters active={active} />

      {items.length === 0 ? (
        <EmptyState category={filters.category} windowDays={initial.windowDays} />
      ) : (
        <div className="space-y-4">
          {items.map((p) => (
            <PaperCard
              key={p.id}
              paper={{
                id: p.id, titleEn: p.titleEn, titleZh: p.titleZh,
                abstractEn: p.abstractEn, abstractZh: p.abstractZh,
                authors: p.authors, primaryCategory: p.primaryCategory,
                publishedAt: p.publishedAt, absUrl: p.absUrl,
                status: (p.status as PaperCardPaperStatus) ?? "fetched",
              }}
            />
          ))}
          <div
            ref={sentinelRef}
            data-testid="papers-load-sentinel"
            className="flex items-center justify-between border-t border-line-soft pt-4 text-[12px] text-ink-4"
          >
            <span>
              {loadStatus === "done" ? (
                <span data-testid="papers-load-state">已到最早一页</span>
              ) : loadStatus === "error" ? (
                <button
                  type="button"
                  onClick={loadMore}
                  className="inline-flex items-center gap-1 font-medium text-amber hover:underline"
                  data-testid="papers-load-button"
                >
                  加载失败,点此重试
                  <IconArrowRight size={12} />
                </button>
              ) : loadStatus === "loading" ? (
                <span data-testid="papers-load-state">加载中…</span>
              ) : (
                <button
                  type="button"
                  onClick={loadMore}
                  className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
                  data-testid="papers-load-button"
                >
                  加载更早论文
                  <IconArrowRight size={12} />
                </button>
              )}
            </span>
            <span>
              {Object.entries(counts).filter(([_, n]) => n > 0).map(([s, n]) => `${STATUS_TEXT[s as PaperStatus]} ${n}`).join(" · ")}
            </span>
          </div>
          {loadStatus === "error" && loadError ? (
            <p className="text-[11.5px] text-ink-4">错误:{loadError}</p>
          ) : null}
        </div>
      )}
    </ReadingLayout>
  );
}

type PaperCardPaperStatus = "translated" | "partial" | "fetched" | "failed";

function EmptyState({ category, windowDays }: { category: string | null; windowDays: number }) {
  return (
    <div className="card flex flex-col items-center gap-2.5 px-6 py-14 text-center">
      <IconDoc size={28} className="text-ink-4" />
      <div className="text-[15px] font-semibold text-ink-2">最近 {windowDays} 天暂无相关论文</div>
      <p className="max-w-md text-[12.5px] leading-relaxed text-ink-4">
        当前筛选条件 <code className="mono">{category ?? "全部类别"}</code> · {windowDays} 天没拉到论文。可扩大时间窗或换类别再试。
      </p>
    </div>
  );
}

// --- helpers below are kept local so the route file is self-contained ---

// FIX-Z.5 — client-side Load More retry-once mirror of FIX-Z.3. The loader's apiGet has the
// server-side retry; without this mirror, the Load More button on the client can 400 on a
// stale cursor and the only escape is a chip / form re-submit (which re-runs the loader — the
// only place where 400+invalid_cursor is currently auto-recovered). Real browsers hit this
// in three ways puppeteer-headless does not:
//   - IntersectionObserver + button click race the same fetch (same cursor, two parallel
//     callers; the second sees the cursor already consumed)
//   - Long-idle tab loses a session-bound etag on a deploy between page-1 and page-2 clicks
//   - Two tabs open on the same query racing each other
// The defense is the same as the server side: drop the cursor and retry — page 1 of the
// same q/sort/limit is the correct UX for a recovered cursor (the reader sees the same
// first-page items they already saw, and the next Load More works). Without it, the reader
// is stuck on "加载失败,点此重试" forever (the retry button calls loadMore with the same
// stale cursor). See Lesson 13.
async function apiGetClient<T>(path: string): Promise<T> {
  const tryFetch = async (p: string): Promise<T> => {
    const r = await fetch(p, { headers: { accept: "application/json" } });
    const text = await r.text();
    const data = text ? JSON.parse(text) : null;
    if (!r.ok) {
      const code = data && typeof data === "object" && "code" in data
        ? String((data as { code: unknown }).code ?? "")
        : null;
      const err = new Error(`api ${r.status} ${code ?? ""}`.trim()) as Error & { status?: number; code?: string | null };
      err.status = r.status;
      err.code = code;
      throw err;
    }
    return data as T;
  };
  try {
    return await tryFetch(path);
  } catch (err) {
    const e = err as Error & { status?: number; code?: string | null };
    if (e.status === 400 && e.code === "invalid_cursor" && /[?&]cursor=[^&]*/.test(path)) {
      // Drop the cursor and try again — same q/sort/limit/windowDays/category. The chip-click
      // path would do the same thing (BIND_KEYS drops the cursor on any filter change); we
      // just do it eagerly here so the Load More button is self-healing.
      const retried = path.replace(/[?&]cursor=[^&]*/, "").replace(/\?$/, "");
      return await tryFetch(retried);
    }
    throw err;
  }
}

function useSentinelAutoLoad({
  enabled,
  onIntersect,
  rootMargin = "200px 0px",
}: {
  enabled: boolean;
  onIntersect: () => void;
  rootMargin?: string;
}) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  // FIX-Z.4 — keep `onIntersect` behind a ref so the IO effect does not tear down and
  // reconnect on every state flip (loadStatus: idle→loading→idle, nextCursor after each
  // append, buildPagePath when filters change). A reconnect causes IO to lose its
  // intersection transition state — if the sentinel happens to be already-intersecting at
  // reconnect time, IO does not re-fire until the sentinel crosses 0→1 again, which the
  // reader's natural scroll often skips past (1px at a time on smooth-trackpads).
  const cbRef = useRef(onIntersect);
  useEffect(() => { cbRef.current = onIntersect; }, [onIntersect]);
  useEffect(() => {
    if (!el || !enabled) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) cbRef.current();
        }
      },
      { rootMargin },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [el, enabled, rootMargin]);
  return setEl;
}

// Silence the unused-reducer-and-effect-helper noise from earlier drafts (kept for parity with
// the test suite that mirrors these helpers — see papers-pagination.test.ts).
export const __reduceLoad = (s: { items: PaperSummary[]; nextCursor: string | null }, a: { type: "noop" } | { type: "set"; items: PaperSummary[]; nextCursor: string | null }) => {
  if (a.type === "set") return { items: a.items, nextCursor: a.nextCursor };
  return s;
};