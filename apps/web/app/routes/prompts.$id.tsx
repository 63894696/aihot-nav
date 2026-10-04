// /prompts/:id — W5-3 prompt detail page. Full promptText (not truncated), useCase, original
// post link, and the original-page comments rendered as a quiet thread. No model call here —
// readers opening a card get cached prompt text + a short list of comments.
import { SITE } from "@aihot/industry/site";
import { PROMPT_CATEGORY_LABELS, type PromptDetail } from "@aihot/contracts/site";
import { Link, useLoaderData } from "react-router";
import type { Route } from "./+types/prompts.$id";
import { useState } from "react";
import { loadOr404 } from "../lib/api.server";
import { pageMeta, breadcrumbLd } from "../lib/seo";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { AsideCard, ArticleLayout } from "../components/ui/Page";
import { IconArrowLeft, IconCopy, IconExternal } from "../components/icons";

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

export async function loader({ request, params }: Route.LoaderArgs) {
  return loadOr404<PromptDetail>(`/api/site/prompts/${encodeURIComponent(params.id)}`, { signal: request.signal });
}

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
        { name: "提示词合集", path: "/prompts" },
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

const FETCH_STATUS_LABEL: Record<PromptDetail["commentFetchStatus"], string> = {
  ok: "评论已收录",
  failed: "评论抓取失败",
  timeout: "评论抓取超时",
};

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
  const sortedComments = [...d.comments].sort((a, b) => {
    if (a.postedAt && b.postedAt) return a.postedAt.localeCompare(b.postedAt);
    if (a.postedAt) return -1;
    if (b.postedAt) return 1;
    return 0;
  });

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
        <div className="flex items-center justify-between">
          <h2 className="text-[14px] font-semibold text-ink">原页评论</h2>
          <span className="text-[11.5px] text-ink-4">{FETCH_STATUS_LABEL[d.commentFetchStatus]}</span>
        </div>
        {sortedComments.length === 0 ? (
          <p className="mt-3 text-[13px] text-ink-4">
            {d.commentFetchStatus === "ok"
              ? "原帖暂无评论。"
              : "本次未能拉取原帖评论 — 可能是限流 / 超时,稍后会再试。"}
          </p>
        ) : (
          <ol className="mt-3 space-y-3.5 text-[13px] leading-[1.8] text-ink-2">
            {sortedComments.map((c) => (
              <li key={c.id} className="border-l-2 border-line-soft pl-3">
                <div className="text-[11.5px] text-ink-4">
                  {c.authorName ?? "匿名"} ·{" "}
                  {c.postedAt ? <time dateTime={c.postedAt}>{beijingDate(c.postedAt)}</time> : "时间未知"}
                </div>
                <p className="mt-1 whitespace-pre-wrap">{c.body}</p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </ArticleLayout>
  );
}