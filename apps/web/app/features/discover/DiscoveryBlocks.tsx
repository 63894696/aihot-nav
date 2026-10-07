// v0.2.1-#6 — three-block cross-axis discovery view surfaced on /all.
//
// One wire payload from /api/site/discover (DiscoverResponse) becomes a side-by-side teaser of
// each axis (tools / papers / prompts) with a "查看全部 →" link to the dedicated column. The
// filter chip above the grid is the existing CategoryTabs row; we do NOT add a second chip row
// here so the user only ever sees one filter UI on /all.
//
// Why a teaser and not the full column:
//   - /all is the navigation layer's home of the catch-all feed; surfacing each axis in full
//     would duplicate /tools, /papers, /prompts and break reader mental models.
//   - The teaser surfaces cross-axis links the column pages cannot: a writer browsing /all sees
//     "agents that came up this week" alongside the prompts that exercise them.
//
// Best-effort semantics: loadDiscover returns empty:true for any block whose loader threw. We
// render an inline "暂无" instead of an error so a single broken block does not blank the
// page. Each block renders independently; the layout collapses to a single column on phones.

import { Link } from "react-router";
import type { DiscoverBlock, DiscoverResponse, DiscoverTriple, FeedItemSummary, PaperSummary, PromptCard } from "@aihot/contracts/site";
import { CATEGORY_LABELS } from "@aihot/contracts/taxonomy";
import { beijingDate } from "@aihot/contracts/time";
import { IconExternal } from "../../components/icons";

type Props = { data: DiscoverResponse };

export function DiscoveryBlocks({ data }: Props) {
  // Hide the section entirely when no block has content AND no category/channel filter is active.
  // With no filter + empty all-three, the chip row already explains the empty /all list — repeating
  // "暂无" three times under it would feel like noise. A channel-only filter (e.g. "一手") still
  // earns a render because the section heading carries the channel label and a user navigating
  // to /all?channel=firstParty expects to see "一手 · 工具·提示词·论文 三栏速览" even when no items
  // qualify for the preview window yet (the underlying three column feeds are themselves
  // channel-filtered, so an empty teaser is informational, not an error).
  const allEmpty = data.tools.empty && data.papers.empty && data.prompts.empty;
  if (allEmpty && !data.category && !data.channelLabel) return null;

  // Section heading prefix: when the user lands via a channel filter (e.g. /all?channel=firstParty),
  // there is no category to prefix with — channelLabel carries "一手" instead. categoryLabel wins
  // when both are present so a /all?channel=firstParty&category=writing URL still reads "写作 · ..."
  // (the category is the narrower filter). Mirrors how CategoryTabs emits (search-bar +
// category) — the most specific axis the user typed wins.
  const headingPrefix = data.categoryLabel ?? data.channelLabel;
  const headerLabel = headingPrefix ? `${headingPrefix} · 工具·提示词·论文 三栏速览` : "工具·提示词·论文 三栏速览";
  return (
    <section aria-labelledby="discover-heading" className="mt-5 lg:mt-7">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 id="discover-heading" className="text-[14px] font-semibold tracking-tight text-ink-2 lg:text-[15px]">
          {headerLabel}
        </h2>
        <span className="text-[11.5px] text-ink-4">每栏 {data.tools.items.length || data.papers.items.length || data.prompts.items.length} / 6 · 直达分类页</span>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:gap-5">
        <ToolsBlock block={data.tools} />
        <PapersBlock block={data.papers} />
        <PromptsBlock block={data.prompts} />
      </div>

      {/* FIX-AA.4 — 三角联动 trial entry. Each card is a (paper, tool, prompt) triple that shares an
          arxiv_id via tool_papers + paper_prompts. The data is best-effort — loadDiscoverTriples
          returns [] on SQL throw and the join tables are empty today (worker job ships later), so
          TrialSection hides itself cleanly until a triple lands. Lesson 13c: each reverse-discovery
          surface independently tries/catches and renders-or-hides on empty. */}
      <TrialSection triples={data.triples ?? []} />
    </section>
  );
}

