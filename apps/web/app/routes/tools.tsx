// /tools — the navigation layer's tool catalog. One card per publication (FeedItemSummary from
// /api/site/tools). Filters: channel (all/news/firstParty) + category + tag + sort (recent|score) +
// windowDays (1..90). Cursor pagination handled by the client side (load more).
import { data as withHeaders, redirect, useLoaderData, useSearchParams } from "react-router";
import type { Route } from "./+types/tools";
import type { ToolsResponse } from "@aihot/contracts/site";
import { isCategoryKey, isChannelKey, type CategoryKey, type ChannelKey } from "@aihot/contracts/taxonomy";
import { withSubject } from "@aihot/industry/site";
import { loadOr404, releaseBoundCache, queryString } from "../lib/api.server";
import { legacyCategoryRedirect } from "../lib/categoryCompat";
import { pageMeta, listPath } from "../lib/seo";
import { monthDayTime } from "../lib/format";
import { ToolGrid } from "../features/feed/ToolGrid";
import { CategoryTabs, hrefWith } from "../features/feed/Filters";
import { PillTabs } from "../components/ui/Tabs";
import { EmptyState } from "../components/ui/Page";

const SORT_OPTIONS = [
  { key: "recent", label: "最新" },
  { key: "score", label: "评分高" },
] as const;

const WINDOW_OPTIONS = [
  { key: 7, label: "7 天" },
  { key: 30, label: "30 天" },
  { key: 90, label: "90 天" },
] as const;

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const channel: ChannelKey = isChannelKey(url.searchParams.get("channel")) ? (url.searchParams.get("channel") as ChannelKey) : "all";
  const rawCategory = url.searchParams.get("category");
  const redirectTarget = legacyCategoryRedirect(rawCategory, "/tools");
  if (redirectTarget) throw redirect(redirectTarget);
  const category: CategoryKey | null = isCategoryKey(rawCategory) ? (rawCategory as CategoryKey) : null;
  const tag = url.searchParams.get("tag")?.trim().slice(0, 60) ?? null;
  const sort = url.searchParams.get("sort") === "score" ? "score" : "recent";
  const windowDays = Math.min(Math.max(Number(url.searchParams.get("windowDays")) || 30, 1), 90);
  const cursor = url.searchParams.get("cursor") || null;
  const limit = 24;
  const upstream = new Headers();
  const path = `/api/site/tools${queryString({ channel: channel === "all" ? null : channel, category, tag, sort, windowDays, limit, cursor })}`;
  const data = await loadOr404<ToolsResponse>(path, { responseHeaders: upstream, signal: request.signal });
  return withHeaders(
    { data, filters: { channel, category, tag, sort, windowDays } },
    { headers: releaseBoundCache(data.refreshAt, 60, Date.now(), upstream) },
  );
}

export function meta({ loaderData }: Route.MetaArgs) {
  return pageMeta({
    title: withSubject("工具导航"),
    description: `近 ${loaderData?.filters.windowDays ?? 30} 天,AI 圈的工具/模型/平台发布,按 ${loaderData?.filters.sort === "score" ? "评分" : "时间"}排序。`,
    path: listPath("/tools", { channel: loaderData?.filters.channel, category: loaderData?.filters.category, tag: loaderData?.filters.tag, sort: loaderData?.filters.sort, windowDays: loaderData?.filters.windowDays }),
    image: "/og/pages/tools.png",
  });
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

/** "加载更多" pager: keeps the loader's first page and appends subsequent cursor pages. */
export function ClientMore({ nextCursor, filters, className }: { nextCursor: string | null; filters: { channel: ChannelKey; category: CategoryKey | null; tag: string | null; sort: string; windowDays: number }; className?: string }) {
  const [params, setParams] = useSearchParams();
  if (!nextCursor) return <p className={`text-center text-[12px] text-ink-4 ${className ?? ""}`}>已经到底了</p>;
  return (
    <div className={`flex justify-center ${className ?? ""}`}>
      <button
        type="button"
        onClick={() => setParams((p) => { const next = new URLSearchParams(p); next.set("cursor", nextCursor); return next; }, { replace: true })}
        className="h-9 rounded-full border border-line-strong bg-surface px-5 text-[13px] font-medium text-ink-2 transition-colors hover:border-ink-4 hover:text-ink"
      >
        加载更多
      </button>
    </div>
  );
}

export default function ToolsPage() {
  const { data, filters } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const sortHref = (s: string) => hrefWith("/tools", params, { sort: s, cursor: null });
  const windowHref = (w: number) => hrefWith("/tools", params, { windowDays: String(w), cursor: null });
  return (
    <div className="pb-6">
      <header className="pb-4 pt-5 lg:pt-1">
        <div className="flex items-end justify-between gap-x-6 gap-y-2">
          <div>
            <div className="flex items-center gap-2 text-[12px] font-semibold tracking-[0.08em] text-accent">
              <span className="relative flex size-2" aria-hidden="true">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-30" />
                <span className="relative inline-flex size-2 rounded-full bg-accent" />
              </span>
              {withSubject("工具导航")}
            </div>
            <h1 className="mt-1.5 text-[24px] font-bold leading-[1.3] tracking-[-0.01em] text-ink lg:text-[26px]">近 {filters.windowDays} 天 · AI 圈最值得看的 {data.items.length} 个{withSubject("新工具")}</h1>
            <p className="mt-1.5 text-[13.5px] text-ink-3">每条发布 = 一张工具卡 · 命中 "新工具 / 产品更新 / 模型发布 / 平台" 标签(itemType=tool_release)· 按{filters.sort === "score" ? "评分" : "时间"}排序</p>
          </div>
          {data.refreshAt && (
            <p className="hidden text-[12px] text-ink-4 lg:block">下一批入选时间 · <span className="num">{monthDayTime(data.refreshAt)}</span></p>
          )}
        </div>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <CategoryTabs base="/tools" category={filters.category} channel={filters.channel} layoutId="tools-cat" size="sm" />
        <PillTabs items={SORT_OPTIONS.map((o) => ({ key: o.key, label: o.label, to: sortHref(o.key) }))} active={filters.sort} layoutId="tools-sort" size="sm" label="排序" />
        <PillTabs items={WINDOW_OPTIONS.map((o) => ({ key: String(o.key), label: o.label, to: windowHref(o.key) }))} active={String(filters.windowDays)} layoutId="tools-window" size="sm" label="时间窗" />
        {filters.tag && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-bg-sunk px-3 py-1 text-[12.5px] text-ink-3">
            #<span>{filters.tag}</span>
            <a href={hrefWith("/tools", params, { tag: null })} className="text-ink-4 hover:text-ink" aria-label="清除标签">×</a>
          </span>
        )}
      </div>

      {data.items.length === 0 ? (
        <div className="card rounded-sheet">
          <EmptyState title="这个筛选下还没有入选的工具">换个类别,扩大时间窗,或去掉标签看看。</EmptyState>
        </div>
      ) : (
        <>
          <ToolGrid items={data.items} />
          <ClientMore nextCursor={data.nextCursor} filters={filters} className="mt-6" />
        </>
      )}
    </div>
  );
}