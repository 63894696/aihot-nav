// Category chips + window filter for /papers. Mirrors the shape of the /tools filter row so the
// page feels consistent — both rows are a chip group on the left and a select on the right.
import { Link, useSearchParams } from "react-router";

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

export interface PaperFiltersProps {
  active: { category: string | null; windowDays: number };
}

export function PaperFilters({ active }: PaperFiltersProps) {
  const [params] = useSearchParams();
  const currentCategory = active.category;
  const currentWindow = active.windowDays;

  function withParams(overrides: Record<string, string | number | null>): string {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(overrides)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, String(v));
    }
    return `?${next.toString()}`;
  }

  return (
    <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex flex-wrap items-center gap-1.5">
        {CATEGORIES.map((c) => {
          const active = currentCategory === c.value;
          const to = c.value === null ? "/papers" : `/papers${withParams({ category: c.value })}`;
          return (
            <Link
              key={c.value ?? "all"}
              to={to}
              prefetch="intent"
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
  );
}
