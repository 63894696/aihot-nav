// /papers/:id — paper detail page (W4b plan §3.3). Full key_points expanded, full author list,
// arXiv abs / PDF / abs mirror three links. BreadcrumbList + ScholarlyArticle JSON-LD so the
// detail page also shows up as a research-paper rich result when shared.
//
// W5-3 v0.2.1-#4 — adds a "相关论文" row at the bottom showing up to 6 sibling papers in the same
// arXiv primary_category. Today there is no tool_papers / prompt_papers join table, so this is
// strictly same-category siblings — that is the only structured cross-paper link we have. The
// endpoint stays parallel to the detail (GET /api/site/papers/:id/siblings) so #5 can extend it
// without breaking callers.
import { SITE } from "@aihot/industry/site";
import type { FeedItemSummary, PaperDetail, PaperCommentarySource, PaperSummary, PromptCard as PromptCardType } from "@aihot/contracts/site";
import { Link, useLoaderData } from "react-router";
import type { Route } from "./+types/papers.$id";
import { useState } from "react";
import { apiGet, loadOr404 } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { breadcrumbLd } from "../lib/seo";
import { beijingDate } from "@aihot/contracts/time";
import { AsideCard, ArticleLayout } from "../components/ui/Page";
import { IconArrowLeft, IconCopy, IconExternal } from "../components/icons";
import { PaperSiblingCard } from "../features/papers/PaperSiblingCard";
import { FeedItem } from "../features/feed/FeedItem";
import { PromptCard } from "../features/prompts/PromptCard";

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const detail = await loadOr404<PaperDetail>(`/api/site/papers/${encodeURIComponent(params.id)}`, { signal: request.signal });
  // Siblings are best-effort: a failure here must not 500 the page. The row hides itself when
  // the array is empty (no other paper in the category yet, or the paper itself is the only one
  // in its bucket). We surface a real 404 only when the parent detail is missing — `loadOr404`
  // already does that for /api/site/papers/:id.
  let siblings: PaperSummary[] = [];
  try {
    const r = await apiGet<{ items: PaperSummary[] }>(`/api/site/papers/${encodeURIComponent(params.id)}/siblings`, { signal: request.signal });
    siblings = Array.isArray(r.items) ? r.items : [];
  } catch {
    // Degrade silently — the parent page still renders.
  }
  // FIX-AA-B — reverse discovery. Parallel to siblings; best-effort (the backend wraps each
  // block in try/catch and returns [] on failure). Both lists may be [] — the UI hides the
  // section entirely when both are empty.
  let relatedTools: FeedItemSummary[] = [];
  let relatedPrompts: PromptCardType[] = [];
  try {
    const r = await apiGet<{ relatedTools: FeedItemSummary[]; relatedPrompts: PromptCardType[] }>(
      `/api/site/papers/${encodeURIComponent(params.id)}/discover`,
      { signal: request.signal },
    );
    relatedTools = Array.isArray(r.relatedTools) ? r.relatedTools : [];
    relatedPrompts = Array.isArray(r.relatedPrompts) ? r.relatedPrompts : [];
  } catch {
    // Degrade silently — the parent page still renders.
  }
  return { detail, siblings, relatedTools, relatedPrompts };
}

export function meta({ loaderData }: Route.MetaArgs) {
  const detail = loaderData?.detail as PaperDetail | undefined;
  if (!detail) return pageMeta({ title: "论文", path: "/papers", noindex: true });
  const title = detail.titleZh ?? detail.titleEn;
  const description = (detail.abstractZh ?? detail.abstractEn).slice(0, 200);
  return pageMeta({
    title,
    description,
    path: `/papers/${detail.id}`,
    image: `/og/papers/${detail.id}.png`,
    rawTitle: true,
    type: "article",
    jsonLd: [
      breadcrumbLd([
        { name: SITE.name, path: "/" },
        { name: "论文解读", path: "/papers" },
        { name: title, path: `/papers/${detail.id}` },
      ]),
      {
        "@context": "https://schema.org",
        "@type": "ScholarlyArticle",
        headline: title,
        alternativeHeadline: detail.titleZh && detail.titleEn !== detail.titleZh ? detail.titleEn : undefined,
        datePublished: detail.publishedAt,
        dateModified: detail.translatedAt ?? detail.publishedAt,
        inLanguage: detail.abstractZh ? "zh-Hans" : "en",
        author: detail.authors.map((name) => ({ "@type": "Person", name })),
        publisher: { "@type": "Organization", name: SITE.name },
        url: detail.absUrl,
        sameAs: [detail.absUrl, detail.pdfUrl],
        keywords: [detail.primaryCategory].join(", "),
      },
    ],
  });
}

