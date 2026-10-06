// One card per prompt on /prompts (W5-3-F4). Header carries category + community + captured date;
// body shows the promptPreview text + a copy button (clipboard, no model call) + outbound link.
// Comment thread is intentionally NOT on the card — visitors open the detail page to see the
// original-page comments + full promptText.

import { useState } from "react";
import { Link } from "react-router";
import { beijingDate } from "@aihot/contracts/time";
import { IconCopy, IconExternal } from "../../components/icons";

export type PromptCardData = {
  id: string;
  category: string;
  useCase: string | null;
  promptPreview: string;
  language: string;
  community: string;
  sourceKind: string;
  originalUrl: string;
  capturedAt: string;
};

// Map is intentionally narrow: the publication layer's readPromptMeta gate only lets through
// PromptCategory keys (PROMPT_CATEGORIES in @aihot/contracts/site). Anything outside this set
// would have been dropped at /api/site/prompts, so the wire never carries "painting" / "design"
// — the v0.2.0 → v0.2.1 migration 0043 collapsed those into "image" at the DB layer.
const CATEGORY_LABEL: Record<string, string> = {
  writing: "写作",
  coding: "编程",
  image: "图像",
  video: "视频",
  audio: "音频",
  agent: "智能体",
  data: "数据",
  research: "研究",
  study: "学习",
  other: "其它",
};

const SOURCE_KIND_LABEL: Record<string, string> = {
  manual: "手工收录",
  searxng_search: "搜索补漏",
  rss: "RSS 收录",
  external: "外部收录",
};

export function PromptCard({ prompt }: { prompt: PromptCardData }) {
  const [copied, setCopied] = useState(false);

  async function copyPreview() {
    try {
      await navigator.clipboard.writeText(prompt.promptPreview);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard blocked: ignore silently — the row stays usable.
    }
  }

  const catLabel = CATEGORY_LABEL[prompt.category] ?? prompt.category;
  const sourceLabel = SOURCE_KIND_LABEL[prompt.sourceKind] ?? prompt.sourceKind;

  return (
    <article className="card scroll-mt-6 px-5 py-5 lg:px-7 lg:py-6">
      <header className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px]">
        <Link
          to={`/prompts?category=${encodeURIComponent(prompt.category)}`}
          className="rounded bg-accent/10 px-1.5 py-px font-medium text-accent hover:underline"
        >
          {catLabel}
        </Link>
        <span className="text-ink-4">{prompt.community}</span>
        <span className="text-ink-4">·</span>
        <span className="text-ink-4">{sourceLabel}</span>
        <span className="text-ink-4">·</span>
        <time dateTime={prompt.capturedAt} className="text-ink-4">{beijingDate(prompt.capturedAt)}</time>
      </header>

      <Link to={`/prompts/${prompt.id}`} prefetch="intent" className="mt-2 block">
        {prompt.useCase ? (
          <h2 className="text-[16px] font-semibold leading-[1.5] text-ink hover:text-accent">{prompt.useCase}</h2>
        ) : (
          <h2 className="text-[16px] font-semibold leading-[1.5] text-ink hover:text-accent">未命名用例</h2>
        )}
      </Link>

      <p className="mt-3 whitespace-pre-wrap text-[13.5px] leading-[1.85] text-ink-2">
        {prompt.promptPreview}
      </p>

      <footer className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line-soft pt-3.5 text-[12.5px]">
        <Link to={`/prompts/${prompt.id}`} prefetch="intent" className="inline-flex items-center gap-1 font-medium text-accent hover:underline">
          详情
        </Link>
        <a href={prompt.originalUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-ink-3 hover:text-accent">
          <IconExternal size={14} /> 原帖
        </a>
        <button
          type="button"
          onClick={copyPreview}
          className="inline-flex items-center gap-1 text-ink-3 hover:text-accent"
          aria-label="复制预览"
        >
          <IconCopy size={14} /> {copied ? "已复制预览" : "复制预览"}
        </button>
      </footer>
    </article>
  );
}