function BlockShell({ title, appliedCategory, fullPath, empty, count, children }: {
  title: string;
  appliedCategory: string | null;
  fullPath: string;
  empty: boolean;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <article className="card flex min-h-[180px] flex-col px-4 py-4 lg:px-5 lg:py-5">
      <header className="mb-2.5 flex items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h3 className="text-[13px] font-semibold text-ink">{title}</h3>
          {appliedCategory && (
            <span className="rounded bg-accent/10 px-1.5 py-px text-[11px] font-medium text-accent">{appliedCategory}</span>
          )}
          <span className="text-[11.5px] text-ink-4">{count} 条</span>
        </div>
        <Link to={fullPath} className="inline-flex items-center gap-1 text-[12px] font-medium text-ink-3 hover:text-accent">
          查看全部 <span aria-hidden="true">→</span>
        </Link>
      </header>
      {empty ? (
        <p className="my-auto py-6 text-center text-[12.5px] text-ink-4">暂无</p>
      ) : (
        <ul className="flex flex-col gap-3">{children}</ul>
      )}
    </article>
  );
}

function ToolsBlock({ block }: { block: DiscoverBlock<FeedItemSummary> }) {
  return (
    <BlockShell title="工具" appliedCategory={block.appliedCategory} fullPath={block.fullPath} empty={block.empty} count={block.items.length}>
      {block.items.map((it) => {
        const catLabel = it.category ? (CATEGORY_LABELS[it.category as keyof typeof CATEGORY_LABELS] ?? it.category) : null;
        return (
          <li key={it.id} className="border-l-2 border-line-soft pl-3">
            <Link to={`/tools/${encodeURIComponent(it.id)}`} prefetch="intent" className="block">
              <p className="line-clamp-2 text-[13px] font-medium leading-[1.5] text-ink hover:text-accent">{it.title}</p>
            </Link>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-ink-4">
              {catLabel && <span className="rounded bg-bg-sunk px-1.5 py-px text-[10.5px] text-ink-3">{catLabel}</span>}
              <time dateTime={it.publishedAt ?? it.timelineAt}>{beijingDate(it.publishedAt ?? it.timelineAt)}</time>
            </div>
          </li>
        );
      })}
    </BlockShell>
  );
}

function PapersBlock({ block }: { block: DiscoverBlock<PaperSummary> }) {
  return (
    <BlockShell title="论文" appliedCategory={block.appliedCategory} fullPath={block.fullPath} empty={block.empty} count={block.items.length}>
      {block.items.map((p) => (
        <li key={p.id} className="border-l-2 border-line-soft pl-3">
          <Link to={`/papers/${encodeURIComponent(p.id)}`} prefetch="intent" className="block">
            <p className="line-clamp-2 text-[13px] font-medium leading-[1.5] text-ink hover:text-accent">{p.titleZh ?? p.titleEn}</p>
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-ink-4">
            <span className="rounded bg-bg-sunk px-1.5 py-px font-mono text-[10.5px] text-ink-3">{p.primaryCategory}</span>
            {p.status === "translated" && <span className="text-accent">已翻译</span>}
            <time dateTime={p.publishedAt}>{beijingDate(p.publishedAt)}</time>
            <a href={p.absUrl} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-0.5 text-ink-4 hover:text-accent">
              arXiv <IconExternal size={11} />
            </a>
          </div>
        </li>
      ))}
    </BlockShell>
  );
}

