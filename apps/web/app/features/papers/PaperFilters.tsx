// Category chips + window filter + search field + sort/limit row for /papers. The page feels
// consistent with /tools — chip group on the left, filter controls on the right. FIX-AA-A adds
// the search row at the bottom (借鉴 shelf.html "公榜海图" 海图式侧栏: form Enter 提交, 排序 +
// 每页切换, 不即时搜索). Search hits every change-relevant key in BIND_KEYS so changing q/sort/
// limit drops any stale cursor (FIX-Z.2/3 defense in depth applies unchanged).
import { Form, Link, useSearchParams } from "react-router";

const CATEGORIES = [
  { value: null, label: "全部" },
  { value: "cs.AI", label: "cs.AI" },
  { value: "cs.CL", label: "cs.CL" },
  { value: "cs.LG", label: "cs.LG" },
  { value: "cs.CV", label: "cs.CV" },
  { value: "cs.RO", label: "cs.RO" },
] as const;

const WINDOWS = [
  { value: 7, label: "7 天" },
  { value: 30, label: "30 天" },
  { value: 90, label: "90 天" },
] as const;

const SORTS = [
  { value: "published_at", label: "最新" },
  { value: "hf_upvotes", label: "HF 点赞" },
  { value: "translated", label: "中文摘要优先" },
] as const;

const LIMITS = [
  { value: 24, label: "24/页" },
  { value: 30, label: "30/页" },
  { value: 50, label: "50/页" },
  { value: 60, label: "60/页" },
] as const;

// FIX-Z.2 + FIX-AA-A: keys whose change invalidates the next-page cursor. Mirrors the bind
// fields in packages/backend/src/publication/papers.ts `binding(q)` (category, tag, q, sort,
// windowDays, limit). We expose category + windowDays as chips and q as a search input; sort
// + limit are selects (chip-less), but a reader who flips them still wants page 1 — so we
// drop the cursor on any of these changes. Tag is reserved even though no UI surfaces it
// today; the future-proofing costs nothing.
const BIND_KEYS: ReadonlySet<string> = new Set(["category", "windowDays", "q", "sort", "limit", "tag"]);

export interface PaperFiltersProps {
  active: {
    category: string | null;
    windowDays: number;
    q: string | null;
    sort: "published_at" | "hf_upvotes" | "translated";
    limit: number;
  };
  /**
   * FIX-Z.4 — called whenever the reader picks a chip. The route uses this to reset its
   * client-side load-more state synchronously so a chip click feels instant instead of
   * waiting for the React Router navigation + loader re-run. The chip Link still navigates
   * via `to=` so the URL stays shareable; onChange just lets the component tear down any
   * pending fetches before the new loader replaces them.
   */
  onChange?: (next: { category: string | null; windowDays: number; q: string | null; sort: PaperFiltersProps["active"]["sort"]; limit: number }) => void;
}

