// /changelog — W4a tool/model/platform update aggregation (plan §2.1, /changelog path migrated
// from site release notes on 2026-10-01 to this tool-side feed). Backed by /api/site/changelog
// (publications WHERE tags && ['产品更新']), grouped by entity in the frontend using the tags array.
import { SITE, withSubject } from "@aihot/industry/site";
import { useMemo } from "react";
import { Link, useLoaderData } from "react-router";
import { apiGet } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { fullDateTime } from "../lib/format";
import { AsideCard, ReadingLayout } from "../components/ui/Page";
import { IconChevronRight, IconHistory } from "../components/icons";

interface ChangelogResponse {
  filters: { channel: string; category: string | null; tag: string | null };
  items: {
    id: string;
    title: string;
    summary: string | null;
    source: { name: string };
    publishedAt: string | null;
    timelineAt: string;
    category: string | null;
    tags: string[];
    score: number | null;
    selected: boolean;
    channel: "news" | "x";
  }[];
  nextCursor: string | null;
  refreshAt: string | null;
  windowDays: number;
  generatedAt: string;
}

/** Public caches share the same s-maxage as the source — 60s, capped to the next refresh deadline. */
export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=300" };
}

export async function loader({ request }: { request: Request }) {
  return apiGet<ChangelogResponse>("/api/site/changelog?windowDays=30&limit=60", { signal: request.signal });
}

export function meta() {
  return pageMeta({ title: "工具动态", description: `${SITE.name} 上 AI 工具 / 模型 / 平台最近的产品更新。`, path: "/changelog", image: "/og/pages/changelog.png" });
}

/** Pick a stable "entity" name from an item's tags. Strategy:
 *  - The first tag that is NOT one of the classifier/control tags ([产品更新, 新工具, 模型发布, 平台, 公告, 评测, 教程, ...]).
 *  - Falls back to source.name when no entity tag is present. */
const RESERVED_TAGS = new Set(["产品更新", "新工具", "模型发布", "平台"]);
function entityOf(tags: string[], sourceName: string): string {
  for (const t of tags) if (!RESERVED_TAGS.has(t)) return t;
  return sourceName;
}

export default function ChangelogPage() {
  const data = useLoaderData<typeof loader>();
  const groups = useMemo(() => {
    const m = new Map<string, ChangelogResponse["items"]>();
    for (const it of data.items) {
      const key = entityOf(it.tags, it.source.name);
      const list = m.get(key) ?? [];
      list.push(it);
      m.set(key, list);
    }
    return [...m.entries()].sort((a, b) => {
      // Newest item in the group decides order; ties broken by name length (short first).
      const aT = Math.max(...a[1].map((i) => Date.parse(i.timelineAt)));
      const bT = Math.max(...b[1].map((i) => Date.parse(i.timelineAt)));
      return bT - aT || a[0].length - b[0].length;
    });
  }, [data.items]);

  const total = data.items.length;

  const aside = (
    <>
      <AsideCard title="关于工具动态">
        <p className="text-[13px] leading-[1.75] text-ink-3">每个工具/模型/平台的最新发布、版本更新和能力变动。</p>
        <p className="mt-2 text-[12.5px] text-ink-4">默认展示最近 {data.windowDays} 天;按工具/模型名分组。</p>
      </AsideCard>
      <AsideCard title="想看全部动态?">
        <Link to="/all" prefetch="intent" className="inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">
          全部{withSubject("动态")} <IconChevronRight size={14} />
        </Link>
      </AsideCard>
      <AsideCard title="想看单个工具的更新?">
        <p className="text-[13px] leading-[1.75] text-ink-3">进工具详情页,「最近 7 天的更新」会持续追踪。</p>
        <Link to="/tools" prefetch="intent" className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">
          工具导航 <IconChevronRight size={14} />
        </Link>
      </AsideCard>
    </>
  );

  return (
    <ReadingLayout aside={aside}>
      <header className="pb-6">
        <h1 className="flex items-center gap-2 text-[24px] font-semibold leading-[1.3] text-ink">
          <IconHistory size={20} className="text-accent" aria-hidden="true" />
          工具动态
        </h1>
        <p className="mt-1.5 text-[13px] text-ink-3">
          最近 {data.windowDays} 天内 · 按工具/模型名分组 · 共 {total} 条更新
        </p>
      </header>
      {total === 0 ? (
        <div className="card flex flex-col items-center gap-3 px-6 py-12 text-center">
          <div className="text-[14px] font-medium text-ink-2">最近 {data.windowDays} 天暂无工具更新</div>
          <p className="text-[12.5px] text-ink-4">信源还在持续收录,先去 <Link to="/new" className="text-accent hover:underline">每日新品</Link> 看看吧。</p>
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map(([entity, items]) => (
            <ToolGroup key={entity} entity={entity} items={items} />
          ))}
        </div>
      )}
    </ReadingLayout>
  );
}

function ToolGroup({ entity, items }: { entity: string; items: ChangelogResponse["items"] }) {
  const newest = items[0]?.timelineAt ?? null;
  return (
    <section className="card scroll-mt-6 px-5 lg:px-7">
      <header className="flex items-baseline justify-between gap-3 border-b border-line-soft py-4">
        <h2 className="min-w-0 truncate text-[16px] font-bold text-ink">{entity}</h2>
        {newest && <time dateTime={newest} className="shrink-0 text-[12px] text-ink-4">{fullDateTime(newest)}</time>}
      </header>
      <ol>
        {items.map((it) => (
          <li key={it.id} className="grid gap-x-6 gap-y-1.5 border-b border-line-soft py-4 last:border-b-0 sm:grid-cols-[140px_minmax(0,1fr)]">
            <time dateTime={it.timelineAt} className="mono text-[12px] text-ink-3">{fullDateTime(it.timelineAt)}</time>
            <div className="min-w-0">
              <Link to={`/items/${it.id}`} prefetch="intent" className="line-clamp-2 text-[14px] font-medium leading-snug text-ink-2 hover:text-accent">
                {it.title}
              </Link>
              {it.summary && <p className="mt-1 line-clamp-2 text-[12.5px] leading-snug text-ink-4">{it.summary}</p>}
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-ink-4">
                <span>{it.source.name}</span>
                {it.tags.filter((t) => !RESERVED_TAGS.has(t) && t !== entity).slice(0, 3).map((t) => (
                  <span key={t} className="rounded bg-bg-sunk px-1.5 py-px text-[10.5px] text-ink-3 dark:bg-bg-muted/40">{t}</span>
                ))}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
