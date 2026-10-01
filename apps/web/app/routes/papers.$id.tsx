// /papers/:id — paper detail page (W4b plan §3.3). Full key_points expanded, full author list,
// arXiv abs / PDF / abs mirror three links. BreadcrumbList + ScholarlyArticle JSON-LD so the
// detail page also shows up as a research-paper rich result when shared.
import { SITE } from "@aihot/industry/site";
import type { PaperDetail } from "@aihot/contracts/site";
import { Link, useLoaderData } from "react-router";
import { useState } from "react";
import { apiGet, loadOr404 } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { breadcrumbLd } from "../lib/seo";
import { beijingDate } from "@aihot/contracts/time";
import { AsideCard, ArticleLayout } from "../components/ui/Page";
import { IconArrowLeft, IconCopy, IconExternal } from "../components/icons";

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

export async function loader({ request, params }: { request: Request; params: { id: string } }) {
  return loadOr404<PaperDetail>(`/api/site/papers/${encodeURIComponent(params.id)}`, { signal: request.signal });
}

export function meta({ data }: { data?: PaperDetail }) {
  if (!data) return pageMeta({ title: "论文", path: "/papers", noindex: true });
  const title = data.titleZh ?? data.titleEn;
  const description = (data.abstractZh ?? data.abstractEn).slice(0, 200);
  return pageMeta({
    title,
    description,
    path: `/papers/${data.id}`,
    image: `/og/papers/${data.id}.png`,
    rawTitle: true,
    type: "article",
    jsonLd: [
      breadcrumbLd([
        { name: SITE.name, path: "/" },
        { name: "论文解读", path: "/papers" },
        { name: title, path: `/papers/${data.id}` },
      ]),
      {
        "@context": "https://schema.org",
        "@type": "ScholarlyArticle",
        headline: title,
        alternativeHeadline: data.titleZh && data.titleEn !== data.titleZh ? data.titleEn : undefined,
        datePublished: data.publishedAt,
        dateModified: data.translatedAt ?? data.publishedAt,
        inLanguage: data.abstractZh ? "zh-Hans" : "en",
        author: data.authors.map((name) => ({ "@type": "Person", name })),
        publisher: { "@type": "Organization", name: SITE.name },
        url: data.absUrl,
        sameAs: [data.absUrl, data.pdfUrl],
        keywords: [data.primaryCategory].join(", "),
      },
    ],
  });
}