export default function PaperDetailPage() {
  const { detail: d, siblings, relatedTools, relatedPrompts } = useLoaderData<typeof loader>();
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

      <CommentarySection d={d} />

      {d.abstractEnFull && d.abstractZhFull && d.abstractEnFull !== d.abstractZhFull && (
        <section className="card mt-4 scroll-mt-6 px-5 py-5 lg:px-7 lg:py-6">
          <details>
            <summary className="cursor-pointer text-[14px] font-semibold text-ink hover:text-accent">原始英文摘要</summary>
            <p className="mt-3 text-[13px] leading-[1.85] text-ink-3">{d.abstractEnFull}</p>
          </details>
        </section>
      )}

      {siblings.length > 0 && (
        <section className="mt-6">
          <header className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="text-[14px] font-semibold text-ink">同方向论文 · {d.primaryCategory}</h2>
            <Link
              to={`/papers?category=${encodeURIComponent(d.primaryCategory)}`}
              className="text-[12px] text-accent hover:underline"
            >
              查看全部 →
            </Link>
          </header>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {siblings.map((p) => (
              <PaperSiblingCard
                key={p.id}
                paper={{
                  id: p.id,
                  titleZh: p.titleZh,
                  titleEn: p.titleEn,
                  primaryCategory: p.primaryCategory,
                  publishedAt: p.publishedAt,
                  status: (p.status as "translated" | "partial" | "translating" | "failed" | "fetched") ?? "fetched",
                }}
              />
            ))}
          </div>
        </section>
      )}

      {/* FIX-AA-B — 反向发现 (related discovery). Section is hidden entirely when both lists
          are empty (defensive — UI convention). Each block follows the page's reading-layout
          language: a header row with a section title, then a grid of cards. linkPrefix="/tools"
          on FeedItem keeps the related-tool card clicking through to /tools/:id (catalog rails)
          instead of /items/:id (the default for the standalone reading view). */}
      {(relatedTools.length > 0 || relatedPrompts.length > 0) && (
        <section className="mt-6">
          <header className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="text-[14px] font-semibold text-ink">反向发现 · 这篇论文相关的工具与提示词</h2>
            <Link to="/all" className="text-[12px] text-accent hover:underline">
              去交叉发现 →
            </Link>
          </header>

          {relatedTools.length > 0 && (
            <div className="mb-4">
              <h3 className="mb-2 text-[12.5px] font-medium text-ink-3">关联工具 · {relatedTools.length}</h3>
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {relatedTools.map((t) => (
                  <FeedItem key={t.id} item={t} linkPrefix={"/tools" as `/tools/${string}`} />
                ))}
              </div>
            </div>
          )}

          {relatedPrompts.length > 0 && (
            <div>
              <h3 className="mb-2 text-[12.5px] font-medium text-ink-3">关联提示词 · {relatedPrompts.length}</h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {relatedPrompts.map((p) => (
                  <PromptCard key={p.id} prompt={p} />
                ))}
              </div>
            </div>
          )}
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

const COMMENTARY_SOURCE_LABEL: Record<PaperCommentarySource, string> = {
  chatgpt: "ChatGPT",
  perplexity: "Perplexity",
  human: "纯人工",
  hybrid: "人机协作",
};

/** Link to the raw commentary markdown in the public repo. Hard-coded to keep the
 *  front-end independent of `industry/site.ts` (which doesn't expose a repoPath field).
 *  The .md path is repo-relative — papers.commentary_md_url starts with "docs/commentary/"
 *  so we just concatenate. If we ever mirror to a non-babelspan fork, this is the only
 *  line that needs to change. */
const COMMENTARY_REPO_OWNER = "babelspan";
const COMMENTARY_REPO_NAME = "aihot-nav";
const COMMENTARY_REPO_BRANCH = "main";
function COMMENTARY_GITHUB_URL(mdPath: string): string {
  return `https://github.com/${COMMENTARY_REPO_OWNER}/${COMMENTARY_REPO_NAME}/blob/${COMMENTARY_REPO_BRANCH}/${mdPath}`;
}

function commentarySubhead(source: PaperCommentarySource | null): string {
  if (!source) return "解读";
  return `解读 · 来源: ${COMMENTARY_SOURCE_LABEL[source]}`;
}

/** 3-state renderer for the "解读" section. The publication layer only populates
 *  commentaryHtml when commentaryStatus === "published", so a missing field means we
 *  are in the pending / null branch — render the placeholder, not the section header
 *  twice. Skipped papers get a one-line audit-trail note so readers know the section
 *  was intentionally opted out (vs. just not yet authored). */
function CommentarySection({ d }: { d: PaperDetail }) {
  // pending / null — not yet attempted. Keep the heading visible so readers know the
  // section exists, but show the "尚无解读" placeholder.
  if (d.commentaryStatus !== "published" && d.commentaryStatus !== "skipped") {
    return (
      <section className="card mt-4 scroll-mt-6 px-5 py-5 lg:px-7 lg:py-6">
        <h2 className="text-[14px] font-semibold text-ink">解读</h2>
        <p className="mt-3 text-[13px] leading-[1.85] text-ink-4">尚无解读。</p>
      </section>
    );
  }

  // skipped — explicit opt-out. One-line grey note, no heading soup.
  if (d.commentaryStatus === "skipped") {
    return (
      <section className="card mt-4 scroll-mt-6 px-5 py-5 lg:px-7 lg:py-6">
        <h2 className="text-[14px] font-semibold text-ink">解读</h2>
        <p className="mt-3 text-[12.5px] leading-[1.8] text-ink-4">
          本篇暂无解读 — {d.commentarySkippedReason || "创作技巧不适配。"}
        </p>
      </section>
    );
  }

  // published — render the pre-sanitised HTML from the publication layer. The source
  // label sits in a small subhead under the section title.
  const html = d.commentaryHtml?.html ?? "";
  const empty = d.commentaryHtml?.empty ?? true;

  return (
    <section className="card mt-4 scroll-mt-6 px-5 py-5 lg:px-7 lg:py-6">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-[14px] font-semibold text-ink">{commentarySubhead(d.commentarySource)}</h2>
        {d.commentaryMdUrl && (
          <a
            href={COMMENTARY_GITHUB_URL(d.commentaryMdUrl)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11.5px] text-ink-4 hover:text-accent"
          >
            <IconExternal size={11} /> 在 GitHub 查看
          </a>
        )}
      </header>
      {empty ? (
        <p className="mt-3 text-[13px] leading-[1.85] text-ink-4">
          解读草稿已被标记为已发布,但仓库内的 <code className="mono">.md</code> 文件缺失或为空。请联系维护者补回。
        </p>
      ) : (
        <div
          className="commentary-body mt-3 space-y-3 text-[13.5px] leading-[1.85] text-ink-2"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </section>
  );
}