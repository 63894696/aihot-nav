// /papers — translation-officer feed (W4b plan §3.2). Loader fetches /api/site/papers and renders
// one big card per paper. Default: abstract expanded, key_points collapsed (one click in the
// card to reveal the 3-5 bullets — or open the detail page for the full list and copy). Filter
// chips let the reader narrow by arXiv primary category and a 7/30/90 day window.
import { SITE } from "@aihot/industry/site";
import type { PaperFilters as PaperFiltersContract, PaperStatus, PaperSummary, PapersResponse } from "@aihot/contracts/site";
import { Link, useLoaderData, useSearchParams } from "react-router";
import { useMemo } from "react";
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
  const limit = url.searchParams.get("limit") ?? "24";
  params.set("limit", limit);
  // FIX-Z: 论文 "加载更早论文" 按钮之前不工作,因为 cursor 没有透传给 api,
  // 导致 data.nextCursor 永远是首页 cursor,buildNextQuery 算出的 to 跟当前 URL 相同,
  // 浏览器/React Router 把同 URL 当成 revalidate 而非 navigation,体验上等于 "刷新页面".
  // backend publication/papers.ts 已经原生支持 q.cursor(见 decodeCursor 调用),只需透传.
  const cursor = url.searchParams.get("cursor");
  if (cursor) params.set("cursor", cursor);
  const qs = params.toString();
  const path = `/api/site/papers${qs ? `?${qs}` : ""}`;
  try {
    return await apiGet<PapersResponse>(path, { signal: request.signal });
  } catch (err) {
    // FIX-Z.3: graceful cursor-staleness fallback. The bind hash in
    // `binding(q)` (publication/papers.ts) covers {category, tag, windowDays, limit}. A cursor
    // minted for one query is rejected by the api (HTTP 400, code='invalid_cursor') when the
    // reader reaches a URL whose other params produce a different hash — chip click, hand-edited
    // URL, copy/paste from an earlier session, etc. React Router surfaces the 400 as 500 to the
    // reader. Drop the stale cursor and refetch the new query's first page (same contract as
    // PaperFilters BIND_KEYS — the chip row already does this on click; the loader handles the
    // remaining direct-arrival paths: hand-typed URL, share link, browser back/forward across a
    // category switch, SSR via stale link).
    //
    // Only retries on 400 / invalid_cursor — other failures (network, 5xx, malformed JSON)
    // bubble up unchanged.
    if (err instanceof ApiError && err.status === 400 && err.code === "invalid_cursor" && cursor) {
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
  const data = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const items: PaperSummary[] = data.items ?? [];
  const filters: PaperFiltersContract = data.filters;
  const refreshAt: string | null = data.refreshAt;

  const active = useMemo(
    () => ({ category: filters.category ?? null, windowDays: data.windowDays }),
    [filters.category, data.windowDays]
  );

  const counts = useMemo(() => {
    const byStatus: Record<PaperStatus, number> = {
      fetched: 0,
      translating: 0,
      translated: 0,
      partial: 0,
      failed: 0,
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
              <li>
                <span className="text-ok">●</span> 已出中文摘要 <span className="ml-1 text-ink-4">{counts.translated}</span>
              </li>
              <li>
                <span className="text-amber">●</span> 部分翻译 <span className="ml-1 text-ink-4">{counts.partial}</span>
              </li>
              <li>
                <span className="text-ink-4">●</span> 仅原文 <span className="ml-1 text-ink-4">{counts.fetched}</span>
              </li>
              <li>
                <span className="text-ink-4">●</span> 翻译中 <span className="ml-1 text-ink-4">{counts.translating}</span>
              </li>
              <li>
                <span className="text-ink-4">●</span> 翻译失败 <span className="ml-1 text-ink-4">{counts.failed}</span>
              </li>
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
          arXiv 论文中文摘要 + 关键要点 · 最近 {data.windowDays} 天 · 共 {items.length} 篇
        </p>
      </header>

      <PaperFilters active={active} />

      {items.length === 0 ? (
        <EmptyState
          category={filters.category}
          windowDays={data.windowDays}
          searchParams={searchParams}
        />
      ) : (
        <div className="space-y-4">
          {items.map((p) => (
            <PaperCard
              key={p.id}
              paper={{
                id: p.id,
                titleEn: p.titleEn,
                titleZh: p.titleZh,
                abstractEn: p.abstractEn,
                abstractZh: p.abstractZh,
                authors: p.authors,
                primaryCategory: p.primaryCategory,
                publishedAt: p.publishedAt,
                absUrl: p.absUrl,
                status: (p.status as PaperCardPaperStatus) ?? "fetched",
              }}
            />
          ))}
          <div className="flex items-center justify-between border-t border-line-soft pt-4 text-[12px] text-ink-4">
            <span>
              {data.nextCursor ? (
                <Link
                  to={`/papers?${buildNextQuery(searchParams, data.nextCursor)}`}
                  className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
                  prefetch="intent"
                >
                  加载更早论文
                  <IconArrowRight size={12} />
                </Link>
              ) : (
                <span>已到最早一页</span>
              )}
            </span>
            <span>
              {Object.entries(counts)
                .filter(([_, n]) => n > 0)
                .map(([s, n]) => `${STATUS_TEXT[s as PaperStatus]} ${n}`)
                .join(" · ")}
            </span>
          </div>
        </div>
      )}
    </ReadingLayout>
  );
}

type PaperCardPaperStatus = "translated" | "partial" | "fetched" | "failed";

function EmptyState({ category, windowDays, searchParams }: { category: string | null; windowDays: number; searchParams: URLSearchParams }) {
  const resetHref = `/papers${searchParams.toString() ? `?${searchParams.toString()}` : ""}`;
  return (
    <div className="card flex flex-col items-center gap-2.5 px-6 py-14 text-center">
      <IconDoc size={28} className="text-ink-4" />
      <div className="text-[15px] font-semibold text-ink-2">最近 {windowDays} 天暂无相关论文</div>
      <p className="max-w-md text-[12.5px] leading-relaxed text-ink-4">
        当前筛选条件 <code className="mono">{category ?? "全部类别"}</code> · {windowDays} 天没拉到论文。可扩大时间窗或换类别再试。
      </p>
      <Link to={resetHref} className="mt-2 inline-flex items-center gap-1 text-[12.5px] font-medium text-accent hover:underline">
        清除筛选条件
      </Link>
    </div>
  );
}

function buildNextQuery(current: URLSearchParams, cursor: string): string {
  const next = new URLSearchParams(current);
  next.set("cursor", cursor);
  return next.toString();
}