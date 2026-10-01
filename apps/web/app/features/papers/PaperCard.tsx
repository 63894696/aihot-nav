// One card per arXiv paper on /papers (W4b plan §3.4). Default: abstract expanded, key_points
// collapsed (single click reveals 3-5 bullets). Header carries category + published date, the body
// carries Chinese title large + English title small gray + authors row + abstract + the key_points
// toggle + three outbound links (arXiv abstract page, PDF, copy arXiv ID).
import { useState } from "react";
import { Link } from "react-router";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { IconChevronDown, IconCopy, IconDoc, IconExternal } from "../../components/icons";

export interface PaperCardProps {
  paper: {
    id: string;
    titleEn: string;
    titleZh: string | null;
    abstractEn: string;
    abstractZh: string | null;
    authors: string[];
    primaryCategory: string;
    publishedAt: string;
    absUrl: string;
    status: "translated" | "partial" | "fetched" | "failed";
  };
}

const STATUS_LABEL: Record<PaperCardProps["paper"]["status"], { text: string; tone: string }> = {
  translated: { text: "已译", tone: "text-ok bg-ok/10" },
  partial: { text: "部分", tone: "text-amber bg-amber/10" },
  fetched: { text: "原文", tone: "text-ink-4 bg-bg-muted" },
  failed: { text: "缺译", tone: "text-ink-4 bg-bg-muted" },
};

export function PaperCard({ paper }: PaperCardProps) {
  const [keyPointsOpen, setKeyPointsOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const status = STATUS_LABEL[paper.status];
  const displayTitle = paper.titleZh ?? paper.titleEn;
  const secondaryTitle = paper.titleZh ? paper.titleEn : null;
  const abstract = paper.abstractZh ?? paper.abstractEn;
  const hasTranslation = !!paper.abstractZh;

  async function copyArxivId() {
    try {
      await navigator.clipboard.writeText(paper.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard blocked: ignore silently — the row stays usable.
    }
  }

  return (
    <article className="card scroll-mt-6 px-5 py-5 lg:px-7 lg:py-6">
      <header className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px]">
        <span className="rounded bg-accent/10 px-1.5 py-px font-medium text-accent">{paper.primaryCategory}</span>
        <span className="text-ink-4">
          <time dateTime={paper.publishedAt}>{beijingDate(paper.publishedAt)}</time>
          <span className="mx-1.5 text-ink-4/60">·</span>
          <time dateTime={paper.publishedAt} className="mono text-[11.5px]">{beijingTime(paper.publishedAt)}</time>
        </span>
        <span className={`rounded px-1.5 py-px text-[11px] ${status.tone}`}>{status.text}</span>
      </header>

      <Link to={`/papers/${paper.id}`} prefetch="intent" className="mt-2 block">
        <h2 className="text-[18px] font-semibold leading-[1.45] text-ink hover:text-accent">
          {displayTitle}
        </h2>
        {secondaryTitle && (
          <p className="mt-1 line-clamp-1 text-[12.5px] italic text-ink-4">{secondaryTitle}</p>
        )}
      </Link>

      <p className="mt-2 text-[12.5px] text-ink-3">
        {paper.authors.slice(0, 3).join(" · ")}
        {paper.authors.length > 3 ? ` · ${paper.authors.length - 3}+` : ""}
      </p>

      <p className={`mt-3 text-[13.5px] leading-[1.8] text-ink-2 ${hasTranslation ? "" : "italic text-ink-4"}`}>
        {abstract}
      </p>

      <button
        type="button"
        onClick={() => setKeyPointsOpen((v) => !v)}
        className="mt-3 inline-flex items-center gap-1 text-[12.5px] font-medium text-accent hover:underline"
        aria-expanded={keyPointsOpen}
      >
        <IconChevronDown
          size={13}
          className={`transition-transform duration-200 ${keyPointsOpen ? "rotate-0" : "-rotate-90"}`}
        />
        查看摘要要点(详情页可复制)
      </button>

      {keyPointsOpen && (
        <p className="mt-1.5 text-[12px] text-ink-4">进 <Link to={`/papers/${paper.id}`} className="text-accent hover:underline">详情页</Link> 查看 3-5 条要点并复制。</p>
      )}

      <footer className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line-soft pt-3.5 text-[12.5px]">
        <Link to={`/papers/${paper.id}`} prefetch="intent" className="inline-flex items-center gap-1 font-medium text-accent hover:underline">
          <IconDoc size={14} /> 详情
        </Link>
        <a href={paper.absUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-ink-3 hover:text-accent">
          <IconExternal size={14} /> arXiv 原文
        </a>
        <a
          href={paper.absUrl.replace("/abs/", "/pdf/")}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-ink-3 hover:text-accent"
        >
          <IconExternal size={14} /> PDF
        </a>
        <button
          type="button"
          onClick={copyArxivId}
          className="inline-flex items-center gap-1 text-ink-3 hover:text-accent"
          aria-label="复制 arXiv ID"
        >
          <IconCopy size={14} /> {copied ? "已复制" : paper.id}
        </button>
      </footer>
    </article>
  );
}
