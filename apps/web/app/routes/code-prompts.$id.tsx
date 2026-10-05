// /code-prompts/:id — code-prompt template detail. Full bodyMd (frontmatter already stripped by the
// collector) and a flat frontmatter table. The original raw URL is the canonical source — visit that
// to see the file in its repo context.
import { SITE } from "@aihot/industry/site";
import { COPILOT_ASSET_KIND_LABELS, type CopilotAssetDetail } from "@aihot/contracts/awesome-copilot";
import { Link, useLoaderData } from "react-router";
import type { Route } from "./+types/code-prompts.$id";
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
  return loadOr404<CopilotAssetDetail>(
    `/api/site/awesome-copilot/${encodeURIComponent(params.id)}`,
    { signal: request.signal },
  );
}

export function meta({ loaderData }: Route.MetaArgs) {
  const data = loaderData as CopilotAssetDetail | undefined;
  if (!data) return pageMeta({ title: "代码提示词", path: "/code-prompts", noindex: true });
  const description = data.bodyPreview.slice(0, 200);
  return pageMeta({
    title: data.filename,
    description,
    path: `/code-prompts/${data.id}`,
    rawTitle: true,
    type: "article",
    jsonLd: [
      breadcrumbLd([
        { name: SITE.name, path: "/" },
        { name: "代码提示词", path: "/code-prompts" },
        { name: data.filename, path: `/code-prompts/${data.id}` },
      ]),
      {
        "@context": "https://schema.org",
        "@type": "CreativeWork",
        headline: data.filename,
        inLanguage: "zh",
        datePublished: data.fetchedAt,
        publisher: { "@type": "Organization", name: SITE.name },
        url: data.rawUrl,
        keywords: data.assetKind,
      },
    ],
  });
}

const STATUS_LABEL: Record<CopilotAssetDetail["status"], string> = {
  fetched: "已抓取",
  analyzing: "分析中",
  indexed: "已收录",
  failed: "抓取失败",
};

export default function CodePromptDetailPage() {
  const d = useLoaderData<typeof loader>();
  const [copied, setCopied] = useState(false);

  async function copyBody() {
    try {
      await navigator.clipboard.writeText(d.bodyMd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard blocked: ignore silently.
    }
  }

  const kindLabel = COPILOT_ASSET_KIND_LABELS[d.assetKind];
  const frontmatterEntries = Object.entries(d.frontmatter ?? {}).filter(([k]) => k !== "description");

  return (
    <ArticleLayout
      left={
        <>
          <AsideCard title="模板信息">
            <dl className="space-y-2 text-[12.5px] text-ink-3">
              <div className="flex justify-between gap-2">
                <dt className="text-ink-4">类型</dt>
                <dd>
                  <Link to={`/code-prompts?kind=${d.assetKind}`} className="text-accent hover:underline">
                    {kindLabel}
                  </Link>
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-ink-4">仓库</dt>
                <dd className="mono text-[11.5px]">{d.repoSlug}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-ink-4">默认分支</dt>
                <dd className="mono text-[11.5px]">{d.defaultBranch}</dd>
              </div>
              {d.sizeBytes != null && (
                <div className="flex justify-between gap-2">
                  <dt className="text-ink-4">文件大小</dt>
                  <dd className="mono text-[11.5px]">{formatBytes(d.sizeBytes)}</dd>
                </div>
              )}
              <div className="flex justify-between gap-2">
                <dt className="text-ink-4">抓取状态</dt>
                <dd>{STATUS_LABEL[d.status]}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-ink-4">收录时间</dt>
                <dd>
                  <time dateTime={d.fetchedAt}>
                    {beijingDate(d.fetchedAt)}
                    <span className="ml-1 mono text-[11.5px]">{beijingTime(d.fetchedAt)}</span>
                  </time>
                </dd>
              </div>
            </dl>
          </AsideCard>

          <AsideCard title="原文链接">
            <ul className="space-y-2 text-[12.5px]">
              <li>
                <a
                  href={d.rawUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-accent hover:underline"
                >
                  <IconExternal size={12} /> 原始文件
                </a>
              </li>
              <li>
                <Link to="/code-prompts" className="inline-flex items-center gap-1 text-ink-3 hover:text-accent">
                  返回模板列表
                </Link>
              </li>
            </ul>
          </AsideCard>
        </>
      }
    >
      <header className="mb-6">
        <Link
          to="/code-prompts"
          className="mb-3 inline-flex items-center gap-1 text-[12px] font-medium text-accent hover:underline"
        >
          <IconArrowLeft size={13} /> 返回模板列表
        </Link>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
          <Link
            to={`/code-prompts?kind=${d.assetKind}`}
            className="rounded bg-accent/10 px-1.5 py-px font-medium text-accent hover:underline"
          >
            {kindLabel}
          </Link>
          <span className="text-ink-4">
            路径 · <span className="mono text-[11.5px]">{d.slug}</span>
          </span>
        </div>
        <h1 className="mt-3 text-[22px] font-semibold leading-[1.45] text-ink">{d.filename}</h1>
      </header>

      {frontmatterEntries.length > 0 && (
        <section className="card scroll-mt-6 px-5 py-5 lg:px-7 lg:py-6">
          <h2 className="text-[14px] font-semibold text-ink">Frontmatter</h2>
          <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
            {frontmatterEntries.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-ink-4">{k}</dt>
                <dd className="mono break-all text-ink-2">{formatFrontmatterValue(v)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <section className={`card scroll-mt-6 px-5 py-5 lg:px-7 lg:py-6 ${frontmatterEntries.length > 0 ? "mt-4" : ""}`}>
        <div className="flex items-center justify-between">
          <h2 className="text-[14px] font-semibold text-ink">正文</h2>
          <button
            type="button"
            onClick={copyBody}
            className="inline-flex items-center gap-1 text-[12px] text-accent hover:underline"
          >
            <IconCopy size={12} /> {copied ? "已复制" : "复制全文"}
          </button>
        </div>
        <pre className="mt-3 max-h-[640px] overflow-auto whitespace-pre-wrap text-[13px] leading-[1.85] text-ink-2">
{d.bodyMd}
        </pre>
      </section>
    </ArticleLayout>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function formatFrontmatterValue(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(", ");
  return JSON.stringify(v);
}