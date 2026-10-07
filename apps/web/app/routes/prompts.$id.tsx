// /prompts/:id — W5-3 prompt detail page. Full promptText (not truncated), useCase, original
// post link, and the original-page comments rendered as a quiet thread. No model call here —
// readers opening a card get cached prompt text + a short list of comments.
//
// FIX-AA.3 — adds the "反向发现" panel after 使用说明. Cross-axis join: prompt_id → paper_prompts
// → arxiv_id (relatedPapers) + arxiv_id → tool_papers → tools (relatedTools, 2-hop). Wire shape
// always carries both keys; UI hides the section when both lists are empty (Lesson 13c).
import { SITE } from "@aihot/industry/site";
import { PROMPT_CATEGORY_LABELS, type FeedItemSummary, type PaperSummary, type PromptDetail } from "@aihot/contracts/site";
import { Link, useLoaderData } from "react-router";
import type { Route } from "./+types/prompts.$id";
import { useState } from "react";
import { loadOr404 } from "../lib/api.server";
import { pageMeta, breadcrumbLd } from "../lib/seo";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { AsideCard, ArticleLayout } from "../components/ui/Page";
import { IconArrowLeft, IconArrowRight, IconCopy, IconExternal } from "../components/icons";
import { PaperSiblingCard } from "../features/papers/PaperSiblingCard";

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const data = await loadOr404<PromptDetail>(`/api/site/prompts/${encodeURIComponent(params.id)}`, { signal: request.signal });
  // FIX-AA.3 — fetch the cross-axis discover panel in parallel. Defensive parse: any shape drift
  // degrades to empty arrays (mirrors the Lesson 13c contract for /tools/:id discover). We never
  // throw here — losing the panel beats a 5xx on the detail page.
  const apiOrigin = new URL(request.url).origin;
  let relatedPapers: RelatedPapersForView = [];
  let relatedTools: RelatedToolsForView = [];
  try {
    const res = await fetch(`${apiOrigin}/api/site/prompt/${encodeURIComponent(params.id)}/discover`, { signal: request.signal });
    if (res.ok) {
      const body = await res.json() as { relatedPapers?: unknown; relatedTools?: unknown };
      relatedPapers = Array.isArray(body.relatedPapers) ? body.relatedPapers as RelatedPapersForView : [];
      relatedTools = Array.isArray(body.relatedTools) ? body.relatedTools as RelatedToolsForView : [];
    }
  } catch {
    // Swallow — same defensive pattern as /tools/:id discover loader.
  }
  return { ...data, relatedPapers, relatedTools };
}

// FIX-AA.3 — narrow the relatedPapers/relatedTools shapes for the SSR view. The api's discover
// response always carries both as arrays, but a future backend shape drift must not crash the page
// — narrow only enough for what the UI renders.
type RelatedPapersForView = PaperSummary[];
type RelatedToolsForView = FeedItemSummary[];

export function meta({ loaderData }: Route.MetaArgs) {
  const data = loaderData as PromptDetail | undefined;
  if (!data) return pageMeta({ title: "提示词", path: "/prompts", noindex: true });
  const description = (data.useCase ?? data.promptPreview).slice(0, 200);
  return pageMeta({
    title: data.useCase ?? "提示词详情",
    description,
    path: `/prompts/${data.id}`,
    image: `/og/prompts/${data.id}.png`,
    rawTitle: true,
    type: "article",
    jsonLd: [
      breadcrumbLd([
        { name: SITE.name, path: "/" },
        { name: "通用提示词", path: "/prompts" },
        { name: data.useCase ?? `提示词 #${data.id}`, path: `/prompts/${data.id}` },
      ]),
      {
        "@context": "https://schema.org",
        "@type": "CreativeWork",
        headline: data.useCase ?? "未命名提示词",
        inLanguage: data.language,
        datePublished: data.capturedAt,
        publisher: { "@type": "Organization", name: SITE.name },
        url: data.originalUrl,
        keywords: [data.category, data.community].join(","),
      },
    ],
  });
}

const CATEGORY_LABEL: Record<string, string> = PROMPT_CATEGORY_LABELS;

