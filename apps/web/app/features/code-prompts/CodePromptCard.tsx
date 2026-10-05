// One card per awesome-copilot asset on /code-prompts. Header: kind chip + filename. Body shows
// frontmatter.description (the canonical "what does this do?" line) when present, falling back to
// bodyPreview when the asset has no description frontmatter. Footer: detail link + raw file URL +
// copy-link button.
//
// The detail page is where visitors copy the full file body — the card-level affordance is just
// "copy the raw URL" so the visitor can paste it into their workflow.

import { useState } from "react";
import { Link } from "react-router";
import { COPILOT_ASSET_KIND_LABELS, type CopilotAssetSummary } from "@aihot/contracts/awesome-copilot";
import { beijingDate } from "@aihot/contracts/time";
import { IconCopy, IconExternal } from "../../components/icons";

export function CodePromptCard({ asset }: { asset: CopilotAssetSummary }) {
  const [copied, setCopied] = useState(false);
  const kindLabel = COPILOT_ASSET_KIND_LABELS[asset.assetKind];

  // Frontmatter.description is the curated "what does this do?" line; bodyPreview is the markdown
  // body teaser. Show description when present — it stays short and stays on-topic.
  const description = typeof asset.frontmatter?.description === "string"
    ? asset.frontmatter.description.trim()
    : null;
  const teaser = description && description.length > 0 ? description : asset.bodyPreview.trim();

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(asset.rawUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard blocked: ignore silently — the row stays usable.
    }
  }

  return (
    <article className="card scroll-mt-6 px-5 py-5 lg:px-7 lg:py-6">
      <header className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px]">
        <Link
          to={`/code-prompts?kind=${asset.assetKind}`}
          className="rounded bg-accent/10 px-1.5 py-px font-medium text-accent hover:underline"
        >
          {kindLabel}
        </Link>
        <span className="mono text-ink-4">{asset.filename}</span>
        <span className="text-ink-4">·</span>
        <time dateTime={asset.fetchedAt} className="text-ink-4">{beijingDate(asset.fetchedAt)}</time>
      </header>

      <Link to={`/code-prompts/${encodeURIComponent(asset.id)}`} prefetch="intent" className="mt-2 block">
        <h2 className="text-[16px] font-semibold leading-[1.5] text-ink hover:text-accent">
          {asset.filename}
        </h2>
      </Link>

      {teaser && (
        <p className="mt-3 whitespace-pre-wrap text-[13.5px] leading-[1.85] text-ink-2">{teaser}</p>
      )}

      <footer className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line-soft pt-3.5 text-[12.5px]">
        <Link
          to={`/code-prompts/${encodeURIComponent(asset.id)}`}
          prefetch="intent"
          className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
        >
          详情
        </Link>
        <a
          href={asset.rawUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-ink-3 hover:text-accent"
        >
          <IconExternal size={14} /> 原始文件
        </a>
        <button
          type="button"
          onClick={copyLink}
          className="inline-flex items-center gap-1 text-ink-3 hover:text-accent"
          aria-label="复制原始链接"
        >
          <IconCopy size={14} /> {copied ? "已复制链接" : "复制链接"}
        </button>
      </footer>
    </article>
  );
}