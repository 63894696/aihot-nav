// / — 精选时间线首页。W5-1:不再 301 到 /new,直接渲染 loadTimeline()(选中的全部 tool_release / tool_update /
// model_release / paper 等,按事件归组、按时间倒序),让 / 成为站点的最重 SEO 入口;/new 保留为"过去 24h 严格过滤的
// 每日新品"窄筛视图,两条路由互不替代。hotStrip 由后端只在无筛选时 side-load,首页天然命中。
import { data as withHeaders, useLoaderData } from "react-router";
import type { Route } from "./+types/home";
import type { TimelineResponse } from "@aihot/contracts/site";
import { withSubject } from "@aihot/industry/site";
import { loadOr404, releaseBoundCache } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { Timeline } from "../features/feed/Timeline";

/** / — loadTimeline() with default filters; let readers drill via /changelog / /tools etc. */
export async function loader({ request }: Route.LoaderArgs) {
  const upstream = new Headers();
  const data = await loadOr404<TimelineResponse>("/api/site/timeline?limit=20", { responseHeaders: upstream, signal: request.signal });
  return withHeaders({ data }, { headers: releaseBoundCache(data.refreshAt, 60, Date.now(), upstream) });
}

export function meta(_args: Route.MetaArgs) {
  return pageMeta({
    title: withSubject("精选"),
    description: "AI 圈每天值得看的精选动态:同一件事按事件归组、按时间倒序,带「另有 N 家信源报道」和「展开 N 条进展」。",
    path: "/",
    image: "/og/pages/home.png",
  });
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

export default function HomePage() {
  const { data } = useLoaderData<typeof loader>();
  return <Timeline initial={data} filters={data.filters} />;
}
