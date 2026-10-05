// /code-prompts — code-prompt template library. Code-gen scaffolding files (agent / instruction /
// skill markdown) collected from github.com/github/awesome-copilot and similar sources. Unlike the
// /prompts column, these aren't reusable one-shot prompts — they're project-level templates you
// drop into your repo's .github/ directory. The asset_kind is the natural filter facet.
//
// Wire shape: CopilotAssetSummary (kind + slug + filename + frontmatter + bodyPreview + rawUrl +
// fetchedAt) loaded from /api/site/awesome-copilot. Cursor pagination on fetched_at + id.
import { SITE } from "@aihot/industry/site";
import { COPILOT_ASSET_KINDS, COPILOT_ASSET_KIND_LABELS, type CopilotAssetKind, type CopilotAssetSummary, type CopilotAssetsResponse } from "@aihot/contracts/awesome-copilot";
import { Link, useLoaderData, useSearchParams } from "react-router";
import { apiGet } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { AsideCard, ReadingLayout } from "../components/ui/Page";
import { IconArrowRight, IconDoc } from "../components/icons";
import { CodePromptCard } from "../features/code-prompts/CodePromptCard";
import { CodePromptFilters } from "../features/code-prompts/CodePromptFilters";

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=300" };
}

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const params = new URLSearchParams();
  const rawKind = url.searchParams.get("kind");
  if (rawKind && (COPILOT_ASSET_KINDS as readonly string[]).includes(rawKind)) {
    params.set("kind", rawKind);
  }
  const limit = url.searchParams.get("limit") ?? "30";
  params.set("limit", limit);
  const qs = params.toString();
  const path = `/api/site/awesome-copilot${qs ? `?${qs}` : ""}`;
  return apiGet<CopilotAssetsResponse>(path, { signal: request.signal });
}

export function meta() {
  return pageMeta({
    title: "代码提示词",
    description: `${SITE.name} 整理的代码生成模板库 — Agent / Instruction / Skill,直接放入项目即可使用。`,
    path: "/code-prompts",
    image: "/og/pages/code-prompts.png",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: `${SITE.name} 代码提示词`,
      description: `${SITE.name} 整理的代码生成模板库。`,
    },
  });
}

export default function CodePromptsPage() {
  const data = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const items: CopilotAssetSummary[] = data.items ?? [];

  return (
    <ReadingLayout
      aside={
        <>
          <AsideCard title="关于本栏目">
            <p className="text-[12.5px] leading-[1.85] text-ink-3">
              从公开仓库整理的代码生成模板,按 Agent(智能体)/ Instruction(指令)/ Skill(技能) 三类归档。每个文件就是一份可直接放进项目 <code className="mono">.github/</code> 目录的 markdown。
            </p>
            <p className="mt-2 text-[12px] leading-[1.7] text-ink-4">
              这不是一次性提示词,而是给代码生成 agent 用的脚手架 — frontmatter 里写明模型 / 工具 / 触发词。
            </p>
          </AsideCard>

          <AsideCard title="使用注意">
            <ul className="space-y-1.5 text-[12.5px] text-ink-3">
              <li>· 点击"详情"查看完整正文与 frontmatter</li>
              <li>· 原始版权归原作者所有,使用前请看 LICENSE</li>
              <li>· 复制完整文件到本地,按需修改再投入生产</li>
            </ul>
          </AsideCard>
        </>
      }
    >
      <header className="mb-5">
        <h1 className="text-[22px] font-semibold leading-tight text-ink">代码提示词</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">
          Agent / Instruction / Skill 模板 · 共 {items.length} 条 · 按收录时间倒序
        </p>
      </header>

      <CodePromptFilters active={{ kind: data.filters.kind }} />

      {items.length === 0 ? (
        <EmptyState searchParams={searchParams} />
      ) : (
        <div className="space-y-4">
          {items.map((it) => (
            <CodePromptCard key={it.id} asset={it} />
          ))}
          <div className="flex items-center justify-between border-t border-line-soft pt-4 text-[12px] text-ink-4">
            <span>
              {data.nextCursor ? (
                <Link
                  to={`/code-prompts?${buildNextQuery(searchParams, data.nextCursor)}`}
                  className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
                  prefetch="intent"
                >
                  加载更早
                  <IconArrowRight size={12} />
                </Link>
              ) : (
                <span>已到最早一页</span>
              )}
            </span>
            <span>{data.refreshAt && <>下次刷新 · <span className="num">{new Date(data.refreshAt).toLocaleString("zh-CN")}</span></>}</span>
          </div>
        </div>
      )}
    </ReadingLayout>
  );
}

function EmptyState({ searchParams }: { searchParams: URLSearchParams }) {
  const filterActive = searchParams.has("kind");
  return (
    <div className="card flex flex-col items-center gap-2.5 px-6 py-14 text-center">
      <IconDoc size={28} className="text-ink-4" />
      <div className="text-[15px] font-semibold text-ink-2">
        {filterActive ? "当前类型暂无模板" : "代码提示词正在补足中"}
      </div>
      <p className="max-w-md text-[12.5px] leading-relaxed text-ink-4">
        {filterActive
          ? "可换一个类型试试。模板还在累积阶段,新条目按需补入。"
          : "模板来自 awesome-copilot 等公开仓库的同步抓取,首次同步需要几分钟时间。后续每 15 分钟增量刷新。"}
      </p>
    </div>
  );
}

function buildNextQuery(current: URLSearchParams, cursor: string): string {
  const next = new URLSearchParams(current);
  next.set("cursor", cursor);
  return next.toString();
}