export function PaperFilters({ active, onChange }: PaperFiltersProps) {
  const [params] = useSearchParams();
  const currentCategory = active.category;
  const currentWindow = active.windowDays;
  const currentQ = active.q ?? "";
  const currentSort = active.sort;
  const currentLimit = active.limit;

  function withParams(overrides: Record<string, string | number | null>): string {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(overrides)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, String(v));
    }
    // FIX-Z.2 + FIX-AA-A: any BIND_KEY change drops the stale cursor (its b no longer matches
    // the new query). The chip-click path uses BIND_KEYS={category, windowDays}; the search
    // input contributes q; the sort + limit selects contribute their own keys. Same defense.
    if (Object.keys(overrides).some((k) => BIND_KEYS.has(k))) next.delete("cursor");
    return `?${next.toString()}`;
  }

  return (
    <div className="mb-5 flex flex-col gap-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-1.5">
          {CATEGORIES.map((c) => {
            const active = currentCategory === c.value;
            const to = c.value === null ? "/papers" : `/papers${withParams({ category: c.value })}`;
            return (
              <Link
                key={c.value ?? "all"}
                to={to}
                prefetch="intent"
                onClick={() => onChange?.({ category: c.value, windowDays: currentWindow, q: currentQ, sort: currentSort, limit: currentLimit })}
                className={`rounded-full px-3 py-1 text-[12.5px] transition-colors ${
                  active ? "bg-ink text-bg" : "bg-bg-muted text-ink-3 hover:bg-bg-sunk"
                }`}
              >
                {c.label}
              </Link>
            );
          })}
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-[12px] text-ink-4">时间窗</span>
          {WINDOWS.map((w) => {
            const active = currentWindow === w.value;
            const to = w.value === 30 ? "/papers" : `/papers${withParams({ windowDays: w.value })}`;
            return (
              <Link
                key={w.value}
                to={to}
                prefetch="intent"
                onClick={() => onChange?.({ category: currentCategory, windowDays: w.value, q: currentQ, sort: currentSort, limit: currentLimit })}
                className={`rounded-full px-3 py-1 text-[12.5px] transition-colors ${
                  active ? "bg-ink text-bg" : "bg-bg-muted text-ink-3 hover:bg-bg-sunk"
                }`}
              >
                {w.label}
              </Link>
            );
          })}
        </div>
      </div>

      {/* FIX-AA-A — search row (借鉴 shelf.html "公榜海图" 表单式 Enter 提交).
         GET /papers?q=...  — 提交后 React Router 重新执行 loader, items 重置到 page 1 of the
         new query. Empty submit 走 /papers(无 q); input value 仍保留在 URL 之外,避免点击 X
         按钮还残留空 q 的语义。*/}
      <Form
        action="/papers"
        method="get"
        className="flex flex-col gap-2 sm:flex-row sm:items-center"
      >
        {/* Preserve filter state across submits: the reader picks a chip then types a query,
            the URL needs both. Hidden inputs mirror every BIND_KEY field that isn't the search
            input itself. */}
        {currentCategory && <input type="hidden" name="category" value={currentCategory} />}
        <input type="hidden" name="windowDays" value={currentWindow} />
        {currentSort !== "published_at" && <input type="hidden" name="sort" value={currentSort} />}
        {currentLimit !== 24 && <input type="hidden" name="limit" value={currentLimit} />}
        <input
          type="search"
          name="q"
          defaultValue={currentQ}
          placeholder="搜索标题/作者/摘要关键词"
          aria-label="搜索论文"
          className="min-w-0 flex-1 rounded-md border border-line bg-bg px-3 py-1.5 text-[13px] text-ink placeholder:text-ink-4 focus:border-accent focus:outline-none"
        />
        <button
          type="submit"
          className="rounded-md bg-ink px-4 py-1.5 text-[13px] font-medium text-bg transition-colors hover:bg-ink-2"
        >
          搜索
        </button>
        {currentQ && (
          <Link
            to="/papers"
            prefetch="intent"
            onClick={() => onChange?.({ category: currentCategory, windowDays: currentWindow, q: null, sort: currentSort, limit: currentLimit })}
            className="text-[12px] text-ink-4 hover:text-ink-3"
          >
            清除
          </Link>
        )}
      </Form>

      {/* FIX-AA-A — sort + limit row. <Link> on each so the URL stays shareable (the form-submit
          alternative would lose the search query). Like the chips, these participate in
          BIND_KEYS — flipping either one drops the cursor. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-ink-4">
        <div className="flex items-center gap-1.5">
          <span>排序</span>
          {SORTS.map((s) => {
            const active = currentSort === s.value;
            const to = s.value === "published_at" ? `/papers${withParams({ sort: null })}` : `/papers${withParams({ sort: s.value })}`;
            return (
              <Link
                key={s.value}
                to={to}
                prefetch="intent"
                onClick={() => onChange?.({ category: currentCategory, windowDays: currentWindow, q: currentQ, sort: s.value, limit: currentLimit })}
                className={`rounded-full px-2.5 py-0.5 text-[12px] transition-colors ${
                  active ? "bg-ink/10 text-ink" : "text-ink-4 hover:text-ink-3"
                }`}
              >
                {s.label}
              </Link>
            );
          })}
        </div>
        <div className="flex items-center gap-1.5">
          <span>每页</span>
          {LIMITS.map((l) => {
            const active = currentLimit === l.value;
            const to = l.value === 24 ? `/papers${withParams({ limit: null })}` : `/papers${withParams({ limit: l.value })}`;
            return (
              <Link
                key={l.value}
                to={to}
                prefetch="intent"
                onClick={() => onChange?.({ category: currentCategory, windowDays: currentWindow, q: currentQ, sort: currentSort, limit: l.value })}
                className={`rounded-full px-2.5 py-0.5 text-[12px] transition-colors ${
                  active ? "bg-ink/10 text-ink" : "text-ink-4 hover:text-ink-3"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