const PROMPT_CATEGORY_LABEL: Record<string, string> = {
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

function PromptsBlock({ block }: { block: DiscoverBlock<PromptCard> }) {
  return (
    <BlockShell title="提示词" appliedCategory={block.appliedCategory} fullPath={block.fullPath} empty={block.empty} count={block.items.length}>
      {block.items.map((p) => {
        const catLabel = PROMPT_CATEGORY_LABEL[p.category] ?? p.category;
        return (
          <li key={p.id} className="border-l-2 border-line-soft pl-3">
            <Link to={`/prompts/${encodeURIComponent(p.id)}`} prefetch="intent" className="block">
              <p className="line-clamp-2 text-[13px] font-medium leading-[1.5] text-ink hover:text-accent">{p.useCase ?? "未命名用例"}</p>
            </Link>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-ink-4">
              <span className="rounded bg-accent/10 px-1.5 py-px text-[10.5px] font-medium text-accent">{catLabel}</span>
              <span>{p.community}</span>
              <time dateTime={p.capturedAt}>{beijingDate(p.capturedAt)}</time>
            </div>
          </li>
        );
      })}
    </BlockShell>
  );
}

/**
 * FIX-AA.4 — 交叉发现 · 三角联动 trial entry on /all.
 *
 * Three nodes (paper, tool, prompt) are bound by an arxiv_id through tool_papers + paper_prompts
 * join tables. Each card row carries three independent Links to the respective detail page; this
 * matches the FIX-AA.2 / FIX-AA.3 reverse-discovery surfaces (/tools/:id, /papers/:id, /prompts/:id)
 * so the cross-axis UI vocabulary stays uniform across the site.
 *
 * Render guard: if there are no triples (the join tables currently have zero rows until the
 * worker job populates them), this section hides itself. Lesson 13c — same convention as every
 * other reverse-discovery surface in the codebase. We do NOT show a placeholder "暂无" because
 * the absence of triple data is the default state today and a 4th "暂无" block under the three
   teaser columns would feel like noise.
 */
function TrialSection({ triples }: { triples: DiscoverTriple[] }) {
  if (triples.length === 0) return null;
  return (
    <div aria-labelledby="discover-triples-heading" className="mt-6 lg:mt-8">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 id="discover-triples-heading" className="text-[14px] font-semibold tracking-tight text-ink-2 lg:text-[15px]">
          交叉发现 · 三角联动
        </h3>
        <span className="text-[11.5px] text-ink-4">{triples.length} 条 · paper ↔ tool ↔ prompt</span>
      </div>
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {triples.map((t, i) => <TripleCard key={`${t.paper.id}-${t.tool.id}-${t.prompt.id}-${i}`} triple={t} />)}
      </ul>
    </div>
  );
}

/**
 * One row in the trial grid: paper (top) → tool (mid) → prompt (bottom). The visual hierarchy uses
 * a thin divider between rows so the reader can scan vertically; each row is a Link to the detail
 * page on the matching column. We do NOT render an image — the cards already feel information-dense
 * with the (paper title, tool title, prompt use-case) triple.
 */
function TripleCard({ triple }: { triple: DiscoverTriple }) {
  return (
    <li className="card flex flex-col gap-0 px-4 py-3.5 lg:px-5 lg:py-4">
      <Row icon="📄" label="paper" to={`/papers/${encodeURIComponent(triple.paper.id)}`} title={triple.paper.titleZh ?? triple.paper.titleEn} />
      <hr className="my-2 border-line-soft" />
      <Row icon="🛠️" label="tool" to={`/tools/${encodeURIComponent(triple.tool.id)}`} title={triple.tool.title} />
      <hr className="my-2 border-line-soft" />
      <Row icon="💬" label="prompt" to={`/prompts/${encodeURIComponent(triple.prompt.id)}`} title={triple.prompt.useCase ?? triple.prompt.promptPreview} />
    </li>
  );
}

/** One labelled link inside a TripleCard. Icon + axis tag stacked at the start so the visual rhythm
 *  matches across rows. The link prefetches on intent — the same pattern as ToolsBlock / PapersBlock
 *  above, so readers hovering a triple see the destination detail page already warm. */
function Row({ icon, label, to, title }: { icon: string; label: string; to: string; title: string }) {
  return (
    <div className="flex items-start gap-2">
      <span aria-hidden="true" className="text-[12px] leading-[1.4]">{icon}</span>
      <span className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-ink-4">{label}</span>
      <Link to={to} prefetch="intent" className="ml-auto flex-1 pl-2 text-right text-[13px] font-medium leading-[1.5] text-ink hover:text-accent">
        <span className="line-clamp-2">{title}</span>
      </Link>
    </div>
  );
}
