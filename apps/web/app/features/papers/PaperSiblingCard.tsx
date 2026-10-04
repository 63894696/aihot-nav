// Lightweight card for the paper-detail "相关论文" section (W5-3 v0.2.1-#4).
//
// The full /papers PaperCard has an expandable abstract, key_points, copy-arXiv-id buttons — too
// much chrome for a row of 3-6 mini links at the bottom of another paper. This card carries
// only what a reader needs to decide whether to click: primary_category chip, Chinese title,
// date, and the link. Three lines max; the card is the row, not a wall.
//
// Same status pill shape as PaperCard so a reader visually recognises "已译 / 部分 / 原文" —
// the meaning is identical, only the layout density changes.
import { Link } from "react-router";
import { beijingDate } from "@aihot/contracts/time";
import { IconArrowRight } from "../../components/icons";

export interface PaperSiblingCardProps {
  paper: {
    id: string;
    titleZh: string | null;
    titleEn: string;
    primaryCategory: string;
    publishedAt: string;
    status: "translated" | "partial" | "translating" | "failed" | "fetched";
  };
}

const STATUS_TONE: Record<PaperSiblingCardProps["paper"]["status"], string> = {
  translated: "text-ok bg-ok/10",
  partial: "text-amber bg-amber/10",
  translating: "text-ink-4 bg-bg-muted",
  failed: "text-ink-4 bg-bg-muted",
  fetched: "text-ink-4 bg-bg-muted",
};

export function PaperSiblingCard({ paper }: PaperSiblingCardProps) {
  const displayTitle = paper.titleZh ?? paper.titleEn;
  return (
    <Link
      to={`/papers/${encodeURIComponent(paper.id)}`}
      prefetch="intent"
      className="card flex h-full flex-col gap-2 px-4 py-3.5 transition hover:border-accent/40 hover:shadow-sm"
    >
      <div className="flex items-center gap-1.5 text-[11px]">
        <span className="rounded bg-accent/10 px-1.5 py-px font-medium text-accent">{paper.primaryCategory}</span>
        <span className={`rounded px-1.5 py-px ${STATUS_TONE[paper.status]}`}>
          {paper.status === "translated" ? "已译" : paper.status === "partial" ? "部分" : paper.status === "translating" ? "翻译中" : paper.status === "failed" ? "缺译" : "原文"}
        </span>
        <span className="ml-auto text-ink-4">
          <time dateTime={paper.publishedAt}>{beijingDate(paper.publishedAt)}</time>
        </span>
      </div>
      <p className="line-clamp-2 text-[13px] font-medium leading-snug text-ink">{displayTitle}</p>
      <span className="mt-auto inline-flex items-center gap-1 text-[11.5px] text-ink-4 transition group-hover:text-accent">
        <IconArrowRight size={11} className="text-ink-4" />
        <span className="mono">{paper.id}</span>
      </span>
    </Link>
  );
}
