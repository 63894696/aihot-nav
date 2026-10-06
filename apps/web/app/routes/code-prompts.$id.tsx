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
  // Description locale toggle (FIX-T, 2026-10-06). Defaults to "zh" when a zh translation
  // exists (so zh readers see Chinese first), otherwise "en". The body is never translated —
  // only title + frontmatter.description.
  const [locale, setLocale] = useState<"zh" | "en">(initialLocale(d));

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

      {hasDescription(d) && (
        <section className={`card scroll-mt-6 px-5 py-5 lg:px-7 lg:py-6 ${frontmatterEntries.length > 0 ? "mt-4" : ""}`}>
          <div className="flex items-center justify-between">
            <h2 className="text-[14px] font-semibold text-ink">简介</h2>
            <LocaleToggle current={locale} available={availableLocales(d)} onChange={setLocale} />
          </div>
          <p className="mt-3 whitespace-pre-wrap text-[13px] leading-[1.85] text-ink-2">
            {displayDescription(d, locale)}
          </p>
          {localeBadge(d, locale)}
        </section>
      )}

      <section className={`card scroll-mt-6 px-5 py-5 lg:px-7 lg:py-6 ${needsSpacing(d, frontmatterEntries.length) ? "mt-4" : ""}`}>
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

// FIX-T (2026-10-06) — translation helpers. The translation row is optional; we fall back to the
// English frontmatter.description when the active locale has no row, and the toggle UI is hidden
// when only one locale is present. Status "partial" / "failed" render a small badge so readers
// know the text is machine-generated or stale.

function enDescription(d: CopilotAssetDetail): string | null {
  const fm = d.frontmatter as Record<string, unknown> | null | undefined;
  const v = fm?.description;
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function hasDescription(d: CopilotAssetDetail): boolean {
  return enDescription(d) !== null || (d.translations?.zh?.description ?? null) !== null;
}

function availableLocales(d: CopilotAssetDetail): Array<"zh" | "en"> {
  const out: Array<"zh" | "en"> = [];
  if (enDescription(d) !== null) out.push("en");
  if (d.translations?.zh?.description != null) out.push("zh");
  return out;
}

function initialLocale(d: CopilotAssetDetail): "zh" | "en" {
  return d.translations?.zh?.description != null ? "zh" : "en";
}

function displayDescription(d: CopilotAssetDetail, locale: "zh" | "en"): string {
  if (locale === "zh") return d.translations?.zh?.description ?? enDescription(d) ?? "";
  return enDescription(d) ?? "";
}

function needsSpacing(d: CopilotAssetDetail, frontmatterCount: number): boolean {
  return frontmatterCount > 0 || hasDescription(d);
}

const LOCALE_LABEL: Record<"zh" | "en", string> = { zh: "中文", en: "EN" };

function LocaleToggle({ current, available, onChange }: { current: "zh" | "en"; available: Array<"zh" | "en">; onChange: (l: "zh" | "en") => void }) {
  if (available.length < 2) return null;
  return (
    <div className="inline-flex rounded border border-ink-4/40 text-[11.5px]">
      {available.map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => onChange(l)}
          className={`px-2 py-px transition-colors ${
            l === current ? "bg-accent text-white" : "text-ink-3 hover:text-accent"
          }`}
        >
          {LOCALE_LABEL[l]}
        </button>
      ))}
    </div>
  );
}

const TRANSLATION_STATUS_LABEL: Record<"translated" | "partial" | "failed", string> = {
  translated: "已翻译",
  partial: "部分翻译",
  failed: "翻译失败",
};

function localeBadge(d: CopilotAssetDetail, locale: "zh" | "en"): React.ReactNode {
  if (locale !== "zh") return null;
  const row = d.translations?.zh;
  if (!row) {
    return (
      <p className="mt-2 text-[11px] text-ink-4">暂无中文翻译,显示英文原文。</p>
    );
  }
  return (
    <p className="mt-2 text-[11px] text-ink-4">
      机器翻译 · {TRANSLATION_STATUS_LABEL[row.status]}
      {row.model ? ` · 模型 ${row.model}` : ""}
    </p>
  );
}