export default function PaperDetailPage() {
  const d = useLoaderData<typeof loader>();
  const [copiedId, setCopiedId] = useState(false);
  const [copiedText, setCopiedText] = useState(false);

  async function copy(value: string, which: "id" | "abstract") {
    try {
      await navigator.clipboard.writeText(value);
      if (which === "id") setCopiedId(true);
      else setCopiedText(true);
      setTimeout(() => {
        if (which === "id") setCopiedId(false);
        else setCopiedText(false);
      }, 1200);
    } catch {
      // Clipboard blocked: ignore silently.
    }
  }

  const displayTitle = d.titleZh ?? d.titleEn;
  const secondaryTitle = d.titleZh && d.titleZh !== d.titleEn ? d.titleEn : null;
  const abstract = d.abstractZh ?? d.abstractEnFull;
  const hasTranslation = !!d.abstractZh;
  const absSnippet = (d.abstractZh ?? d.abstractEnFull).slice(0, 200);

  return (
    <ArticleLayout
      left={
        <>
          <AsideCard title="论文信息">
            <dl className="space-y-2 text-[12.5px] text-ink-3">
              <div className="flex justify-between gap-2">
                <dt className="text-ink-4">类别</dt>
                <dd>
                  <Link to={`/papers?category=${encodeURIComponent(d.primaryCategory)}`} className="text-accent hover:underline">
                    {d.primaryCategory}
                  </Link>
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-ink-4">arXiv ID</dt>
                <dd>
                  <button
                    type="button"
                    onClick={() => copy(d.id, "id")}
                    className="mono inline-flex items-center gap-1 text-ink-2 hover:text-accent"
                  >
                    <IconCopy size={12} /> {copiedId ? "已复制" : d.id}
                  </button>
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-ink-4">提交日期</dt>
                <dd>
                  <time dateTime={d.publishedAt}>{beijingDate(d.publishedAt)}</time>
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-ink-4">抓取时间</dt>
                <dd>{beijingDate(d.fetchedAt)}</dd>
              </div>
              {d.translatedAt && (
                <div className="flex justify-between gap-2">
                  <dt className="text-ink-4">翻译时间</dt>
                  <dd>{beijingDate(d.translatedAt)}</dd>
                </div>
              )}
              {d.summaryModel && (
                <div className="flex justify-between gap-2">
                  <dt className="text-ink-4">翻译模型</dt>
                  <dd className="mono truncate text-[11.5px]">{d.summaryModel}</dd>
                </div>
              )}
            </dl>
          </AsideCard>

          <AsideCard title="原文链接">
            <ul className="space-y-2 text-[12.5px]">
              <li>
                <a href={d.absUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                  <IconExternal size={12} /> arXiv 摘要页
                </a>
              </li>
              <li>
                <a href={d.pdfUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                  <IconExternal size={12} /> PDF
                </a>
              </li>
              <li>
                <a
                  href={`https://arxiv.org/abs/${d.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-ink-3 hover:text-accent"
                >
                  <IconExternal size={12} /> arxiv.org 镜像
                </a>
              </li>
            </ul>
          </AsideCard>
        </>
      }
    >
      <header className="mb-6">
        <Link to="/papers" className="mb-3 inline-flex items-center gap-1 text-[12.5px] font-medium text-accent hover:underline">
          <IconArrowLeft size={13} /> 返回论文列表
        </Link>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
          <span className="rounded bg-accent/10 px-1.5 py-px font-medium text-accent">{d.primaryCategory}</span>
          <span className="text-ink-4">
            提交于 <time dateTime={d.publishedAt}>{beijingDate(d.publishedAt)}</time>
          </span>
          <span className={`rounded px-1.5 py-px text-[11px] ${statusTone(d.status)}`}>{statusLabel(d.status)}</span>
        </div>
        <h1 className="mt-3 text-[24px] font-semibold leading-[1.4] text-ink">{displayTitle}</h1>
        {secondaryTitle && <p className="mt-2 text-[13px] italic leading-snug text-ink-4">{secondaryTitle}</p>}
        <p className="mt-3 text-[12.5px] leading-[1.85] text-ink-3">
          {d.authors.join(" · ")}
        </p>
      </header>

      <section className="card scroll-mt-6 px-5 py-5 lg:px-7 lg:py-6">
        <h2 className="text-[14px] font-semibold text-ink">{hasTranslation ? "中文摘要" : "英文摘要"}</h2>
        <p className={`mt-3 text-[13.5px] leading-[1.85] ${hasTranslation ? "text-ink-2" : "text-ink-3"}`}>
          {abstract}
        </p>
        <button
          type="button"
          onClick={() => copy(absSnippet, "abstract")}
          className="mt-3 inline-flex items-center gap-1 text-[12px] text-accent hover:underline"
        >
          <IconCopy size={12} /> {copiedText ? "摘要已复制" : "复制摘要片段"}
        </button>
      </section>

      <section className="card mt-4 scroll-mt-6 px-5 py-5 lg:px-7 lg:py-6">
        <h2 className="text-[14px] font-semibold text-ink">关键要点</h2>
        {d.keyPoints.length === 0 ? (
          <p className="mt-3 text-[13px] text-ink-4">关键要点尚未生成。翻译任务通常在抓取后 5-15 分钟内补全,可稍后刷新本页。</p>
        ) : (
          <ol className="mt-3 space-y-2.5 text-[13.5px] leading-[1.8] text-ink-2">
            {d.keyPoints.map((k, i) => (
              <li key={i} className="flex gap-2.5">
                <span className="mono shrink-0 text-[12px] font-semibold text-accent">{String(i + 1).padStart(2, "0")}</span>
                <span>{k}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {d.abstractEnFull && d.abstractZhFull && d.abstractEnFull !== d.abstractZhFull && (
        <section className="card mt-4 scroll-mt-6 px-5 py-5 lg:px-7 lg:py-6">
          <details>
            <summary className="cursor-pointer text-[14px] font-semibold text-ink hover:text-accent">原始英文摘要</summary>
            <p className="mt-3 text-[13px] leading-[1.85] text-ink-3">{d.abstractEnFull}</p>
          </details>
        </section>
      )}
    </ArticleLayout>
  );
}

function statusLabel(s: PaperDetail["status"]): string {
  switch (s) {
    case "translated":
      return "已译";
    case "partial":
      return "部分";
    case "translating":
      return "翻译中";
    case "failed":
      return "翻译失败";
    default:
      return "已收录";
  }
}

function statusTone(s: PaperDetail["status"]): string {
  switch (s) {
    case "translated":
      return "text-ok bg-ok/10";
    case "partial":
      return "text-amber bg-amber/10";
    default:
      return "text-ink-4 bg-bg-muted";
  }
}