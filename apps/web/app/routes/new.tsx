import { data as withHeaders, useLoaderData } from "react-router";
import type { Route } from "./+types/new";
import type { DailyResponse } from "@aihot/contracts/site";
import { withSubject } from "@aihot/industry/site";
import { loadOr404, releaseBoundCache } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { monthDayTime } from "../lib/format";
import { NewList } from "../features/feed/NewList";
import { EmptyState } from "../components/ui/Page";

/** /new — the navigation layer's homepage. Top tool_release items in the last sinceHours (default 24h). */
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const since = Math.min(Math.max(Number(url.searchParams.get("since")) || 24, 1), 168);
  const minScore = Math.min(Math.max(Number(url.searchParams.get("minScore")) || 70, 0), 100);
  const upstream = new Headers();
  const data = await loadOr404<DailyResponse>(`/api/site/daily?since=${since}&minScore=${minScore}`, { responseHeaders: upstream, signal: request.signal });
  return withHeaders({ data, since, minScore }, { headers: releaseBoundCache(data.refreshAt, 60, Date.now(), upstream) });
}

export function meta({ loaderData }: Route.MetaArgs) {
  return pageMeta({
    title: withSubject("每日新品"),
    description: `过去 ${loaderData?.since ?? 24} 小时,AI 圈评分 ≥ ${loaderData?.minScore ?? 70} 的新工具/模型/平台发布,按热度排序。`,
    path: "/new",
    image: "/og/pages/new.png",
  });
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

export default function NewPage() {
  const { data, since, minScore } = useLoaderData<typeof loader>();
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
              每日新品
            </div>
            <h1 className="mt-1.5 text-[24px] font-bold leading-[1.3] tracking-[-0.01em] text-ink lg:text-[26px]">过去 {since} 小时,AI 圈最值得看的 {data.items.length} 件新品</h1>
            <p className="mt-1.5 text-[13.5px] text-ink-3">评分 ≥ {minScore} · 按 score 与发布时间排序 · 命中 "新工具" 标签(itemType=tool_release)</p>
          </div>
          {data.refreshAt && (
            <p className="hidden text-[12px] text-ink-4 lg:block">下一批入选时间 · <span className="num">{monthDayTime(data.refreshAt)}</span></p>
          )}
        </div>
      </header>

      {data.items.length === 0 ? (
        <div className="card rounded-sheet">
          <EmptyState title={`过去 ${since} 小时还没有新品入选`}>
            评分门槛 {minScore} 偏高,或信源采集暂未跑出新的 tool_release 条目。可以稍后再来,或在顶部导航看其它频道。
          </EmptyState>
        </div>
      ) : (
        <NewList items={data.items} />
      )}
    </div>
  );
}