export default function PromptDetailPage() {
  const d = useLoaderData<typeof loader>();
  const [copiedText, setCopiedText] = useState(false);

  async function copyPromptText() {
    try {
      await navigator.clipboard.writeText(d.promptText);
      setCopiedText(true);
      setTimeout(() => setCopiedText(false), 1200);
    } catch {
      // Clipboard blocked: ignore silently.
    }
  }

  const catLabel = CATEGORY_LABEL[d.category] ?? d.category;

  return (
    <ArticleLayout
      left={
        <>
          <AsideCard title="条目信息">
            <dl className="space-y-2 text-[12.5px] text-ink-3">
              <div className="flex justify-between gap-2">
                <dt className="text-ink-4">类别</dt>
                <dd>
                  <Link to={`/prompts?category=${encodeURIComponent(d.category)}`} className="text-accent hover:underline">
                    {catLabel}
                  </Link>
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-ink-4">社区</dt>
                <dd>{d.community}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-ink-4">语言</dt>
                <dd className="mono">{d.language}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-ink-4">来源类型</dt>
                <dd>{d.sourceKind}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-ink-4">收录时间</dt>
                <dd>
                  <time dateTime={d.capturedAt}>
                    {beijingDate(d.capturedAt)}
                    <span className="ml-1 mono text-[11.5px]">{beijingTime(d.capturedAt)}</span>
                  </time>
                </dd>
              </div>
            </dl>
          </AsideCard>

          <AsideCard title="原文链接">
            <ul className="space-y-2 text-[12.5px]">
              <li>
                <a href={d.originalUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                  <IconExternal size={12} /> 原始帖子
                </a>
              </li>
              <li>
                <Link to="/prompts" className="inline-flex items-center gap-1 text-ink-3 hover:text-accent">
                  返回提示词列表
                </Link>
              </li>
            </ul>
          </AsideCard>
        </>
      }
    >
      <header className="mb-6">
        <Link to="/prompts" className="mb-3 inline-flex items-center gap-1 text-[12.5px] font-medium text-accent hover:underline">
          <IconArrowLeft size={13} /> 返回提示词列表
        </Link>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
          <Link
            to={`/prompts?category=${encodeURIComponent(d.category)}`}
            className="rounded bg-accent/10 px-1.5 py-px font-medium text-accent hover:underline"
          >
            {catLabel}
          </Link>
          <span className="text-ink-4">
            {d.community} · 收录于 <time dateTime={d.capturedAt}>{beijingDate(d.capturedAt)}</time>
          </span>
        </div>
        <h1 className="mt-3 text-[24px] font-semibold leading-[1.4] text-ink">
          {d.useCase ?? "未命名提示词"}
        </h1>
      </header>

      <section className="card scroll-mt-6 px-5 py-5 lg:px-7 lg:py-6">
        <div className="flex items-center justify-between">
          <h2 className="text-[14px] font-semibold text-ink">完整提示词</h2>
          <button
            type="button"
            onClick={copyPromptText}
            className="inline-flex items-center gap-1 text-[12px] text-accent hover:underline"
          >
            <IconCopy size={12} /> {copiedText ? "已复制" : "复制全文"}
          </button>
        </div>
        <p className="mt-3 whitespace-pre-wrap text-[13.5px] leading-[1.85] text-ink-2">
          {d.promptText}
        </p>
      </section>

      <section className="card mt-4 scroll-mt-6 px-5 py-5 lg:px-7 lg:py-6">
        <h2 className="text-[14px] font-semibold text-ink">使用说明</h2>
        <p className="mt-3 text-[13px] leading-[1.8] text-ink-3">
          复制全文后,按自己的场景替换占位变量(方括号 / 双花括号包裹的字段)再使用。
          部分提示词依赖特定模型或工具(如 GPT / Claude / Copilot),请根据实际情况调整。
        </p>
      </section>

      {/* FIX-AA.3 — reverse-discovery panel. Hides entirely when both lists are empty so the
          reader does not see an empty "反向发现" box (mirrors /tools/:id convention). Each list
          gets its own sub-h3 so a single populated block doesn't look like it owns the whole panel. */}
      {d.relatedPapers.length > 0 || d.relatedTools.length > 0 ? (
        <section className="card mt-4 scroll-mt-6 px-5 py-5 lg:px-7 lg:py-6">
          <header className="mb-3 flex items-center justify-between">
            <h2 className="text-[14px] font-semibold text-ink">反向发现</h2>
            <span className="text-[11.5px] text-ink-4">这个提示词用过的相关论文与工具</span>
          </header>
          {d.relatedPapers.length > 0 ? (
            <>
              <h3 className="mb-2 text-[12px] font-medium text-ink-3">相关论文</h3>
              <ul className="grid gap-2 sm:grid-cols-2">
                {d.relatedPapers.slice(0, 6).map((p) => (
                  <li key={p.id}>
                    <PaperSiblingCard
                      paper={{
                        id: p.id,
                        titleZh: p.titleZh,
                        titleEn: p.titleEn,
                        primaryCategory: p.primaryCategory,
                        publishedAt: p.publishedAt,
                        status: p.status,
                      }}
                    />
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {d.relatedTools.length > 0 ? (
            <div className={d.relatedPapers.length > 0 ? "mt-4" : ""}>
              <h3 className="mb-2 text-[12px] font-medium text-ink-3">相关工具</h3>
              <ul className="grid gap-2 sm:grid-cols-2">
                {d.relatedTools.slice(0, 6).map((t) => (
                  <li key={t.id}>
                    <Link
                      to={`/tools/${encodeURIComponent(t.id)}`}
                      prefetch="intent"
                      className="card flex h-full flex-col gap-1.5 px-4 py-3.5 transition hover:border-accent/40 hover:shadow-sm"
                    >
                      <div className="flex items-center gap-1.5 text-[11px]">
                        {t.category ? (
                          <span className="rounded bg-accent/10 px-1.5 py-px font-medium text-accent">{t.category}</span>
                        ) : null}
                        {t.channel ? (
                          <span className="rounded bg-bg-muted px-1.5 py-px text-ink-4">{t.channel}</span>
                        ) : null}
                      </div>
                      <div className="text-[13px] font-semibold leading-[1.4] text-ink-2 line-clamp-2">{t.title}</div>
                      {t.summary ? (
                        <div className="text-[12px] leading-[1.6] text-ink-4 line-clamp-2">{t.summary}</div>
                      ) : null}
                      <div className="mt-1 inline-flex items-center gap-1 text-[11.5px] text-accent">
                        查看工具 <IconArrowRight size={11} />
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}
    </ArticleLayout>
  );
}