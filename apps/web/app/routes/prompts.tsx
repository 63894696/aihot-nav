// /prompts — W5-3 prompt column. Visitors-facing list of reusable prompts collected from public
// posts, with original-page comments surfaced as user-feedback voices. Mirrors /papers's chip +
// window shape so the column feels consistent.
//
// Filter chips: 5 categories (writing / painting / study / research / design) + 7/30/90 day window.
// Cursor pagination on the captured_at + id axis; "加载更早" link keeps the loader's first page.
import { SITE } from "@aihot/industry/site";
import type { PromptsResponse, PromptCard } from "@aihot/contracts/site";
import { Link, useLoaderData, useSearchParams } from "react-router";
import { useMemo } from "react";
import { apiGet } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { AsideCard, ReadingLayout } from "../components/ui/Page";
import { IconArrowRight, IconDoc } from "../components/icons";
import { PromptCard as PromptCardView } from "../features/prompts/PromptCard";
import { PromptFilters } from "../features/prompts/PromptFilters";

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
  const qs = params.toString();
  const path = `/api/site/prompts${qs ? `?${qs}` : ""}`;
  const data = await apiGet<PromptsResponse>(path, { signal: request.signal });
  return data;
}

export function meta() {
  return pageMeta({
    title: "提示词合集",
    description: `${SITE.name} 整理的可复用提示词,带原始社区评论。`,
    path: "/prompts",
    image: "/og/pages/prompts.png",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: `${SITE.name} 提示词合集`,
      description: `${SITE.name} 整理的可复用提示词,带原始社区评论。`,
    },
  });
}

export default function PromptsPage() {
  const data = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const items: PromptCard[] = data.items ?? [];

  const refreshAt = data.refreshAt;

  return (
    <ReadingLayout
      aside={
        <>
          <AsideCard title="关于本栏目">
            <p className="text-[12.5px] leading-[1.85] text-ink-3">
              从公开社区(Reddit / HN / 微信 / 公众号等)抓可复用提示词,过滤掉"看个人 / 看一次性"的例子,留下可改写复用的版本。
            </p>
            <p className="mt-2 text-[12px] leading-[1.7] text-ink-4">
              每条提示词挂上原页评论作为用户反馈声音。请求频率与单源熔断已在前端 / 后端两侧限速,不会对原站造成压力。
            </p>
          </AsideCard>

          <AsideCard title="使用注意">
            <ul className="space-y-1.5 text-[12.5px] text-ink-3">
              <li>· 提示词原作者归属于原社区条目,本栏目仅整理</li>
              <li>· 点"详情"查看完整 promptText 与原页评论</li>
              <li>· 复制后请按自己的场景修改变量再使用</li>
            </ul>
          </AsideCard>

          {refreshAt && (
            <AsideCard title="下一次刷新">
              <p className="text-[12.5px] leading-[1.7] text-ink-3">预计更新一批后增量收录。</p>
            </AsideCard>
          )}
        </>
      }
    >
      <header className="mb-5">
        <h1 className="text-[22px] font-semibold leading-tight text-ink">提示词合集</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">
          可复用提示词 · 最近 {data.windowDays} 天 · 共 {items.length} 条
        </p>
      </header>

      <PromptFilters active={{ category: data.filters.category, windowDays: data.windowDays }} />

      {items.length === 0 ? (
        <EmptyState searchParams={searchParams} />
      ) : (
        <div className="space-y-4">
          {items.map((p) => (
            <PromptCardView key={p.id} prompt={p} />
          ))}
          <div className="flex items-center justify-between border-t border-line-soft pt-4 text-[12px] text-ink-4">
            <span>
              {data.nextCursor ? (
                <Link
                  to={`/prompts?${buildNextQuery(searchParams, data.nextCursor)}`}
                  className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
                  prefetch="intent"
                >
                  加载更早提示词
                  <IconArrowRight size={12} />
                </Link>
              ) : (
                <span>已到最早一页</span>
              )}
            </span>
            <span>{refreshAt && <>下次刷新 · <span className="num">{new Date(refreshAt).toLocaleString("zh-CN")}</span></>}</span>
          </div>
        </div>
      )}
    </ReadingLayout>
  );
}

function EmptyState({ searchParams }: { searchParams: URLSearchParams }) {
  const resetHref = `/prompts${searchParams.toString() ? `?${searchParams.toString()}` : ""}`;
  return (
    <div className="card flex flex-col items-center gap-2.5 px-6 py-14 text-center">
      <IconDoc size={28} className="text-ink-4" />
      <div className="text-[15px] font-semibold text-ink-2">当前筛选下暂无提示词</div>
      <p className="max-w-md text-[12.5px] leading-relaxed text-ink-4">
        可换一个类别或扩大时间窗试试。提示词还在累积阶段,新条目按需补入。
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